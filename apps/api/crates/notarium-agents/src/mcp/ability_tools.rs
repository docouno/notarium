use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, PrincipalKind},
    classes::{
        AbilityKind, ClassEgressFence, ClassifiedAbilityResource, DocClass, ProviderAudience,
        ProviderOrigin,
    },
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
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use super::{
    EgressTarget, ToolCallContext, ToolName, ToolRegistry, corpus, decode, invalid, session,
};
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
const MAX_PROVIDER_ABILITY_SCAN_PAGES: usize = 64;
const PROVIDER_ABILITY_SCAN_PAGE_SIZE: u16 = 100;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum AbilitySortKey {
    Owned { space: String, id: String },
    System { rank: usize },
}

fn ability_sort_key(descriptor: &AbilityDescriptor) -> Result<AbilitySortKey, PortError> {
    match (&descriptor.reference.placement, &descriptor.entrypoint) {
        (AbilityPlacement::System, _) => {
            let rank = crate::abilities::system_ability_rank(&descriptor.reference.id)
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            Ok(AbilitySortKey::System { rank })
        }
        (_, Some(entry)) => Ok(AbilitySortKey::Owned {
            space: entry.space_id.as_str().to_owned(),
            id: descriptor.reference.id.as_str().to_owned(),
        }),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}

#[derive(Clone)]
enum AbilityCursorInner {
    Control(String),
    ProviderAfter {
        key: AbilitySortKey,
        control_cursor: Option<String>,
    },
}

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
    inner: AbilityCursorInner,
}

impl AbilityCursors {
    fn insert(
        &self,
        principal: PrincipalId,
        scope: ContentDigest,
        inner: AbilityCursorInner,
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
    ) -> Result<AbilityCursorInner, PortError> {
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

fn role_placement_matches_project(
    placement: &AbilityPlacement,
    project: Option<&FolderRef>,
) -> bool {
    match placement {
        AbilityPlacement::OwnedProject(role_project) => project == Some(role_project),
        AbilityPlacement::OwnedSpace(role_space) => {
            project.is_none_or(|active| &active.space_id == role_space)
        }
        AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => true,
    }
}

async fn provider_skill_spaces(
    call: &ToolCallContext<'_>,
    project: Option<&FolderRef>,
) -> Result<(BTreeSet<SpaceId>, bool), PortError> {
    let mut allowed = BTreeSet::new();
    let mut any_project_only = false;
    for (space_id, grant) in call.auth.spaces() {
        if !grant.read_classes.contains(&DocClass::Skill) {
            continue;
        }
        if let Some(active) = project
            && space_id != &active.space_id
        {
            let live = match call
                .registry
                .catalog
                .space(call.budget(), space_id.clone())
                .await
            {
                Ok(live) => live,
                Err(error) if visible_error(&error) => continue,
                Err(error) => return Err(error),
            };
            if live.space.kind != notarium_core::auth::SpaceKind::Personal {
                continue;
            }
        }
        let probe_project = project.filter(|p| &p.space_id == space_id).cloned();
        if let Some(selection) = corpus::skill_selection(call, space_id, probe_project).await? {
            any_project_only |= selection.project_only.is_some();
            allowed.insert(space_id.clone());
        }
    }
    Ok((allowed, any_project_only))
}

async fn provider_runtime_winners(
    call: &ToolCallContext<'_>,
    discover_account: &AccountContext,
    query_project: &Option<FolderRef>,
    project: Option<&FolderRef>,
    name: &str,
) -> Result<Vec<AbilityRef>, PortError> {
    let page = call
        .registry
        .control
        .discover_abilities(
            discover_account.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(200, None)?,
                project: query_project.clone(),
                kind: None,
                name: Some(name.to_owned()),
                authoring: true,
            },
        )
        .await?;
    if page.continuation.is_some() {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut winners: Vec<AbilityDescriptor> = Vec::new();
    let mut best_prec: Option<u8> = None;
    for inspection in page.items {
        let descriptor = inspection.descriptor;
        let reference = &descriptor.reference;
        if !role_placement_matches_project(&reference.placement, project) {
            continue;
        }
        if !provider_placement_visible(call, &descriptor, project).await? {
            continue;
        }
        let prec = reference.placement.precedence();
        match best_prec {
            Some(best) if prec > best => continue,
            Some(best) if prec == best => {
                if winners
                    .iter()
                    .all(|existing| existing.reference.identity() != reference.identity())
                {
                    winners.push(descriptor);
                }
            }
            _ => {
                best_prec = Some(prec);
                winners.clear();
                winners.push(descriptor);
            }
        }
    }
    Ok(winners
        .into_iter()
        .filter(|w| w.enabled && w.healthy)
        .map(|w| w.reference)
        .collect())
}

async fn provider_placement_visible(
    call: &ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    project: Option<&FolderRef>,
) -> Result<bool, PortError> {
    let EgressTarget::InAppProvider {
        primary_project, ..
    } = &call.target
    else {
        return Ok(true);
    };
    let reference = &descriptor.reference;
    if reference.placement == AbilityPlacement::System {
        let Some(space) = call.auth.pinned_write_space() else {
            return Ok(false);
        };
        return corpus::space_admits_skill(call, space, primary_project.clone()).await;
    }
    let Some(entry) = &descriptor.entrypoint else {
        return Ok(false);
    };
    let scope = match session::space(call, &entry.space_id).await {
        Ok(scope) => scope,
        Err(error) if visible_error(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    let req_project = requested_project(call, reference, &entry.space_id, project);
    let selection = match call.provider_selection(&scope, req_project).await {
        Ok(selection) => selection,
        Err(error) if visible_error(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some(sel) = selection else {
        return Ok(true);
    };
    if !sel.policy.allowed_classes.contains(&DocClass::Skill) {
        return Ok(false);
    }
    if let Some(required) = &sel.project_only
        && (!reference.placement.in_project(required)
            || descriptor
                .promoted_from
                .as_ref()
                .is_some_and(|prev| !prev.placement.in_project(required)))
    {
        return Ok(false);
    }
    Ok(true)
}

async fn raw_reference_for_call(
    call: &ToolCallContext<'_>,
    id: AbilityId,
    project: Option<&FolderRef>,
    allow_unpinned_projects: bool,
) -> Result<Option<AbilityRef>, PortError> {
    let account = call.account();
    if matches!(call.target, EgressTarget::ExternalMcp) {
        return raw_reference_for_account(call.registry, &account, id).await;
    }
    let (allowed, _) = provider_skill_spaces(call, project).await?;
    let discover_account =
        AccountContext::new(call.auth.restrict_to_spaces(&allowed), call.budget());
    let mut candidates = call
        .registry
        .catalog
        .locate_ability(discover_account, id.clone())
        .await?;
    if allow_unpinned_projects && project.is_none() {
        for (space_id, grant) in call.auth.spaces() {
            if allowed.contains(space_id) || !grant.read_classes.contains(&DocClass::Skill) {
                continue;
            }
            let scoped = AccountContext::new(call.auth.restrict_to_space(space_id)?, call.budget());
            for candidate in call
                .registry
                .catalog
                .locate_ability(scoped, id.clone())
                .await?
            {
                if matches!(
                    candidate.reference.placement,
                    AbilityPlacement::OwnedProject(_)
                ) {
                    candidates.push(candidate);
                }
            }
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut visible: Option<AbilityRef> = None;
    for candidate in candidates {
        let inspection = match call
            .registry
            .control
            .inspect_ability(account.clone(), candidate.reference.identity())
            .await
        {
            Ok(inspection) => inspection,
            Err(error) if visible_error(&error) => continue,
            Err(error) => return Err(error),
        };
        if !provider_ability_allowed(call, &inspection, project) {
            continue;
        }
        match read_body_inner(call, &inspection.descriptor, project, false).await {
            Ok(_) => {
                if let Some(existing) = &visible
                    && existing.identity() == inspection.descriptor.reference.identity()
                {
                    continue;
                }
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

async fn resolve_selector_for_call(
    call: &ToolCallContext<'_>,
    selector: &str,
    kind: AbilityKind,
    project: Option<FolderRef>,
) -> Result<AbilityResolution, PortError> {
    let account = call.account();
    if matches!(call.target, EgressTarget::ExternalMcp) {
        return resolve_selector_for_account(call.registry, &account, selector, kind, project)
            .await;
    }
    if selector.starts_with("ar1:") {
        let reference = parse_token(selector, "ar1:", MAX_TOKEN_BYTES)?;
        return call
            .registry
            .control
            .resolve_ability(account, AbilitySelection::Exact { reference, project })
            .await;
    }
    if let Ok(id) = AbilityId::parse_v1(selector)
        && let Some(reference) = raw_reference_for_call(call, id, project.as_ref(), false).await?
    {
        return call
            .registry
            .control
            .resolve_ability(account, AbilitySelection::Exact { reference, project })
            .await;
    }
    // Resolve name selectors strictly over provider-visible Spaces/placements so
    // unconsented Spaces cannot shadow consented Personal/Space abilities or
    // trigger cross-space ambiguity oracles.
    let (allowed, _) = provider_skill_spaces(call, project.as_ref()).await?;
    let discover_account =
        AccountContext::new(call.auth.restrict_to_spaces(&allowed), call.budget());
    let query_project = project
        .as_ref()
        .filter(|p| allowed.contains(&p.space_id))
        .cloned();
    let name = notarium_syntax::unicode::lookup_key(selector);
    let page = call
        .registry
        .control
        .discover_abilities(
            discover_account.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(200, None)?,
                project: query_project.clone(),
                kind: None,
                name: Some(name),
                authoring: true,
            },
        )
        .await?;
    if page.continuation.is_some() {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut winners: Vec<AbilityRef> = Vec::new();
    let mut best_prec: Option<u8> = None;
    for inspection in page.items {
        let reference = &inspection.descriptor.reference;
        if !role_placement_matches_project(&reference.placement, project.as_ref()) {
            continue;
        }
        if !provider_placement_visible(call, &inspection.descriptor, project.as_ref()).await? {
            continue;
        }
        let prec = reference.placement.precedence();
        match best_prec {
            Some(best) if prec > best => continue,
            Some(best) if prec == best => {
                if winners
                    .iter()
                    .all(|existing| existing.identity() != reference.identity())
                {
                    winners.push(reference.clone());
                }
            }
            _ => {
                best_prec = Some(prec);
                winners.clear();
                winners.push(reference.clone());
            }
        }
    }
    let by_name = match winners.len() {
        0 => AbilityResolution::Missing,
        1 => {
            let reference = winners.pop().expect("single winner");
            let exact = call
                .registry
                .control
                .resolve_ability(
                    discover_account,
                    AbilitySelection::Exact {
                        reference,
                        project: query_project,
                    },
                )
                .await?;
            match exact {
                AbilityResolution::Resolved(value) if value.kind != kind => {
                    AbilityResolution::WrongKind
                }
                other => other,
            }
        }
        _ => return Err(invalid(ValidationReason::InvalidState)),
    };
    if !matches!(by_name, AbilityResolution::Missing) {
        return Ok(by_name);
    }
    if let Ok(id) = AbilityId::parse(selector)
        && let Some(reference) = raw_reference_for_call(call, id, project.as_ref(), false).await?
    {
        return call
            .registry
            .control
            .resolve_ability(account, AbilitySelection::Exact { reference, project })
            .await;
    }
    Ok(by_name)
}

async fn inspect_with_project(
    call: &ToolCallContext<'_>,
    text: &str,
    project: Option<&FolderRef>,
) -> Result<AbilityInspection, PortError> {
    let reference: AbilityRef = if text.starts_with("ar1:") {
        parse_token(text, "ar1:", MAX_TOKEN_BYTES)?
    } else {
        raw_reference_for_call(call, AbilityId::parse(text)?, project, true)
            .await?
            .ok_or(DomainError::ResourceNotFound)?
    };
    call.registry
        .control
        .inspect_ability(call.account(), reference.identity())
        .await
}

async fn inspect(call: &ToolCallContext<'_>, text: &str) -> Result<AbilityInspection, PortError> {
    inspect_with_project(call, text, None).await
}

#[derive(Clone, Debug)]
struct AbilityBody {
    description: String,
    instructions: String,
    attachments: Vec<AuthoredAttachment>,
    origin: ProviderOrigin,
    project: Option<FolderRef>,
    deferred_taint: Option<AbilityTaintCommit>,
}

#[derive(Clone, Debug)]
enum AbilityTaintCommit {
    Resource {
        scope: SpaceContext,
        resource: Box<ClassifiedAbilityResource>,
        selection: Option<Box<ProviderSelection>>,
    },
    ForeignProject {
        scope: SpaceContext,
    },
    ForeignBranch {
        taint: notarium_core::auth::BranchTaint,
    },
}

fn placement_is_foreign(
    call: &ToolCallContext<'_>,
    placement: &AbilityPlacement,
    entrypoint: Option<&notarium_core::model::NoteRef>,
) -> bool {
    let Some(pin) = call.auth.pinned_write_space() else {
        return false;
    };
    if let Some(entry) = entrypoint {
        return &entry.space_id != pin;
    }
    match placement {
        AbilityPlacement::System => false,
        AbilityPlacement::OwnedPersonal(_) => {
            call.auth.chat_audience() == Some(ChatAudience::Shared)
        }
        AbilityPlacement::OwnedSpace(space) => space != pin,
        AbilityPlacement::OwnedProject(folder) => &folder.space_id != pin,
    }
}

fn commit_deferred_taints_on_error(call: &ToolCallContext<'_>, taints: &[AbilityTaintCommit]) {
    if taints.iter().any(AbilityTaintCommit::would_taint_branch) {
        call.commit_external_read();
    }
}

impl AbilityTaintCommit {
    fn would_taint_branch(&self) -> bool {
        match self {
            Self::Resource { scope, .. } | Self::ForeignProject { scope } => scope
                .auth()
                .pinned_write_space()
                .is_some_and(|pin| pin != &scope.scope().space_id),
            Self::ForeignBranch { .. } => true,
        }
    }

    fn commit(self) -> Result<(), PortError> {
        match self {
            Self::Resource {
                scope,
                resource,
                selection: Some(selection),
            } => {
                ClassEgressFence::ability(*resource, scope.auth(), &selection.policy)?;
            }
            Self::Resource {
                scope,
                resource,
                selection: None,
            } => {
                ClassEgressFence::mcp_ability(&resource, scope.auth())?;
            }
            Self::ForeignProject { scope } => {
                if scope
                    .auth()
                    .pinned_write_space()
                    .is_some_and(|pin| pin != &scope.scope().space_id)
                {
                    scope.auth().taint().mark_external_read();
                }
            }
            Self::ForeignBranch { taint } => {
                taint.mark_external_read();
            }
        }
        Ok(())
    }
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

async fn read_body_inner(
    call: &ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    hint: Option<&FolderRef>,
    commit_taint: bool,
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
            deferred_taint: None,
        });
    }
    let body = read_owned_resource_inner(
        call,
        descriptor,
        hint,
        AbilityResourceName::Entrypoint,
        commit_taint,
    )
    .await?;
    let (description, instructions, attachments) = parse_body(&body.text)?;
    Ok(AbilityBody {
        description,
        instructions,
        attachments,
        origin: body.origin,
        project: body.project,
        deferred_taint: body.deferred_taint,
    })
}

struct ResourceBody {
    text: String,
    origin: ProviderOrigin,
    project: Option<FolderRef>,
    deferred_taint: Option<AbilityTaintCommit>,
}

async fn read_owned_resource_inner(
    call: &ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    hint: Option<&FolderRef>,
    resource: AbilityResourceName,
    commit_taint: bool,
) -> Result<ResourceBody, PortError> {
    let reference = &descriptor.reference;
    let entry = descriptor
        .entrypoint
        .as_ref()
        .ok_or(DomainError::ResourceNotFound)?;
    let scope = session::space(call, &entry.space_id).await?;
    let project = requested_project(call, reference, &entry.space_id, hint);
    let selection = call.provider_selection(&scope, project.clone()).await?;
    if let Some(sel) = &selection {
        if !sel.policy.allowed_classes.contains(&DocClass::Skill) {
            return Err(DomainError::validation(ValidationReason::ClassEgressForbidden).into());
        }
        if let Some(required) = &sel.project_only
            && (!reference.placement.in_project(required)
                || descriptor
                    .promoted_from
                    .as_ref()
                    .is_some_and(|prev| !prev.placement.in_project(required)))
        {
            return Err(DomainError::AccessDenied.into());
        }
    }
    let body = read_exact_resource(
        call.registry,
        &scope.with_preflight_taint(),
        descriptor,
        resource,
    )
    .await?;
    let origin = body.origin();
    let confined_project = selection.as_ref().and_then(|sel| sel.project_only.clone());
    if let Some(sel) = &selection
        && sel
            .project_only
            .as_ref()
            .is_some_and(|project| !body.in_project(project))
    {
        return Err(DomainError::AccessDenied.into());
    }
    let fence_auth = if commit_taint {
        scope.auth().clone()
    } else {
        scope.auth().with_preflight_taint()
    };
    let (text, deferred_taint) = match selection {
        Some(selection) => {
            if commit_taint {
                let admitted = ClassEgressFence::ability(body, &fence_auth, &selection.policy)?;
                (admitted.text().to_owned(), None)
            } else {
                let admitted =
                    ClassEgressFence::ability(body.clone(), &fence_auth, &selection.policy)?;
                (
                    admitted.text().to_owned(),
                    Some(AbilityTaintCommit::Resource {
                        scope,
                        resource: Box::new(body),
                        selection: Some(Box::new(selection)),
                    }),
                )
            }
        }
        None => {
            let text = ClassEgressFence::mcp_ability(&body, &fence_auth)?.to_owned();
            let deferred = (!commit_taint).then_some(AbilityTaintCommit::Resource {
                scope,
                resource: Box::new(body),
                selection: None,
            });
            (text, deferred)
        }
    };
    Ok(ResourceBody {
        text,
        origin,
        project: confined_project,
        deferred_taint,
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
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let query = args.q.as_deref().map(notarium_syntax::unicode::lookup_key);
    let mut items = Vec::new();
    let mut deferred_taints = Vec::new();
    let mut origin_records = Vec::new();
    let next_inner = if external {
        let control_cursor = match inner {
            Some(AbilityCursorInner::Control(token)) => Some(token),
            Some(AbilityCursorInner::ProviderAfter { .. }) => {
                return Err(invalid(ValidationReason::CursorStale));
            }
            None => None,
        };
        let page = call
            .registry
            .control
            .discover_abilities(
                call.account(),
                AbilityQuery {
                    page: ControlPageRequest::new(limit, control_cursor)?,
                    project: project.clone(),
                    kind: args.kind.map(Into::into),
                    name: None,
                    authoring: view == View::Authoring,
                },
            )
            .await?;
        for inspection in page.items {
            let descriptor = &inspection.descriptor;
            if args
                .source
                .is_some_and(|expected| source(&descriptor.reference) != expected)
            {
                continue;
            }
            let (description, origin_record, deferred_taint) = if let Some(desc) =
                descriptor.description.as_ref()
            {
                (desc.clone(), None, None)
            } else {
                let body = match read_body_inner(call, descriptor, project.as_ref(), false).await {
                    Ok(body) => body,
                    Err(error) if visible_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                (
                    body.description,
                    Some((body.origin, body.project)),
                    body.deferred_taint,
                )
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
            items.push(summary(&inspection, &description, enabled, true)?);
            if let Some(record) = origin_record {
                origin_records.push(record);
            }
            if let Some(taint) = deferred_taint {
                deferred_taints.push(taint);
            }
        }
        page.continuation.map(AbilityCursorInner::Control)
    } else {
        let (after_key, mut control_cursor) = match inner {
            Some(AbilityCursorInner::ProviderAfter {
                key,
                control_cursor,
            }) => (Some(key), control_cursor),
            Some(AbilityCursorInner::Control(_)) => {
                return Err(invalid(ValidationReason::CursorStale));
            }
            None => (None, None),
        };
        // Narrow owned-space discovery to Skill-consented Spaces whenever space-level
        // consent governs visibility so unconsented Spaces never enter catalog paging.
        // For Runtime view, keep consented owned Spaces even when filtering by System
        // so owned abilities shadowing built-in names still suppress shadowed System items.
        let (discover_auth, query_project, any_project_only) =
            if args.source == Some(Source::System) && view == View::Authoring {
                (call.auth.restrict_to_spaces(&BTreeSet::new()), None, false)
            } else if view == View::Runtime || project.is_some() {
                let (allowed, any_project_only) =
                    provider_skill_spaces(call, project.as_ref()).await?;
                let query_project = project
                    .as_ref()
                    .filter(|p| allowed.contains(&p.space_id))
                    .cloned();
                (
                    call.auth.restrict_to_spaces(&allowed),
                    query_project,
                    any_project_only,
                )
            } else {
                (call.auth.clone(), None, false)
            };
        let use_provider_runtime_overlay = view == View::Runtime && any_project_only;
        let discover_account = AccountContext::new(discover_auth, call.budget());
        let cap = usize::from(limit);
        let mut last_key: Option<AbilitySortKey> = None;
        let mut resume_cursor: Option<String> = None;
        let mut has_more = false;
        let mut reached_end = false;
        let mut runtime_winner_cache: BTreeMap<String, Vec<AbilityRef>> = BTreeMap::new();
        'scan: for page_idx in 0..MAX_PROVIDER_ABILITY_SCAN_PAGES {
            let mut page_start_cursor = control_cursor.clone();
            let page = match call
                .registry
                .control
                .discover_abilities(
                    discover_account.clone(),
                    AbilityQuery {
                        page: ControlPageRequest::new(
                            PROVIDER_ABILITY_SCAN_PAGE_SIZE,
                            control_cursor.clone(),
                        )?,
                        project: query_project.clone(),
                        kind: args.kind.map(Into::into),
                        name: None,
                        authoring: view == View::Authoring || use_provider_runtime_overlay,
                    },
                )
                .await
            {
                Ok(page) => page,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if page_idx == 0
                        && control_cursor.is_some()
                        && diagnostic.reason == ValidationReason::CursorStale =>
                {
                    // A concurrent change (including in an unconsented Space
                    // under authoring discovery) can stale the inner catalog
                    // cursor. Fall back to scanning from the start using `after_key`.
                    control_cursor = None;
                    page_start_cursor = None;
                    call.registry
                        .control
                        .discover_abilities(
                            discover_account.clone(),
                            AbilityQuery {
                                page: ControlPageRequest::new(
                                    PROVIDER_ABILITY_SCAN_PAGE_SIZE,
                                    None,
                                )?,
                                project: query_project.clone(),
                                kind: args.kind.map(Into::into),
                                name: None,
                                authoring: view == View::Authoring || use_provider_runtime_overlay,
                            },
                        )
                        .await?
                }
                Err(error) => return Err(error),
            };
            for inspection in page.items {
                let descriptor = &inspection.descriptor;
                let key = ability_sort_key(descriptor)?;
                if after_key.as_ref().is_some_and(|after| &key <= after) {
                    continue;
                }
                if args
                    .source
                    .is_some_and(|expected| source(&descriptor.reference) != expected)
                {
                    if view == View::Runtime
                        && args.source == Some(Source::System)
                        && !use_provider_runtime_overlay
                        && placement_is_foreign(
                            call,
                            &descriptor.reference.placement,
                            descriptor.entrypoint.as_ref(),
                        )
                        && crate::abilities::is_reserved_ability_name(&descriptor.name)
                        && role_placement_matches_project(
                            &descriptor.reference.placement,
                            project.as_ref(),
                        )
                        && provider_ability_allowed(call, &inspection, project.as_ref())
                    {
                        deferred_taints.push(AbilityTaintCommit::ForeignBranch {
                            taint: call.auth.taint().clone(),
                        });
                    }
                    continue;
                }
                if (view == View::Runtime || project.is_some())
                    && !role_placement_matches_project(
                        &descriptor.reference.placement,
                        project.as_ref(),
                    )
                {
                    continue;
                }
                if !provider_ability_allowed(call, &inspection, project.as_ref()) {
                    continue;
                }
                if use_provider_runtime_overlay {
                    if !descriptor.enabled
                        || !descriptor.healthy
                        || !provider_placement_visible(call, descriptor, project.as_ref()).await?
                    {
                        continue;
                    }
                    let winners = match runtime_winner_cache.get(&descriptor.name) {
                        Some(cached) => cached,
                        None => {
                            let computed = provider_runtime_winners(
                                call,
                                &discover_account,
                                &query_project,
                                project.as_ref(),
                                &descriptor.name,
                            )
                            .await?;
                            runtime_winner_cache
                                .entry(descriptor.name.clone())
                                .or_insert(computed)
                        }
                    };
                    if !winners.contains(&descriptor.reference) {
                        if winners
                            .iter()
                            .any(|winner| placement_is_foreign(call, &winner.placement, None))
                        {
                            deferred_taints.push(AbilityTaintCommit::ForeignBranch {
                                taint: call.auth.taint().clone(),
                            });
                        }
                        continue;
                    }
                }
                let body = match read_body_inner(call, descriptor, project.as_ref(), false).await {
                    Ok(body) => body,
                    Err(error) if visible_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                if query.as_ref().is_some_and(|query| {
                    !notarium_syntax::unicode::lookup_key(&descriptor.name).contains(query)
                        && !notarium_syntax::unicode::lookup_key(&body.description).contains(query)
                }) {
                    if let Some(taint) = body.deferred_taint {
                        deferred_taints.push(taint);
                    }
                    continue;
                }
                if items.len() == cap {
                    if let Some(taint) = body.deferred_taint {
                        deferred_taints.push(taint);
                    }
                    has_more = true;
                    resume_cursor = page_start_cursor;
                    break 'scan;
                }
                let enabled = if view == View::Runtime {
                    descriptor.enabled
                } else {
                    inspection.binding_enabled && inspection.preference_enabled
                };
                items.push(summary(&inspection, &body.description, enabled, false)?);
                origin_records.push((body.origin, body.project));
                if let Some(taint) = body.deferred_taint {
                    deferred_taints.push(taint);
                }
                last_key = Some(key);
            }
            if page.continuation.is_none() {
                reached_end = true;
                break;
            }
            control_cursor = page.continuation;
        }
        if has_more {
            last_key.map(|key| AbilityCursorInner::ProviderAfter {
                key,
                control_cursor: resume_cursor,
            })
        } else if !reached_end {
            // Never silently truncate unvisited abilities (including trailing
            // System built-ins) when the per-call scan budget is exhausted.
            if let Some(key) = last_key {
                Some(AbilityCursorInner::ProviderAfter {
                    key,
                    control_cursor,
                })
            } else {
                commit_deferred_taints_on_error(call, &deferred_taints);
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
        } else {
            None
        }
    };

    for (origin, proj) in origin_records {
        call.record_origin(origin, proj)?;
    }
    let next = next_inner
        .map(|inner| {
            call.registry
                .ability_cursors
                .insert(call.auth.principal().clone(), scope, inner)
        })
        .transpose()?;
    for commit in deferred_taints {
        commit.commit()?;
    }
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
    let inspection = inspect_with_project(call, &args.reference, project.as_ref())
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    if !provider_ability_allowed(call, &inspection, project.as_ref()) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let body = read_body_inner(call, &inspection.descriptor, project.as_ref(), false)
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    let mut deferred_taints = Vec::new();
    if let Some(taint) = body.deferred_taint {
        deferred_taints.push(taint);
    }
    let mut bytes = body.instructions.len();
    let in_app = matches!(call.target, EgressTarget::InAppProvider { .. });
    if in_app && bytes > MAX_IN_APP_PACKAGE_BODY_BYTES {
        commit_deferred_taints_on_error(call, &deferred_taints);
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
        let resource = match read_owned_resource_inner(
            call,
            &inspection.descriptor,
            project.as_ref(),
            AbilityResourceName::Auxiliary(path.clone()),
            false,
        )
        .await
        {
            Ok(resource) => resource,
            Err(error) if visible_error(&error) => continue,
            Err(error) => return Err(error),
        };
        if let Some(taint) = resource.deferred_taint {
            deferred_taints.push(taint);
        }
        let Some(next_bytes) = bytes.checked_add(resource.text.len()) else {
            commit_deferred_taints_on_error(call, &deferred_taints);
            return Err(invalid(ValidationReason::BudgetExceeded));
        };
        bytes = next_bytes;
        if in_app && bytes > MAX_IN_APP_PACKAGE_BODY_BYTES {
            commit_deferred_taints_on_error(call, &deferred_taints);
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
                match read_body_inner(call, &inspection.descriptor, project.as_ref(), false).await {
                    Ok(body) => {
                        call.record_origin(body.origin, body.project)?;
                        if let Some(taint) = body.deferred_taint {
                            deferred_taints.push(taint);
                        }
                    }
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
    for taint in deferred_taints {
        taint.commit()?;
    }
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
    let resolved = resolve_selector_for_call(call, selector, kind, project.clone())
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

fn selection_admits_descriptor(
    primary_selection: &ProviderSelection,
    allowed_selections: &BTreeMap<SpaceId, ProviderSelection>,
    descriptor: &AbilityDescriptor,
) -> bool {
    let reference = &descriptor.reference;
    if reference.placement == AbilityPlacement::System {
        return primary_selection
            .policy
            .allowed_classes
            .contains(&DocClass::Skill);
    }
    let Some(entry) = &descriptor.entrypoint else {
        return false;
    };
    let Some(sel) = allowed_selections.get(&entry.space_id) else {
        return false;
    };
    if !sel.policy.allowed_classes.contains(&DocClass::Skill) {
        return false;
    }
    if let Some(required) = &sel.project_only
        && (!reference.placement.in_project(required)
            || descriptor
                .promoted_from
                .as_ref()
                .is_some_and(|prev| !prev.placement.in_project(required)))
    {
        return false;
    }
    true
}

async fn locate_chat_role_by_id(
    registry: &ToolRegistry,
    resolve_account: &AccountContext,
    primary_selection: &ProviderSelection,
    allowed_selections: &BTreeMap<SpaceId, ProviderSelection>,
    id: AbilityId,
    project: Option<&FolderRef>,
) -> Result<Option<AbilityRef>, PortError> {
    let candidates = registry
        .catalog
        .locate_ability(resolve_account.clone(), id)
        .await?;
    let mut visible: Option<AbilityRef> = None;
    for candidate in candidates {
        let inspection = match registry
            .control
            .inspect_ability(resolve_account.clone(), candidate.reference.identity())
            .await
        {
            Ok(inspection) => inspection,
            Err(error) if visible_error(&error) => continue,
            Err(error) => return Err(error),
        };
        if !role_placement_matches_project(&inspection.descriptor.reference.placement, project) {
            continue;
        }
        if !selection_admits_descriptor(
            primary_selection,
            allowed_selections,
            &inspection.descriptor,
        ) {
            continue;
        }
        if let Some(existing) = &visible
            && existing.identity() == inspection.descriptor.reference.identity()
        {
            continue;
        }
        if visible.replace(inspection.descriptor.reference).is_some() {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
    }
    Ok(visible)
}

#[allow(clippy::too_many_arguments)]
pub async fn bind_chat_role(
    registry: &ToolRegistry,
    owner_account: AccountContext,
    primary: SpaceContext,
    selection: &ProviderSelection,
    episode_id: &EpisodeId,
    selector: &str,
    project: Option<&FolderRef>,
    run: &AgentRunId,
) -> Result<(), PortError> {
    let run_auth = primary.auth().with_preflight_taint();
    // Resolve the requested role strictly over provider-visible Spaces and
    // placements (including `project_only` / `promoted_from`) so unconsented
    // abilities neither shadow consented roles nor leak Disabled/Stale states
    // or durably bind a role unreachable to `runtime_abilities`.
    let shared_primary = matches!(selection.policy.audience, ProviderAudience::Shared { .. });
    let mut allowed_selections: BTreeMap<SpaceId, ProviderSelection> = BTreeMap::new();
    for (space_id, grant) in run_auth.spaces() {
        if !grant.read_classes.contains(&DocClass::Skill) {
            continue;
        }
        if space_id == &primary.scope().space_id {
            if selection.policy.allowed_classes.contains(&DocClass::Skill) {
                allowed_selections.insert(space_id.clone(), selection.clone());
            }
            continue;
        }
        // Chats in a Shared Space cannot append replies once tainted by a
        // cross-Space read, so never resolve or bind a role from another Space.
        if shared_primary {
            continue;
        }
        let live = match registry
            .catalog
            .space(primary.budget.clone(), space_id.clone())
            .await
        {
            Ok(live) => live,
            Err(error) if visible_error(&error) => continue,
            Err(error) => return Err(error),
        };
        if live.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active {
            continue;
        }
        if let Some(active) = project
            && space_id != &active.space_id
            && live.space.kind != notarium_core::auth::SpaceKind::Personal
        {
            continue;
        }
        let space_ctx = SpaceContext::new(run_auth.clone(), live.history, primary.budget.clone())?;
        let probe_project = project.filter(|p| &p.space_id == space_id).cloned();
        match registry
            .control
            .select_provider(
                space_ctx,
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: Some(selection.provider.clone()),
                    model: Some(selection.model.clone()),
                    project: probe_project,
                },
            )
            .await
        {
            Ok(chosen) if chosen.policy.allowed_classes.contains(&DocClass::Skill) => {
                allowed_selections.insert(space_id.clone(), chosen);
            }
            Ok(_) => (),
            Err(error) if visible_error(&error) => (),
            Err(error) => return Err(error),
        }
    }
    let allowed: BTreeSet<SpaceId> = allowed_selections.keys().cloned().collect();
    let resolve_account = AccountContext::new(
        run_auth.restrict_to_spaces(&allowed),
        primary.budget.clone(),
    );
    let resolve_project = project.filter(|p| allowed.contains(&p.space_id)).cloned();
    let mut exact_ar1_ref: Option<AbilityRef> = None;
    let resolution = if selector.starts_with("ar1:") {
        let reference: AbilityRef = parse_token(selector, "ar1:", MAX_TOKEN_BYTES)?;
        match &reference.placement {
            AbilityPlacement::System => {
                if !selection.policy.allowed_classes.contains(&DocClass::Skill) {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            AbilityPlacement::OwnedSpace(space) => {
                if !allowed_selections.contains_key(space) {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            AbilityPlacement::OwnedProject(folder) => {
                if !allowed_selections.contains_key(&folder.space_id) {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            AbilityPlacement::OwnedPersonal(_) => {
                // Personal placement resolves inside the personal Space; verify
                // admission on the resolved descriptor below.
            }
        }
        exact_ar1_ref = Some(reference.clone());
        registry
            .control
            .resolve_ability(
                resolve_account.clone(),
                AbilitySelection::Exact {
                    reference,
                    project: resolve_project.clone(),
                },
            )
            .await?
    } else if let Ok(id) = AbilityId::parse_v1(selector)
        && let Some(reference) = locate_chat_role_by_id(
            registry,
            &resolve_account,
            selection,
            &allowed_selections,
            id,
            project,
        )
        .await?
    {
        registry
            .control
            .resolve_ability(
                resolve_account.clone(),
                AbilitySelection::Exact {
                    reference,
                    project: resolve_project.clone(),
                },
            )
            .await?
    } else {
        let name = notarium_syntax::unicode::lookup_key(selector);
        let page = registry
            .control
            .discover_abilities(
                resolve_account.clone(),
                AbilityQuery {
                    page: ControlPageRequest::new(200, None)?,
                    project: resolve_project.clone(),
                    kind: None,
                    name: Some(name),
                    authoring: true,
                },
            )
            .await?;
        if page.continuation.is_some() {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let mut winners: Vec<AbilityRef> = Vec::new();
        let mut best_prec: Option<u8> = None;
        for inspection in page.items {
            let reference = &inspection.descriptor.reference;
            if !role_placement_matches_project(&reference.placement, project) {
                continue;
            }
            if !selection_admits_descriptor(selection, &allowed_selections, &inspection.descriptor)
            {
                continue;
            }
            let prec = reference.placement.precedence();
            match best_prec {
                Some(best) if prec > best => continue,
                Some(best) if prec == best => {
                    if winners
                        .iter()
                        .all(|existing| existing.identity() != reference.identity())
                    {
                        winners.push(reference.clone());
                    }
                }
                _ => {
                    best_prec = Some(prec);
                    winners.clear();
                    winners.push(reference.clone());
                }
            }
        }
        let by_name = match winners.len() {
            0 => AbilityResolution::Missing,
            1 => {
                let reference = winners.pop().expect("single winner");
                let exact = registry
                    .control
                    .resolve_ability(
                        resolve_account.clone(),
                        AbilitySelection::Exact {
                            reference,
                            project: resolve_project.clone(),
                        },
                    )
                    .await?;
                match exact {
                    AbilityResolution::Resolved(value) if value.kind != AbilityKind::Role => {
                        AbilityResolution::WrongKind
                    }
                    other => other,
                }
            }
            _ => return Err(invalid(ValidationReason::InvalidState)),
        };
        if !matches!(by_name, AbilityResolution::Missing) {
            by_name
        } else if let Ok(id) = AbilityId::parse(selector)
            && let Some(reference) = locate_chat_role_by_id(
                registry,
                &resolve_account,
                selection,
                &allowed_selections,
                id,
                project,
            )
            .await?
        {
            registry
                .control
                .resolve_ability(
                    resolve_account.clone(),
                    AbilitySelection::Exact {
                        reference,
                        project: resolve_project,
                    },
                )
                .await?
        } else {
            by_name
        }
    };
    let ability = match resolution {
        AbilityResolution::Resolved(ability)
            if ability.kind == AbilityKind::Role
                && ability.healthy
                && ability.enabled
                && role_placement_matches_project(&ability.reference.placement, project)
                && selection_admits_descriptor(selection, &allowed_selections, &ability) =>
        {
            *ability
        }
        AbilityResolution::Disabled | AbilityResolution::Stale => {
            if let Some(reference) = exact_ar1_ref.as_ref() {
                let check_descriptor = |descriptor: &AbilityDescriptor| {
                    descriptor.kind == AbilityKind::Role
                        && role_placement_matches_project(&descriptor.reference.placement, project)
                        && selection_admits_descriptor(selection, &allowed_selections, descriptor)
                };
                let admitted = match registry
                    .control
                    .inspect_ability(resolve_account.clone(), reference.identity())
                    .await
                {
                    Ok(inspection) => check_descriptor(&inspection.descriptor),
                    Err(error) if visible_error(&error) => match &reference.placement {
                        AbilityPlacement::OwnedProject(folder) => {
                            let promoted = AbilityIdentity {
                                id: reference.id.clone(),
                                placement: AbilityPlacement::OwnedSpace(folder.space_id.clone()),
                            };
                            match registry
                                .control
                                .inspect_ability(resolve_account.clone(), promoted)
                                .await
                            {
                                Ok(inspection) => check_descriptor(&inspection.descriptor),
                                Err(error) if visible_error(&error) => false,
                                Err(error) => return Err(error),
                            }
                        }
                        _ => false,
                    },
                    Err(error) => return Err(error),
                };
                if !admitted {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            return match resolution {
                AbilityResolution::Disabled => Err(invalid(ValidationReason::InvalidState)),
                AbilityResolution::Stale => Err(invalid(ValidationReason::SourceMismatch)),
                _ => unreachable!(),
            };
        }
        _ => return Err(DomainError::ResourceNotFound.into()),
    };
    // Preflight provider egress and ClassEgressFence before committing BindRole so
    // an unconsented or Skill-disallowed role cannot durably poison subsequent turns.
    super::runtime_abilities::preflight_role(registry, &primary, selection, &ability, project)
        .await?;
    let episode = registry
        .control
        .get_episode(owner_account.clone(), episode_id.clone())
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
    let principal = owner_account.auth().principal().clone();
    registry
        .control
        .update_episode(
            owner_account,
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
    let foreign_project_taint = if let Some(proj) = &project
        && call
            .auth
            .pinned_write_space()
            .is_some_and(|pin| pin != &proj.space_id)
    {
        let proj_scope = session::space(call, &proj.space_id).await?;
        Some(AbilityTaintCommit::ForeignProject { scope: proj_scope })
    } else {
        None
    };
    let descriptor = resolve(call, &selector, kind, project.clone()).await?;
    let (rendered, mut deferred_taints) = match activation(
        call,
        &descriptor,
        project.as_ref(),
        args.budget_tokens.unwrap_or(DEFAULT_ACTIVATION_TOKENS),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            if matches!(
                &error,
                PortError::Domain(DomainError::ValidationFailed { diagnostic })
                    if diagnostic.reason == ValidationReason::BudgetExceeded
            ) && foreign_project_taint
                .as_ref()
                .is_some_and(AbilityTaintCommit::would_taint_branch)
            {
                call.commit_external_read();
            }
            return Err(error);
        }
    };
    if let Some(taint) = foreign_project_taint {
        deferred_taints.push(taint);
    }
    if kind == AbilityKind::Role
        && let Some(episode) = episode.as_ref()
        && !matches!(
            call.auth.kind(),
            PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
        )
        && call.auth.chat_audience() != Some(ChatAudience::Shared)
    {
        if call.auth.taint().is_tainted()
            || deferred_taints
                .iter()
                .any(AbilityTaintCommit::would_taint_branch)
        {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        save_active_role(call, episode, &descriptor.reference, project).await?;
    }
    for taint in deferred_taints {
        taint.commit()?;
    }
    Ok(rendered)
}

pub(super) async fn validate_session_role(
    call: &ToolCallContext<'_>,
    selector: &str,
    project: Option<&FolderRef>,
) -> Result<(), PortError> {
    let descriptor = resolve(call, selector, AbilityKind::Role, project.cloned()).await?;
    let body = read_body_inner(call, &descriptor, project, false)
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    if body.instructions.len() > MAX_ACTIVATION_TOKENS {
        if body
            .deferred_taint
            .as_ref()
            .is_some_and(AbilityTaintCommit::would_taint_branch)
        {
            call.commit_external_read();
        }
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(())
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
            .await
            .map_err(|error| collapse_provider_error(call, error))?
    };
    let body = read_body_inner(call, &descriptor, project.as_ref(), false)
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    let budget = if body.instructions.len() <= MAX_ACTIVATION_TOKENS {
        DEFAULT_ACTIVATION_TOKENS.max(body.instructions.len())
    } else if explicit.is_some() {
        if body
            .deferred_taint
            .as_ref()
            .is_some_and(AbilityTaintCommit::would_taint_branch)
        {
            call.commit_external_read();
        }
        return Err(invalid(ValidationReason::BudgetExceeded));
    } else {
        return Ok(None);
    };
    let (rendered, deferred_taints) =
        activation_with_body(call, &descriptor, project.as_ref(), body, budget).await?;
    if explicit.is_some() && call.auth.bearer_scope() != Some(BearerScope::Read) {
        if call.auth.taint().is_tainted()
            || deferred_taints
                .iter()
                .any(AbilityTaintCommit::would_taint_branch)
        {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        save_active_role(call, episode, &descriptor.reference, project).await?;
    }
    for taint in deferred_taints {
        taint.commit()?;
    }
    Ok(Some(rendered))
}

#[derive(Serialize, Deserialize)]
struct EpisodeRolePlan {
    // Older journals fingerprinted the observed account revision. Preserve it on replay.
    account_revision: ControlRevision,
    episode: EpisodeId,
    expected: ControlRevision,
    active_role: AbilityRef,
    project_hint: Option<FolderRef>,
}

async fn save_active_role(
    call: &ToolCallContext<'_>,
    episode: &AgentEpisode,
    role: &AbilityRef,
    project: Option<FolderRef>,
) -> Result<(), PortError> {
    if matches!(
        call.auth.kind(),
        PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
    ) || call.auth.chat_audience() == Some(ChatAudience::Shared)
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
                episode: episode.id.clone(),
                expected: episode.revision,
                active_role: role.clone(),
                project_hint: project.clone(),
            })
        })
        .await?;
    if plan.episode != episode.id || &plan.active_role != role || plan.project_hint != project {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    call.registry
        .control
        .update_episode(
            call.account(),
            AccountMutation {
                identity: call.account_identity(plan.account_revision, "activate-role-effect", 0),
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: plan.episode,
                    expected: plan.expected,
                    active_role: plan.active_role,
                    project_hint: plan.project_hint,
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
) -> Result<(Value, Vec<AbilityTaintCommit>), PortError> {
    let body = read_body_inner(call, descriptor, project, false)
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    activation_with_body(call, descriptor, project, body, budget).await
}

async fn activation_with_body(
    call: &mut ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    project: Option<&FolderRef>,
    body: AbilityBody,
    budget: usize,
) -> Result<(Value, Vec<AbilityTaintCommit>), PortError> {
    // Each UTF-8 byte can be a token in a byte-fallback tokenizer.
    let Some(mut remaining) = budget.checked_sub(body.instructions.len()) else {
        if body
            .deferred_taint
            .as_ref()
            .is_some_and(AbilityTaintCommit::would_taint_branch)
        {
            call.commit_external_read();
        }
        return Err(invalid(ValidationReason::BudgetExceeded));
    };
    let mut deferred_taints = Vec::new();
    if let Some(taint) = body.deferred_taint {
        deferred_taints.push(taint);
    }
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
            match read_body_inner(call, &inspection.descriptor, project, false).await {
                Ok(child) if child.instructions.len() <= remaining => {
                    remaining -= child.instructions.len();
                    let row = json!({
                        "ref":reference_token(&inspection.descriptor.reference)?,
                        "name":inspection.descriptor.name,
                        "instructions":child.instructions,
                    });
                    call.record_origin(child.origin, child.project)?;
                    if let Some(taint) = child.deferred_taint {
                        deferred_taints.push(taint);
                    }
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
    Ok((
        json!({
            "ref":reference_token(&descriptor.reference)?,
            "name":descriptor.name,
            "kind":kind_name(descriptor.kind),
            "instructions":body.instructions,
            "skills":skills,
            "omittedSkills":omitted,
        }),
        deferred_taints,
    ))
}

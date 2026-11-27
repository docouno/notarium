//! Pure authorization policy. Only control adapters may attest authentication facts.
//! These types intentionally do not implement Deserialize.
use crate::{
    DomainError, DomainResult,
    classes::DocClass,
    error::ValidationReason,
    ids::*,
    model::FolderRef,
    ports::{BearerScope, RevocationSelector},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// Secrets cross typed service boundaries without Debug or serialization leaks.
pub struct SecretString(zeroize::Zeroizing<String>);
impl SecretString {
    pub fn new(value: String) -> Self {
        Self(zeroize::Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

/// Durable lineage attested by the authentication owner. Derived agents retain
/// this lineage so a later control effect can recheck the original credential.
/// ```compile_fail
/// use notarium_core::auth::AuthenticatedCredential;
/// let _: AuthenticatedCredential = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthenticatedCredential {
    Session(AuthSessionId),
    Pat(CredentialTokenId),
    OAuth {
        token: CredentialTokenId,
        grant: OAuthGrantId,
        family: Option<OAuthFamilyId>,
    },
    /// Only the successful scheduler claim may attest this lineage. No bearer
    /// token or request deserializer can select a scheduled credential.
    ScheduledRun {
        schedule: ScheduleId,
        run: AgentRunId,
        lease: LeaseEpoch,
    },
    /// Internal, read-only authority scoped to one search indexing destination.
    SearchIndexing {
        space: SpaceId,
        provider: ProviderResourceId,
    },
    TrustedNone,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SpaceRole {
    Owner,
    Editor,
    Viewer,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SpaceLifecycle {
    Active,
    Closing,
    Archived,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SpaceKind {
    Personal,
    Shared,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Space {
    pub id: SpaceId,
    pub lifecycle: SpaceLifecycle,
    pub kind: SpaceKind,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Cap {
    AbilityWrite,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrincipalKind {
    DirectHuman,
    Pat,
    AgentRun(AgentRunId),
    Keeper(AgentRunId),
    OAuth { source: GrantId, narrowed: bool },
    SearchIndexing,
}

/// Independent authority used for explicit human confirmation of a proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalHumanAccess {
    ReadOnly,
    Write,
}

#[derive(Clone, Debug)]
pub struct SpaceGrant {
    pub role: SpaceRole,
    pub read_classes: BTreeSet<DocClass>,
    pub write_classes: BTreeSet<DocClass>,
    pub project_root: Option<FolderId>,
}

/// Authentication owner assertion; never construct from request JSON.
#[derive(Clone, Debug)]
pub struct VerifiedHuman {
    principal: PrincipalId,
    grant: GrantId,
    spaces: BTreeMap<SpaceId, SpaceGrant>,
    human_management: bool,
    ability_write: bool,
    credential: Option<AuthenticatedCredential>,
}
impl VerifiedHuman {
    pub fn attest(
        principal: PrincipalId,
        grant: GrantId,
        spaces: BTreeMap<SpaceId, SpaceGrant>,
        explicitly_authorized_ability_write: bool,
    ) -> Self {
        Self {
            principal,
            grant,
            spaces,
            human_management: false,
            ability_write: explicitly_authorized_ability_write,
            credential: None,
        }
    }
    pub fn with_human_management(mut self, human_management: bool) -> Self {
        self.human_management = human_management;
        self
    }
    pub fn with_credential(mut self, credential: AuthenticatedCredential) -> Self {
        self.credential = Some(credential);
        self
    }
}

/// The authenticated lineage of a PAT or OAuth access token.
pub enum BearerCredential {
    Pat(CredentialTokenId),
    OAuth {
        token: CredentialTokenId,
        grant: OAuthGrantId,
        family: Option<OAuthFamilyId>,
    },
}

/// The authentication owner attests a live bearer record and its effective
/// membership and consent intersection. This witness cannot be deserialized.
pub struct VerifiedBearer {
    principal: PrincipalId,
    grant: GrantId,
    credential: BearerCredential,
    spaces: BTreeMap<SpaceId, SpaceGrant>,
    scope: BearerScope,
    ability_write: bool,
}

impl VerifiedBearer {
    pub fn attest(
        principal: PrincipalId,
        grant: GrantId,
        credential: BearerCredential,
        spaces: BTreeMap<SpaceId, SpaceGrant>,
        scope: BearerScope,
        approved_ability_write: bool,
    ) -> Self {
        Self {
            principal,
            grant,
            credential,
            spaces,
            scope,
            ability_write: approved_ability_write,
        }
    }
}

/// Clones and forks share a monotonic fence; no handle can restore write access.
#[derive(Clone, Debug, Default)]
pub struct BranchTaint(Arc<AtomicBool>);
impl BranchTaint {
    pub fn is_tainted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn mark_external_read(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn merge(&self, other: &Self) {
        if other.is_tainted() {
            self.mark_external_read();
        }
    }
    pub fn fork(&self) -> Self {
        self.clone()
    }
}

#[derive(Clone, Debug)]
pub struct EngineAuthContext {
    principal: PrincipalId,
    grant: GrantId,
    kind: PrincipalKind,
    spaces: BTreeMap<SpaceId, SpaceGrant>,
    spaces_narrowed: bool,
    human_management: bool,
    proposal_read: bool,
    ability_write: bool,
    write_space: Option<SpaceId>,
    chat_audience: Option<ChatAudience>,
    taint: BranchTaint,
    readonly_abilities: BTreeSet<AbilityId>,
    keeper_log: Option<ChatThreadId>,
    credential: Option<AuthenticatedCredential>,
    bearer_scope: Option<BearerScope>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatAudience {
    Personal,
    Shared,
}

/// Canonical resource facts, including ancestry, are supplied by the storage owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceFacts {
    pub space: Space,
    pub class: DocClass,
    /// Nearest enclosing canonical project, if any. Scoped authorization
    /// still checks the complete ancestry below.
    pub project: Option<FolderId>,
    pub ancestor_folders: Vec<FolderId>,
    pub folder_write_locked: bool,
    pub ability_package: Option<AbilityId>,
}

impl EngineAuthContext {
    pub fn for_human(verified: VerifiedHuman) -> Self {
        Self {
            principal: verified.principal,
            grant: verified.grant,
            kind: PrincipalKind::DirectHuman,
            spaces: verified.spaces,
            spaces_narrowed: false,
            human_management: verified.human_management,
            proposal_read: false,
            ability_write: verified.human_management && verified.ability_write,
            write_space: None,
            chat_audience: None,
            taint: BranchTaint::default(),
            readonly_abilities: BTreeSet::new(),
            keeper_log: None,
            credential: verified.credential,
            bearer_scope: None,
        }
    }
    pub fn for_bearer(verified: VerifiedBearer) -> Self {
        let (kind, credential) = match verified.credential {
            BearerCredential::Pat(id) => (PrincipalKind::Pat, AuthenticatedCredential::Pat(id)),
            BearerCredential::OAuth {
                token,
                grant,
                family,
            } => (
                PrincipalKind::OAuth {
                    source: verified.grant.clone(),
                    narrowed: true,
                },
                AuthenticatedCredential::OAuth {
                    token,
                    grant,
                    family,
                },
            ),
        };
        let mut spaces = verified.spaces;
        if verified.scope == BearerScope::Read {
            for grant in spaces.values_mut() {
                grant.write_classes.clear();
            }
        }
        Self {
            principal: verified.principal,
            grant: verified.grant,
            kind,
            ability_write: verified.scope == BearerScope::Write
                && verified.ability_write
                && Self::has_writable_space(&spaces),
            spaces,
            spaces_narrowed: false,
            human_management: false,
            proposal_read: false,
            write_space: None,
            chat_audience: None,
            taint: BranchTaint::default(),
            readonly_abilities: BTreeSet::new(),
            keeper_log: None,
            credential: Some(credential),
            bearer_scope: Some(verified.scope),
        }
    }
    fn has_writable_space(spaces: &BTreeMap<SpaceId, SpaceGrant>) -> bool {
        spaces
            .values()
            .any(|grant| grant.role != SpaceRole::Viewer && !grant.write_classes.is_empty())
    }
    /// Internal read-only context scoped to one Space for remote search indexing.
    /// Never carries human management, write privileges, or encrypted-note reads.
    pub fn for_search_indexing(
        principal: PrincipalId,
        grant: GrantId,
        space: SpaceId,
        provider: ProviderResourceId,
    ) -> Self {
        let mut read_classes = DocClass::all();
        read_classes.remove(&DocClass::EncryptedNote);
        Self {
            principal,
            grant,
            kind: PrincipalKind::SearchIndexing,
            spaces: BTreeMap::from([(
                space.clone(),
                SpaceGrant {
                    role: SpaceRole::Viewer,
                    read_classes,
                    write_classes: BTreeSet::new(),
                    project_root: None,
                },
            )]),
            spaces_narrowed: true,
            human_management: false,
            proposal_read: false,
            ability_write: false,
            write_space: None,
            chat_audience: None,
            taint: BranchTaint::default(),
            readonly_abilities: BTreeSet::new(),
            keeper_log: None,
            bearer_scope: None,
            credential: Some(AuthenticatedCredential::SearchIndexing { space, provider }),
        }
    }
    fn is_search_indexing(&self) -> bool {
        self.kind == PrincipalKind::SearchIndexing
            || matches!(
                self.credential,
                Some(AuthenticatedCredential::SearchIndexing { .. })
            )
    }
    pub fn for_agent_run(
        &self,
        run: AgentRunId,
        thread_space: SpaceId,
        audience: ChatAudience,
        requested: BTreeMap<SpaceId, SpaceGrant>,
    ) -> DomainResult<Self> {
        if matches!(self.kind, PrincipalKind::Keeper(_)) || self.keeper_log.is_some() {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        self.for_agent_run_inner(run, thread_space, audience, requested)
    }
    fn for_agent_run_inner(
        &self,
        run: AgentRunId,
        thread_space: SpaceId,
        audience: ChatAudience,
        requested: BTreeMap<SpaceId, SpaceGrant>,
    ) -> DomainResult<Self> {
        if self.keeper_log.is_some() {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.is_search_indexing() {
            return Err(DomainError::AccessDenied);
        }
        let mut derived = self.narrow(requested)?;
        if !derived.spaces.contains_key(&thread_space) {
            return Err(DomainError::ResourceNotFound);
        }
        // A nested run derived from a Shared-audience run cannot widen back to Personal.
        let effective_audience = if self.chat_audience == Some(ChatAudience::Shared) {
            ChatAudience::Shared
        } else {
            audience
        };
        if effective_audience == ChatAudience::Shared {
            derived.spaces.retain(|space, _| space == &thread_space);
            derived.spaces_narrowed = true;
            for grant in derived.spaces.values_mut() {
                grant.read_classes.remove(&DocClass::Profile);
                grant.write_classes.remove(&DocClass::Profile);
            }
        }
        // A nested run cannot choose a new write Space outside its parent's pin.
        if self
            .write_space
            .as_ref()
            .is_some_and(|space| space != &thread_space)
        {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        derived.kind = PrincipalKind::AgentRun(run);
        derived.write_space = Some(thread_space);
        derived.chat_audience = Some(effective_audience);
        if self.kind == PrincipalKind::DirectHuman {
            let taint = BranchTaint::default();
            taint.merge(&self.taint);
            derived.taint = taint;
        }
        Ok(derived)
    }
    pub fn for_keeper(
        &self,
        run: AgentRunId,
        space: SpaceId,
        project_root: Option<FolderId>,
        readonly_abilities: BTreeSet<AbilityId>,
    ) -> DomainResult<Self> {
        if self.is_search_indexing() {
            return Err(DomainError::AccessDenied);
        }
        let mut grant = self
            .spaces
            .get(&space)
            .cloned()
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.project_root.is_some() && grant.project_root != project_root {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        let may_pin_dependencies =
            self.kind == PrincipalKind::DirectHuman && grant.project_root.is_none();
        grant.project_root = project_root;
        grant
            .write_classes
            .retain(|class| *class == DocClass::AgentMemory);
        let mut derived = self.for_agent_run_inner(
            run.clone(),
            space.clone(),
            ChatAudience::Personal,
            BTreeMap::from([(space, grant)]),
        )?;
        derived.kind = PrincipalKind::Keeper(run);
        derived.spaces_narrowed = true;
        derived.readonly_abilities = if may_pin_dependencies {
            readonly_abilities
        } else {
            // A delegated run can retain an approved package exception, never
            // create a new exception to its parent's project boundary.
            readonly_abilities
                .intersection(&self.readonly_abilities)
                .cloned()
                .collect()
        };
        Ok(derived)
    }
    pub fn for_oauth(
        &self,
        source: GrantId,
        requested: BTreeMap<SpaceId, SpaceGrant>,
    ) -> DomainResult<Self> {
        if matches!(self.kind, PrincipalKind::Keeper(_)) || self.keeper_log.is_some() {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.is_search_indexing() {
            return Err(DomainError::AccessDenied);
        }
        let mut derived = self.narrow(requested)?;
        derived.kind = PrincipalKind::OAuth {
            source,
            narrowed: true,
        };
        derived.bearer_scope = Some(
            if self.bearer_scope != Some(BearerScope::Read)
                && Self::has_writable_space(&derived.spaces)
            {
                BearerScope::Write
            } else {
                BearerScope::Read
            },
        );
        Ok(derived)
    }
    /// Personal access tokens are delegated credentials, never interactive humans.
    pub fn for_pat(&self, requested: BTreeMap<SpaceId, SpaceGrant>) -> DomainResult<Self> {
        if matches!(self.kind, PrincipalKind::Keeper(_)) || self.keeper_log.is_some() {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.is_search_indexing() {
            return Err(DomainError::AccessDenied);
        }
        let mut derived = self.narrow(requested)?;
        derived.kind = PrincipalKind::Pat;
        derived.bearer_scope = Some(
            if self.bearer_scope != Some(BearerScope::Read)
                && Self::has_writable_space(&derived.spaces)
            {
                BearerScope::Write
            } else {
                BearerScope::Read
            },
        );
        Ok(derived)
    }

    /// Keep the same authenticated credential and confine this operation to one
    /// project. Canonical writes check live folder ancestry against this pin.
    pub fn restrict_to_project(&self, project: &FolderRef) -> DomainResult<Self> {
        let mut grant = self
            .spaces
            .get(&project.space_id)
            .ok_or(DomainError::ResourceNotFound)?
            .clone();
        if grant
            .project_root
            .as_ref()
            .is_some_and(|root| root != &project.folder_id)
        {
            return Err(DomainError::SpaceReadOnly);
        }
        grant.project_root = Some(project.folder_id.clone());
        let spaces = BTreeMap::from([(project.space_id.clone(), grant)]);
        let spaces_narrowed = true;
        let ability_write = self.ability_write && Self::has_writable_space(&spaces);
        Ok(Self {
            spaces,
            spaces_narrowed,
            ability_write,
            ..self.clone()
        })
    }
    /// Monotonically mark this context as space-narrowed so downstream
    /// account-wide management endpoints cannot widen its Space set.
    pub fn mark_spaces_narrowed(mut self) -> Self {
        self.spaces_narrowed = true;
        self
    }
    /// Monotonically narrow one Space grant's readable document classes (never widens).
    pub fn restrict_read_classes(
        &self,
        space: &SpaceId,
        allowed: &BTreeSet<DocClass>,
    ) -> DomainResult<Self> {
        let mut grant = self
            .spaces
            .get(space)
            .ok_or(DomainError::ResourceNotFound)?
            .clone();
        grant.read_classes.retain(|class| allowed.contains(class));
        let mut spaces = self.spaces.clone();
        spaces.insert(space.clone(), grant);
        Ok(Self {
            spaces,
            ..self.clone()
        })
    }

    /// Derive a read-only preflight context with a detached `BranchTaint`
    /// initialized from the caller's current taint state (never clearing
    /// pre-existing taint and stripping all write/management privileges).
    /// Callers MUST still enforce `ClassEgressFence` / `authorize_read` /
    /// `authorize_folder_read` on the live `EngineAuthContext` for every
    /// item actually admitted into a response.
    pub fn with_preflight_taint(&self) -> Self {
        let taint = BranchTaint::default();
        if self.taint.is_tainted() {
            taint.mark_external_read();
        }
        let mut spaces = self.spaces.clone();
        for grant in spaces.values_mut() {
            grant.write_classes.clear();
        }
        Self {
            spaces,
            human_management: false,
            ability_write: false,
            taint,
            ..self.clone()
        }
    }

    /// Clone this auth context with a detached `BranchTaint` initialized from
    /// the caller's current taint state, preserving all grants and rights.
    /// Tool boundaries use this to stage cross-space taint and commit it back
    /// to the caller's `BranchTaint` only when a call succeeds or crosses an
    /// irreversible probing boundary.
    pub fn with_staged_taint(&self) -> Self {
        let taint = BranchTaint::default();
        if self.taint.is_tainted() {
            taint.mark_external_read();
        }
        Self {
            taint,
            ..self.clone()
        }
    }

    /// Narrow readable/writable spaces to the intersection with `allowed`.
    pub fn restrict_to_spaces(&self, allowed: &BTreeSet<SpaceId>) -> Self {
        let mut spaces = self.spaces.clone();
        spaces.retain(|space_id, _| allowed.contains(space_id));
        let ability_write = self.ability_write && Self::has_writable_space(&spaces);
        Self {
            spaces,
            spaces_narrowed: true,
            ability_write,
            ..self.clone()
        }
    }

    pub fn is_space_narrowed(&self) -> bool {
        self.spaces_narrowed
    }

    fn narrow(&self, requested: BTreeMap<SpaceId, SpaceGrant>) -> DomainResult<Self> {
        if self.proposal_read {
            return Err(DomainError::AccessDenied);
        }
        let mut spaces = BTreeMap::new();
        for (id, wanted) in requested {
            let parent = self.spaces.get(&id).ok_or(DomainError::ResourceNotFound)?;
            if parent.project_root.is_some() && wanted.project_root != parent.project_root {
                return Err(DomainError::validation(ValidationReason::ScopeMismatch));
            }
            let role = match (parent.role, wanted.role) {
                (SpaceRole::Viewer, _) | (_, SpaceRole::Viewer) => SpaceRole::Viewer,
                (SpaceRole::Editor, _) | (_, SpaceRole::Editor) => SpaceRole::Editor,
                _ => SpaceRole::Owner,
            };
            spaces.insert(
                id,
                SpaceGrant {
                    role,
                    read_classes: parent
                        .read_classes
                        .intersection(&wanted.read_classes)
                        .copied()
                        .collect(),
                    write_classes: parent
                        .write_classes
                        .intersection(&wanted.write_classes)
                        .copied()
                        .collect(),
                    project_root: wanted.project_root,
                },
            );
        }
        let spaces_narrowed = self.spaces_narrowed || spaces.len() < self.spaces.len();
        Ok(Self {
            spaces,
            spaces_narrowed,
            human_management: false,
            ability_write: false,
            bearer_scope: self.bearer_scope,
            ..self.clone()
        })
    }
    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }
    /// Retain the credential and its existing ceilings in one admitted Space.
    pub fn restrict_to_space(&self, space: &SpaceId) -> DomainResult<Self> {
        let grant = self
            .spaces
            .get(space)
            .ok_or(DomainError::ResourceNotFound)?;
        let mut scoped = self.clone();
        scoped.spaces = BTreeMap::from([(space.clone(), grant.clone())]);
        scoped.spaces_narrowed = true;
        scoped.ability_write &= Self::has_writable_space(&scoped.spaces);
        Ok(scoped)
    }
    /// The authentication owner supplies freshly verified durable authority.
    /// Keep the caller's delegation, project pin, taint and write-Space pin while
    /// intersecting current permissions; refreshing cannot widen an old context.
    pub fn intersect_current(&self, current: &Self) -> DomainResult<Self> {
        if self.principal != current.principal
            || self.grant != current.grant
            || self.credential != current.credential
            || self.credential.is_none()
            || self.keeper_log != current.keeper_log
            || (self.kind == PrincipalKind::SearchIndexing)
                != (current.kind == PrincipalKind::SearchIndexing)
        {
            return Err(DomainError::AuthenticationFailed);
        }
        let requested = current
            .spaces
            .iter()
            .filter_map(|(id, fresh)| {
                let old = self.spaces.get(id)?;
                if let (Some(old_root), Some(fresh_root)) = (&old.project_root, &fresh.project_root)
                    && old_root != fresh_root
                {
                    return None;
                }
                let mut wanted = fresh.clone();
                wanted.project_root = old.project_root.clone().or(wanted.project_root);
                Some((id.clone(), wanted))
            })
            .collect();
        let mut result = self.narrow(requested)?;
        if matches!(self.kind, PrincipalKind::Keeper(_)) || self.keeper_log.is_some() {
            result.readonly_abilities = self
                .readonly_abilities
                .intersection(&current.readonly_abilities)
                .cloned()
                .collect();
        }
        result.spaces_narrowed = self.spaces_narrowed
            || current.spaces_narrowed
            || result.spaces.len() < current.spaces.len();
        result.human_management = self.human_management() && current.human_management();
        result.bearer_scope = match (self.bearer_scope, current.bearer_scope) {
            (Some(BearerScope::Read), _) | (_, Some(BearerScope::Read)) => Some(BearerScope::Read),
            (Some(BearerScope::Write), Some(BearerScope::Write)) => Some(BearerScope::Write),
            (None, Some(BearerScope::Write)) => Some(BearerScope::Write),
            (Some(BearerScope::Write), None) => Some(BearerScope::Read),
            (None, None) => None,
        };
        result.ability_write = self.has_cap(Cap::AbilityWrite)
            && current.has_cap(Cap::AbilityWrite)
            && (result.human_management
                || (result.bearer_scope == Some(BearerScope::Write)
                    && Self::has_writable_space(&result.spaces)));
        if current.chat_audience == Some(ChatAudience::Shared) {
            result.chat_audience = Some(ChatAudience::Shared);
        }
        Ok(result)
    }
    pub fn chat_audience(&self) -> Option<ChatAudience> {
        self.chat_audience
    }
    pub fn grant(&self) -> &GrantId {
        &self.grant
    }
    pub fn credential(&self) -> Option<&AuthenticatedCredential> {
        self.credential.as_ref()
    }
    /// The authenticated scope is independent of the number of live memberships.
    pub fn bearer_scope(&self) -> Option<BearerScope> {
        self.bearer_scope
    }
    pub fn kind(&self) -> &PrincipalKind {
        &self.kind
    }
    pub fn readonly_abilities(&self) -> &BTreeSet<AbilityId> {
        &self.readonly_abilities
    }
    pub fn keeper_log(&self) -> Option<&ChatThreadId> {
        self.keeper_log.as_ref()
    }
    /// Bind the log from a verified schedule-run record at the control boundary.
    pub fn with_verified_keeper_log(mut self, thread: ChatThreadId) -> DomainResult<Self> {
        if !matches!(
            (&self.kind, self.credential()),
            (PrincipalKind::Keeper(run), Some(AuthenticatedCredential::ScheduledRun { run: verified, .. }))
                if run == verified
        ) || self
            .keeper_log
            .as_ref()
            .is_some_and(|existing| existing != &thread)
        {
            return Err(DomainError::AuthenticationFailed);
        }
        self.keeper_log = Some(thread);
        Ok(self)
    }
    pub fn spaces(&self) -> &BTreeMap<SpaceId, SpaceGrant> {
        &self.spaces
    }
    /// Scope a live actor's revocation identity to these admitted Spaces.
    pub fn selectors_for_revocation<'a>(
        &self,
        spaces: impl IntoIterator<Item = &'a SpaceId>,
    ) -> DomainResult<BTreeSet<RevocationSelector>> {
        let mut selectors = BTreeSet::from([
            RevocationSelector::Principal(self.principal.clone()),
            RevocationSelector::Grant(self.grant.clone()),
        ]);
        match self.credential().ok_or(DomainError::AuthenticationFailed)? {
            AuthenticatedCredential::Session(id) => {
                selectors.insert(RevocationSelector::Session(id.clone()));
            }
            AuthenticatedCredential::OAuth {
                token,
                grant,
                family,
            } => {
                selectors.insert(RevocationSelector::OAuthAccess(token.clone()));
                selectors.insert(RevocationSelector::OAuthGrant(grant.clone()));
                if let Some(family) = family {
                    selectors.insert(RevocationSelector::OAuthFamily(family.clone()));
                }
            }
            AuthenticatedCredential::ScheduledRun { schedule, run, .. } => {
                selectors.insert(RevocationSelector::Schedule(schedule.clone()));
                selectors.insert(RevocationSelector::ScheduledRun(run.clone()));
            }
            AuthenticatedCredential::Pat(_)
            | AuthenticatedCredential::SearchIndexing { .. }
            | AuthenticatedCredential::TrustedNone => (),
        }
        if let (PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run), Some(space)) =
            (self.kind(), self.pinned_write_space())
        {
            selectors.insert(RevocationSelector::AgentRun {
                space: space.clone(),
                run: run.clone(),
            });
        }
        for space in spaces {
            if !self.spaces.contains_key(space) {
                return Err(DomainError::ResourceNotFound);
            }
            selectors.insert(RevocationSelector::Space(space.clone()));
            selectors.insert(RevocationSelector::Membership {
                space: space.clone(),
                principal: self.principal.clone(),
            });
        }
        Ok(selectors)
    }
    pub fn pinned_write_space(&self) -> Option<&SpaceId> {
        self.write_space.as_ref()
    }
    /// A remote query uses the caller's active Space and cannot carry external reads.
    pub fn authorize_remote_embedding_query(&self, space: &SpaceId) -> DomainResult<()> {
        if self.taint.is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        if self.write_space.as_ref().is_some_and(|pin| pin != space) {
            return Err(DomainError::AccessDenied);
        }
        Ok(())
    }
    pub fn taint(&self) -> &BranchTaint {
        &self.taint
    }
    pub fn human_management(&self) -> bool {
        !self.is_search_indexing()
            && self.human_management
            && self.kind == PrincipalKind::DirectHuman
    }
    pub fn authorize_human_management(&self) -> DomainResult<()> {
        if !self.human_management() {
            return Err(DomainError::AccessDenied);
        }
        if self.taint.is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        Ok(())
    }
    /// Check trusted interactive input before re-reading its live credential.
    pub fn authorize_proposal_confirmation(&self) -> DomainResult<()> {
        if !self.human_management() {
            return Err(DomainError::AccessDenied);
        }
        if !matches!(
            self.credential(),
            Some(AuthenticatedCredential::Session(_) | AuthenticatedCredential::TrustedNone)
        ) {
            return Err(DomainError::AuthenticationFailed);
        }
        if self.taint.is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        Ok(())
    }

    /// Authentication owner only. Each confirmation context starts with the
    /// latch of a separately verified human, while retaining the input ceiling.
    pub fn for_proposal_human(
        prior: &Self,
        live: VerifiedHuman,
        access: ProposalHumanAccess,
    ) -> DomainResult<Self> {
        prior.authorize_proposal_confirmation()?;
        let mut fresh = Self::for_human(live);
        fresh.authorize_proposal_confirmation()?;
        let narrowed = prior.intersect_current(&fresh)?;
        fresh.spaces = narrowed.spaces;
        fresh.spaces_narrowed = narrowed.spaces_narrowed;
        fresh.write_space = narrowed.write_space;
        fresh.ability_write = false;
        if access == ProposalHumanAccess::ReadOnly {
            fresh.human_management = false;
            fresh.proposal_read = true;
            for grant in fresh.spaces.values_mut() {
                grant.role = SpaceRole::Viewer;
                grant.write_classes.clear();
            }
        }
        Ok(fresh)
    }

    /// Dedicated read authority for the canonical proposal witness.
    pub fn authorize_proposal_read(&self) -> DomainResult<()> {
        if self.kind == PrincipalKind::DirectHuman && self.proposal_read {
            Ok(())
        } else {
            Err(DomainError::ResourceNotFound)
        }
    }
    pub fn has_cap(&self, cap: Cap) -> bool {
        match cap {
            Cap::AbilityWrite => {
                !self.is_search_indexing()
                    && self.ability_write
                    && matches!(
                        self.kind,
                        PrincipalKind::DirectHuman
                            | PrincipalKind::Pat
                            | PrincipalKind::OAuth { .. }
                    )
            }
        }
    }
    pub fn authorize_ability_mutation(&self) -> DomainResult<()> {
        if self.has_cap(Cap::AbilityWrite) {
            Ok(())
        } else {
            Err(DomainError::AbilityWriteForbidden)
        }
    }
    /// Metadata visibility check that never mutates shared branch taint.
    /// Content reading and provider egress must still call `authorize_folder_read`.
    pub fn can_view_folder(
        &self,
        space: &Space,
        folder: &FolderId,
        ancestors: &[FolderId],
    ) -> DomainResult<()> {
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active
            || grant.read_classes.is_empty()
            || grant
                .project_root
                .as_ref()
                .is_some_and(|root| root != folder && !ancestors.contains(root))
        {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(())
    }
    /// Metadata visibility check that never mutates shared branch taint.
    /// Content reading and provider egress must still call `authorize_read`.
    pub fn can_view_resource(&self, resource: &ResourceFacts) -> DomainResult<()> {
        let grant = self
            .spaces
            .get(&resource.space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if resource.space.lifecycle != SpaceLifecycle::Active
            || !grant.read_classes.contains(&resource.class)
        {
            return Err(DomainError::ResourceNotFound);
        }
        let is_pinned_ability = resource
            .ability_package
            .as_ref()
            .is_some_and(|id| self.readonly_abilities.contains(id));
        if matches!(self.kind, PrincipalKind::Keeper(_))
            && resource.class == DocClass::Skill
            && !is_pinned_ability
        {
            return Err(DomainError::ResourceNotFound);
        }
        if grant
            .project_root
            .as_ref()
            .is_some_and(|root| !resource.ancestor_folders.contains(root))
            && !is_pinned_ability
        {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(())
    }
    /// Folder metadata has no document class. It still requires a nonempty read
    /// grant and current ancestry, and participates in the same branch taint.
    pub fn authorize_folder_read(
        &self,
        space: &Space,
        folder: &FolderId,
        ancestors: &[FolderId],
    ) -> DomainResult<()> {
        self.can_view_folder(space, folder, ancestors)?;
        if self.write_space.as_ref().is_some_and(|id| id != &space.id) {
            self.taint.mark_external_read();
        }
        Ok(())
    }
    pub fn authorize_read(&self, resource: &ResourceFacts) -> DomainResult<()> {
        self.can_view_resource(resource)?;
        if self
            .write_space
            .as_ref()
            .is_some_and(|space| space != &resource.space.id)
        {
            self.taint.mark_external_read();
        }
        Ok(())
    }
    /// Candidate filter for the current principal's personal threads, before a
    /// search result supplies a specific thread identity.
    pub fn can_view_own_personal_chat(
        &self,
        space: &Space,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        if self.chat_audience == Some(ChatAudience::Shared)
            || matches!(self.kind, PrincipalKind::Keeper(_))
            || self.keeper_log.is_some()
        {
            return Err(DomainError::ResourceNotFound);
        }
        self.can_view_chat(space, project, tainted)
    }

    /// Check thread visibility without marking a candidate as a delivered read.
    pub fn can_view_chat_thread(
        &self,
        space: &Space,
        thread: &ChatThreadId,
        kind: crate::ports::ChatThreadKind,
        owner: &PrincipalId,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        use crate::ports::ChatThreadKind;
        if kind != ChatThreadKind::SpaceGroup && owner != &self.principal {
            return Err(DomainError::ResourceNotFound);
        }
        if kind == ChatThreadKind::Personal {
            return self.can_view_own_personal_chat(space, project, tainted);
        }
        if kind == ChatThreadKind::KeeperLog && self.chat_audience == Some(ChatAudience::Shared) {
            return Err(DomainError::ResourceNotFound);
        }
        if (matches!(self.kind, PrincipalKind::Keeper(_)) || self.keeper_log.is_some())
            && (kind != ChatThreadKind::KeeperLog
                || self.keeper_log.as_ref() != Some(thread)
                || self
                    .spaces
                    .get(&space.id)
                    .and_then(|grant| grant.project_root.as_ref())
                    != project)
        {
            return Err(DomainError::ResourceNotFound);
        }
        self.can_view_chat(space, project, tainted)
    }
    /// Marks branch taint after a chat thread has passed visibility checks and is
    /// actually delivered to the caller.
    pub fn mark_chat_read_taint(&self, space: &Space, tainted: bool) {
        if tainted || self.write_space.as_ref().is_some_and(|id| id != &space.id) {
            self.taint.mark_external_read();
        }
    }
    /// Full chat thread read authorization, enforcing Space membership, Personal
    /// thread ownership, ChatAudience::Shared isolation, project pin and taint.
    pub fn authorize_chat_thread_read(
        &self,
        space: &Space,
        thread: &ChatThreadId,
        kind: crate::ports::ChatThreadKind,
        owner: &PrincipalId,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        self.can_view_chat_thread(space, thread, kind, owner, project, tainted)?;
        self.mark_chat_read_taint(space, tainted);
        Ok(())
    }
    /// Chat provenance is separate from document classes. Project-scoped grants
    /// may read only chat transcripts explicitly pinned to their exact project.
    pub fn authorize_chat_read(
        &self,
        space: &Space,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        self.can_view_chat(space, project, tainted)?;
        if tainted || self.write_space.as_ref().is_some_and(|id| id != &space.id) {
            self.taint.mark_external_read();
        }
        Ok(())
    }

    /// Chat visibility check for candidate filtering without recording a read.
    pub fn can_view_chat(
        &self,
        space: &Space,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        if self.is_search_indexing() {
            return Err(DomainError::ResourceNotFound);
        }
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active || grant.read_classes.is_empty() {
            return Err(DomainError::ResourceNotFound);
        }
        if let Some(root) = &grant.project_root
            && project != Some(root)
        {
            return Err(DomainError::ResourceNotFound);
        }
        if tainted && space.kind == SpaceKind::Shared {
            return Err(DomainError::CrossSpaceTainted);
        }
        Ok(())
    }
    /// Confines every write, including personal chat, to the run's admitted Space.
    pub fn authorize_write_space_pin(&self, space: &Space) -> DomainResult<()> {
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active
            || grant.role == SpaceRole::Viewer
            || self.bearer_scope == Some(BearerScope::Read)
            || (matches!(self.kind, PrincipalKind::Pat | PrincipalKind::OAuth { .. })
                && self.bearer_scope != Some(BearerScope::Write))
            || self.is_search_indexing()
            || self
                .write_space
                .as_ref()
                .is_some_and(|pin| pin != &space.id)
        {
            return Err(DomainError::SpaceReadOnly);
        }
        Ok(())
    }

    /// Admission shared by direct document mutations and whole-Space jobs.
    pub fn authorize_space_write(&self, space: &Space) -> DomainResult<()> {
        if self.taint.is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        self.authorize_write_space_pin(space)
    }

    pub fn authorize_direct_write(
        &self,
        before: &ResourceFacts,
        after: &ResourceFacts,
    ) -> DomainResult<()> {
        for resource in [before, after] {
            let grant = self
                .spaces
                .get(&resource.space.id)
                .ok_or(DomainError::ResourceNotFound)?;
            let is_pinned_ability = resource
                .ability_package
                .as_ref()
                .is_some_and(|id| self.readonly_abilities.contains(id));
            if resource.space.lifecycle == SpaceLifecycle::Active
                && (grant
                    .project_root
                    .as_ref()
                    .is_some_and(|root| !resource.ancestor_folders.contains(root))
                    || (matches!(self.kind, PrincipalKind::Keeper(_))
                        && resource.class == DocClass::Skill
                        && !is_pinned_ability))
            {
                return Err(DomainError::ResourceNotFound);
            }
            self.authorize_space_write(&resource.space)?;
            if resource.folder_write_locked || !grant.write_classes.contains(&resource.class) {
                return Err(DomainError::SpaceReadOnly);
            }
            if resource.class == DocClass::Skill || resource.ability_package.is_some() {
                self.authorize_ability_mutation()?;
            }
        }
        if before.space.id != after.space.id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        Ok(())
    }
}

#[cfg(test)]
mod keeper_narrowing_tests {
    use super::*;

    fn sample_human() -> (SpaceId, EngineAuthContext) {
        let space = SpaceId::from_bytes([0x41; 16]);
        let spaces = BTreeMap::from([(
            space.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]);
        let human = VerifiedHuman::attest(
            PrincipalId::from_bytes([0x42; 16]),
            GrantId::from_bytes([0x43; 16]),
            spaces,
            true,
        )
        .with_human_management(true)
        .with_credential(AuthenticatedCredential::Session(AuthSessionId::from_bytes(
            [0x48; 16],
        )));
        (space, EngineAuthContext::for_human(human))
    }

    #[test]
    fn keeper_without_keeper_log_cannot_mint_sub_principals_and_preserves_readonly_abilities() {
        let (space, human) = sample_human();
        let allowed_ability = AbilityId::from_bytes([0x44; 16]);
        let dropped_ability = AbilityId::from_bytes([0x49; 16]);
        let run = AgentRunId::from_bytes([0x45; 16]);
        let keeper = human
            .for_keeper(
                run.clone(),
                space.clone(),
                None,
                BTreeSet::from([allowed_ability.clone(), dropped_ability]),
            )
            .expect("keeper context");
        assert!(keeper.keeper_log().is_none());

        assert!(matches!(
            keeper.for_agent_run(
                AgentRunId::from_bytes([0x46; 16]),
                space.clone(),
                ChatAudience::Personal,
                keeper.spaces().clone(),
            ),
            Err(DomainError::ValidationFailed { diagnostic })
                if diagnostic.reason == ValidationReason::ScopeMismatch
        ));
        assert!(matches!(
            keeper.for_oauth(GrantId::from_bytes([0x47; 16]), keeper.spaces().clone()),
            Err(DomainError::ValidationFailed { diagnostic })
                if diagnostic.reason == ValidationReason::ScopeMismatch
        ));
        assert!(matches!(
            keeper.for_pat(keeper.spaces().clone()),
            Err(DomainError::ValidationFailed { diagnostic })
                if diagnostic.reason == ValidationReason::ScopeMismatch
        ));

        let live_keeper = human
            .for_keeper(run, space, None, BTreeSet::from([allowed_ability.clone()]))
            .expect("live keeper context");
        let intersected = keeper
            .intersect_current(&live_keeper)
            .expect("intersect keeper");
        assert!(matches!(intersected.kind(), PrincipalKind::Keeper(_)));
        assert_eq!(
            intersected.readonly_abilities(),
            &BTreeSet::from([allowed_ability])
        );
        assert!(intersected.keeper_log().is_none());
    }

    #[test]
    fn shared_agent_run_and_single_space_project_pin_mark_spaces_narrowed() {
        let (space, human) = sample_human();
        assert!(!human.is_space_narrowed());

        let shared = human
            .for_agent_run(
                AgentRunId::from_bytes([0x4A; 16]),
                space.clone(),
                ChatAudience::Shared,
                human.spaces().clone(),
            )
            .expect("shared run");
        assert!(shared.is_space_narrowed());

        let project = FolderRef {
            space_id: space,
            folder_id: FolderId::from_bytes([0x4B; 16]),
        };
        let pinned = human.restrict_to_project(&project).expect("project pin");
        assert!(pinned.is_space_narrowed());
    }
}

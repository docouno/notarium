//! Pure authorization policy. Only control adapters may attest authentication facts.
//! These types intentionally do not implement Deserialize.
use crate::{DomainError, DomainResult, classes::DocClass, error::ValidationReason, ids::*};
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
    human_management: bool,
    ability_write: bool,
    write_space: Option<SpaceId>,
    chat_audience: Option<ChatAudience>,
    taint: BranchTaint,
    readonly_abilities: BTreeSet<AbilityId>,
    credential: Option<AuthenticatedCredential>,
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
            human_management: verified.human_management,
            ability_write: verified.human_management && verified.ability_write,
            write_space: None,
            chat_audience: None,
            taint: BranchTaint::default(),
            readonly_abilities: BTreeSet::new(),
            credential: verified.credential,
        }
    }
    pub fn for_agent_run(
        &self,
        run: AgentRunId,
        thread_space: SpaceId,
        audience: ChatAudience,
        requested: BTreeMap<SpaceId, SpaceGrant>,
    ) -> DomainResult<Self> {
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
            derived.taint = BranchTaint::default();
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
        let mut derived = self.for_agent_run(
            run.clone(),
            space.clone(),
            ChatAudience::Personal,
            BTreeMap::from([(space, grant)]),
        )?;
        derived.kind = PrincipalKind::Keeper(run);
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
        let mut derived = self.narrow(requested)?;
        derived.kind = PrincipalKind::OAuth {
            source,
            narrowed: true,
        };
        Ok(derived)
    }
    /// Personal access tokens are delegated credentials, never interactive humans.
    pub fn for_pat(&self, requested: BTreeMap<SpaceId, SpaceGrant>) -> DomainResult<Self> {
        let mut derived = self.narrow(requested)?;
        derived.kind = PrincipalKind::Pat;
        Ok(derived)
    }
    fn narrow(&self, requested: BTreeMap<SpaceId, SpaceGrant>) -> DomainResult<Self> {
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
        Ok(Self {
            spaces,
            human_management: false,
            ability_write: false,
            ..self.clone()
        })
    }
    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }
    /// The authentication owner supplies freshly verified durable authority.
    /// Keep the caller's delegation, project pin, taint and write-Space pin while
    /// intersecting current permissions; refreshing cannot widen an old context.
    pub fn intersect_current(&self, current: &Self) -> DomainResult<Self> {
        if self.principal != current.principal
            || self.grant != current.grant
            || self.credential != current.credential
            || self.credential.is_none()
        {
            return Err(DomainError::AuthenticationFailed);
        }
        let requested = current
            .spaces
            .iter()
            .filter_map(|(id, fresh)| {
                self.spaces.get(id).map(|old| {
                    let mut wanted = fresh.clone();
                    wanted.project_root = old.project_root.clone();
                    (id.clone(), wanted)
                })
            })
            .collect();
        let mut result = self.narrow(requested)?;
        result.human_management = self.human_management && current.human_management;
        result.ability_write =
            result.human_management && self.ability_write && current.ability_write;
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
    pub fn kind(&self) -> &PrincipalKind {
        &self.kind
    }
    pub fn readonly_abilities(&self) -> &BTreeSet<AbilityId> {
        &self.readonly_abilities
    }
    pub fn spaces(&self) -> &BTreeMap<SpaceId, SpaceGrant> {
        &self.spaces
    }
    pub fn taint(&self) -> &BranchTaint {
        &self.taint
    }
    pub fn human_management(&self) -> bool {
        self.human_management && self.kind == PrincipalKind::DirectHuman
    }
    pub fn authorize_human_management(&self) -> DomainResult<()> {
        if self.human_management() {
            Ok(())
        } else {
            Err(DomainError::AccessDenied)
        }
    }
    pub fn has_cap(&self, cap: Cap) -> bool {
        match cap {
            Cap::AbilityWrite => self.ability_write && self.human_management(),
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
    /// Metadata visibility check for a chat thread that never mutates shared branch taint.
    /// Content reading and backlink delivery must call `mark_chat_read_taint`
    /// (or `authorize_chat_thread_read`) only for admitted rows.
    pub fn can_view_chat_thread(
        &self,
        space: &Space,
        kind: crate::ports::ChatThreadKind,
        owner: &PrincipalId,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound);
        }
        if kind == crate::ports::ChatThreadKind::Personal
            && (owner != &self.principal
                || self.chat_audience == Some(ChatAudience::Shared)
                || (matches!(self.kind, PrincipalKind::Keeper(_))
                    && space.kind == SpaceKind::Shared))
        {
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
        kind: crate::ports::ChatThreadKind,
        owner: &PrincipalId,
        project: Option<&FolderId>,
        tainted: bool,
    ) -> DomainResult<()> {
        self.can_view_chat_thread(space, kind, owner, project, tainted)?;
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
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active {
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
        if tainted || self.write_space.as_ref().is_some_and(|id| id != &space.id) {
            self.taint.mark_external_read();
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
            self.authorize_space_write(&resource.space)?;
            let grant = &self.spaces[&resource.space.id];
            if resource.folder_write_locked
                || !grant.write_classes.contains(&resource.class)
                || grant
                    .project_root
                    .as_ref()
                    .is_some_and(|root| !resource.ancestor_folders.contains(root))
            {
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

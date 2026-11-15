//! Pure authorization policy. Only control adapters may attest authentication facts.
//! These types intentionally do not implement Deserialize.
use crate::{DomainError, DomainResult, classes::DocClass, error::ValidationReason, ids::*};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

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
    ability_write: bool,
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
            ability_write: explicitly_authorized_ability_write,
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
    ability_write: bool,
    write_space: Option<SpaceId>,
    taint: BranchTaint,
    readonly_abilities: BTreeSet<AbilityId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatAudience {
    Personal,
    Shared,
}

/// Canonical resource facts, including ancestry, are supplied by the storage owner.
#[derive(Clone, Debug)]
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
            ability_write: verified.ability_write,
            write_space: None,
            taint: BranchTaint::default(),
            readonly_abilities: BTreeSet::new(),
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
        if audience == ChatAudience::Shared {
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
        derived.readonly_abilities = readonly_abilities;
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
            ability_write: false,
            ..self.clone()
        })
    }
    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }
    pub fn grant(&self) -> &GrantId {
        &self.grant
    }
    pub fn kind(&self) -> &PrincipalKind {
        &self.kind
    }
    pub fn spaces(&self) -> &BTreeMap<SpaceId, SpaceGrant> {
        &self.spaces
    }
    pub fn taint(&self) -> &BranchTaint {
        &self.taint
    }
    pub fn has_cap(&self, cap: Cap) -> bool {
        match cap {
            Cap::AbilityWrite => self.ability_write && self.kind == PrincipalKind::DirectHuman,
        }
    }
    pub fn authorize_ability_mutation(&self) -> DomainResult<()> {
        if self.has_cap(Cap::AbilityWrite) {
            Ok(())
        } else {
            Err(DomainError::AbilityWriteForbidden)
        }
    }
    pub fn authorize_read(&self, resource: &ResourceFacts) -> DomainResult<()> {
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
        if self
            .write_space
            .as_ref()
            .is_some_and(|space| space != &resource.space.id)
        {
            self.taint.mark_external_read();
        }
        Ok(())
    }
    /// Chat provenance is separate from document classes. Project-scoped service
    /// grants do not gain access to whole-space transcripts through this path.
    pub fn authorize_chat_read(&self, space: &Space, tainted: bool) -> DomainResult<()> {
        let grant = self
            .spaces
            .get(&space.id)
            .ok_or(DomainError::ResourceNotFound)?;
        if space.lifecycle != SpaceLifecycle::Active || grant.project_root.is_some() {
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
    pub fn authorize_direct_write(
        &self,
        before: &ResourceFacts,
        after: &ResourceFacts,
    ) -> DomainResult<()> {
        if self.taint.is_tainted() {
            return Err(DomainError::CrossSpaceTainted);
        }
        for resource in [before, after] {
            let grant = self
                .spaces
                .get(&resource.space.id)
                .ok_or(DomainError::ResourceNotFound)?;
            if self
                .write_space
                .as_ref()
                .is_some_and(|space| space != &resource.space.id)
                || resource.space.lifecycle != SpaceLifecycle::Active
                || grant.role == SpaceRole::Viewer
                || resource.folder_write_locked
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

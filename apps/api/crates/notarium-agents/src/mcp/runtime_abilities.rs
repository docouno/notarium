//! Resolve runtime ability packages and keep their canonical provenance through dispatch.
use std::collections::{BTreeMap, btree_map::Entry};

use notarium_core::{
    DomainError,
    auth::{PrincipalKind, SpaceLifecycle},
    classes::{AbilityKind, ClassEgressFence, ProviderMessage},
    error::{PortError, ValidationReason},
    ids::{EpisodeId, FolderId, SpaceId},
    model::{AbilityResourceName, FolderRef, Lifecycle},
    ports::{
        AbilityDescriptor, AbilityPlacement, AbilityProjects, AbilityRef, AccountContext,
        CallBudget, EpisodeDiagnostic, EpisodeLifecycle, MAX_ATTACHED_SKILLS,
        MAX_PROVIDER_SECONDARY_PROJECTS, PreferenceModelKind, ProviderSelection, SelectProvider,
        SpaceContext,
    },
};
use tokio::time::Instant;

use crate::abilities::read_system_ability;

use super::{ToolRegistry, ability_tools::read_exact_resource, corpus, invalid};

#[derive(Default)]
pub struct RuntimeAbilities {
    pub parts: Vec<ProviderMessage>,
    pub secondary_projects: Vec<FolderRef>,
}

/// The episode projection follows the committed placement trail and overlays
/// current bindings and preferences before returning the effective role.
pub async fn interactive(
    registry: &ToolRegistry,
    primary: &SpaceContext,
    selection: &ProviderSelection,
    episode: &EpisodeId,
) -> Result<RuntimeAbilities, PortError> {
    if !matches!(primary.auth().kind(), PrincipalKind::AgentRun(_))
        || primary.auth().pinned_write_space() != Some(&primary.scope().space_id)
    {
        return Err(DomainError::AccessDenied.into());
    }
    let reader = Reader::new(registry, primary, selection)?;
    let current = registry
        .control
        .get_episode(reader.account(), episode.clone())
        .await?;
    if &current.id != episode || &current.owner != primary.auth().principal() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if current.lifecycle != EpisodeLifecycle::Active
        || current
            .diagnostics
            .contains(&EpisodeDiagnostic::RoleUnavailable)
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let Some(reference) = current.active_role else {
        return Ok(RuntimeAbilities::default());
    };
    let hint = current.project_hint.as_ref().or(selection.project.as_ref());
    let role_project = match &reference.placement {
        AbilityPlacement::OwnedProject(project) => Some(project),
        AbilityPlacement::OwnedSpace(space) => hint.filter(|project| &project.space_id == space),
        _ => hint,
    };
    let role = registry
        .control
        .get_ability(reader.account(), reference.clone(), role_project.cloned())
        .await?;
    validate_descriptor(&role, AbilityKind::Role)?;
    validate_attachments(&role.attached_skills)?;

    let mut descriptors = Vec::with_capacity(role.attached_skills.len() + 1);
    for dependency in &role.attached_skills {
        let inspection = match registry
            .control
            .inspect_ability(reader.account(), dependency.identity())
            .await
        {
            Ok(inspection) => inspection,
            Err(error) if corpus::hidden(&error) => continue,
            Err(error) => return Err(error),
        };
        if inspection.descriptor.reference.identity() != dependency.identity() {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        if !inspection.binding_enabled
            || !inspection.preference_enabled
            || !inspection.descriptor.enabled
            || !inspection.descriptor.healthy
            || matches!(&inspection.availability, AbilityProjects::Selected(projects)
                if !role_project.is_some_and(|project| projects.contains(project)))
        {
            continue;
        }
        validate_descriptor(&inspection.descriptor, AbilityKind::Skill)?;
        descriptors.push(inspection.descriptor);
    }
    reader.load(role, descriptors, role_project).await
}

/// A scheduled run already carries exact approved references and its scoped
/// credential. Reading it never opens a human account session or episode.
pub async fn keeper(
    registry: &ToolRegistry,
    primary: &SpaceContext,
    selection: &ProviderSelection,
    role: &AbilityRef,
    skills: &[AbilityRef],
) -> Result<RuntimeAbilities, PortError> {
    if !matches!(primary.auth().kind(), PrincipalKind::Keeper(_))
        || primary.auth().taint().is_tainted()
        || primary.auth().pinned_write_space() != Some(&primary.scope().space_id)
    {
        return Err(DomainError::AccessDenied.into());
    }
    let project_root = primary
        .auth()
        .spaces()
        .get(&primary.scope().space_id)
        .and_then(|grant| grant.project_root.as_ref());
    if selection.project.as_ref().map(|project| &project.folder_id) != project_root {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let reader = Reader::new(registry, primary, selection)?;
    validate_attachments(skills)?;
    let role = reader.approved(role, AbilityKind::Role).await?;
    validate_attachments(&role.attached_skills)?;
    if role.attached_skills.len() != skills.len()
        || !role.attached_skills.iter().all(|attached| {
            skills
                .iter()
                .any(|approved| approved.identity() == attached.identity())
        })
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let mut descriptors = Vec::with_capacity(skills.len());
    for approved in skills {
        descriptors.push(reader.approved(approved, AbilityKind::Skill).await?);
    }
    reader
        .load(role, descriptors, selection.project.as_ref())
        .await
}

fn validate_descriptor(descriptor: &AbilityDescriptor, kind: AbilityKind) -> Result<(), PortError> {
    if descriptor.kind != kind
        || (descriptor.reference.placement == AbilityPlacement::System)
            != descriptor.entrypoint.is_none()
        || kind == AbilityKind::Skill && !descriptor.attached_skills.is_empty()
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if descriptor.lifecycle != Lifecycle::Active || !descriptor.enabled || !descriptor.healthy {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

fn validate_attachments(skills: &[AbilityRef]) -> Result<(), PortError> {
    if skills.len() > MAX_ATTACHED_SKILLS
        || skills.iter().enumerate().any(|(index, skill)| {
            skills[..index]
                .iter()
                .any(|other| other.identity() == skill.identity())
        })
    {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(())
}

struct Reader<'a> {
    registry: &'a ToolRegistry,
    primary: &'a SpaceContext,
    selection: &'a ProviderSelection,
    deadline: Instant,
}

impl<'a> Reader<'a> {
    fn new(
        registry: &'a ToolRegistry,
        primary: &'a SpaceContext,
        selection: &'a ProviderSelection,
    ) -> Result<Self, PortError> {
        check_selection(primary, selection, selection, selection.project.as_ref())?;
        Ok(Self {
            registry,
            primary,
            selection,
            deadline: Instant::now() + primary.budget.remaining,
        })
    }

    fn budget(&self) -> CallBudget {
        CallBudget {
            remaining: self.deadline.saturating_duration_since(Instant::now()),
            ..self.primary.budget.clone()
        }
    }

    fn account(&self) -> AccountContext {
        AccountContext::new(self.primary.auth().clone(), self.budget())
    }

    async fn source(&self, space: &SpaceId) -> Result<SpaceContext, PortError> {
        if space == &self.primary.scope().space_id {
            let mut current = self.primary.clone();
            current.budget = self.budget();
            return Ok(current);
        }
        if !self.primary.auth().spaces().contains_key(space) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let live = self
            .registry
            .catalog
            .space(self.budget(), space.clone())
            .await?;
        if &live.space.id != space || &live.history.space_id != space {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        if live.space.lifecycle != SpaceLifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(SpaceContext::new(
            self.primary.auth().clone(),
            live.history,
            self.budget(),
        )?)
    }

    async fn approved(
        &self,
        reference: &AbilityRef,
        kind: AbilityKind,
    ) -> Result<AbilityDescriptor, PortError> {
        if !self
            .primary
            .auth()
            .readonly_abilities()
            .contains(&reference.id)
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let current = self
            .registry
            .catalog
            .current_ability(self.account(), reference.identity())
            .await?;
        if current.reference.identity() != reference.identity() {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        if current.reference.revision != reference.revision {
            return Err(DomainError::RoleModifiedReconsent {
                approved: reference.revision.clone(),
                current: current.reference.revision,
            }
            .into());
        }
        validate_descriptor(&current, kind)?;
        if current
            .entrypoint
            .as_ref()
            .is_some_and(|entry| entry.space_id != self.primary.scope().space_id)
            || matches!(&reference.placement, AbilityPlacement::OwnedProject(project) if self.selection.project.as_ref() != Some(project))
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(current)
    }

    async fn load(
        &self,
        role: AbilityDescriptor,
        skills: Vec<AbilityDescriptor>,
        hint: Option<&FolderRef>,
    ) -> Result<RuntimeAbilities, PortError> {
        let mut result = RuntimeAbilities::default();
        let mut secondary = BTreeMap::<(SpaceId, Option<FolderId>), ProviderSelection>::new();
        for descriptor in std::iter::once(role).chain(skills) {
            let part = if let Some(entry) = &descriptor.entrypoint {
                let mut source = self.source(&entry.space_id).await?;
                let project =
                    ability_project(&descriptor.reference.placement, &entry.space_id, hint)?;
                let selection = if source.scope().space_id == self.primary.scope().space_id {
                    self.selection
                } else {
                    let key = (
                        entry.space_id.clone(),
                        project.map(|project| project.folder_id.clone()),
                    );
                    match secondary.entry(key) {
                        Entry::Occupied(existing) => existing.into_mut(),
                        Entry::Vacant(available) => {
                            let chosen = self
                                .registry
                                .control
                                .select_provider(
                                    source.clone(),
                                    SelectProvider {
                                        kind: PreferenceModelKind::Completion,
                                        resource: Some(self.selection.provider.clone()),
                                        model: Some(self.selection.model.clone()),
                                        project: project.cloned(),
                                    },
                                )
                                .await?;
                            check_selection(&source, self.selection, &chosen, project)?;
                            if let Some(project) = &chosen.project {
                                if result.secondary_projects.len()
                                    >= MAX_PROVIDER_SECONDARY_PROJECTS
                                {
                                    return Err(invalid(ValidationReason::InvalidLimit));
                                }
                                result.secondary_projects.push(project.clone());
                            }
                            available.insert(chosen)
                        }
                    }
                };
                source.budget = self.budget();
                let body = read_exact_resource(
                    self.registry,
                    &source,
                    &descriptor,
                    AbilityResourceName::Entrypoint,
                )
                .await?;
                if selection
                    .project_only
                    .as_ref()
                    .is_some_and(|project| !body.in_project(project))
                {
                    return Err(DomainError::AccessDenied.into());
                }
                ProviderMessage::Ability(ClassEgressFence::ability(
                    body,
                    source.auth(),
                    &selection.policy,
                )?)
            } else {
                let builtin = read_system_ability(&self.account(), &descriptor.reference)?;
                ProviderMessage::SystemAbility(ClassEgressFence::system_ability(
                    builtin,
                    &self.selection.policy,
                )?)
            };
            result.parts.push(part);
        }
        Ok(result)
    }
}

fn check_selection(
    scope: &SpaceContext,
    primary: &ProviderSelection,
    selected: &ProviderSelection,
    project: Option<&FolderRef>,
) -> Result<(), PortError> {
    if selected.provider != primary.provider
        || selected.policy.provider != primary.provider
        || selected.model != primary.model
        || selected.project.as_ref() != project
        || project.is_some_and(|project| project.space_id != scope.scope().space_id)
        || selected
            .project_only
            .as_ref()
            .is_some_and(|limit| Some(limit) != project)
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(())
}

fn ability_project<'a>(
    placement: &'a AbilityPlacement,
    space: &SpaceId,
    hint: Option<&'a FolderRef>,
) -> Result<Option<&'a FolderRef>, PortError> {
    match placement {
        AbilityPlacement::OwnedProject(project) if &project.space_id == space => Ok(Some(project)),
        AbilityPlacement::OwnedProject(_) | AbilityPlacement::System => {
            Err(invalid(ValidationReason::SourceMismatch))
        }
        AbilityPlacement::OwnedSpace(owner) if owner != space => {
            Err(invalid(ValidationReason::SourceMismatch))
        }
        _ => Ok(hint.filter(|project| &project.space_id == space)),
    }
}

use super::*;
use notarium_core::{classes::AbilityKind, model::Lifecycle};

#[derive(Clone, Copy)]
pub(super) struct ScheduleScope<'a> {
    pub space: &'a SpaceId,
    pub project: Option<&'a FolderRef>,
}

impl<'a> From<&'a ScheduleDefinition> for ScheduleScope<'a> {
    fn from(definition: &'a ScheduleDefinition) -> Self {
        Self {
            space: &definition.space,
            project: definition.project.as_ref(),
        }
    }
}

impl ScheduleScope<'_> {
    pub(super) fn check(self, auth: &EngineAuthContext) -> Result<(), PortError> {
        let grant = auth
            .spaces()
            .get(self.space)
            .ok_or(DomainError::ResourceNotFound)?;
        if self
            .project
            .is_some_and(|project| &project.space_id != self.space)
        {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        if grant
            .project_root
            .as_ref()
            .is_some_and(|root| self.project.map(|project| &project.folder_id) != Some(root))
        {
            return Err(access_denied());
        }
        if grant.role == SpaceRole::Viewer || !grant.write_classes.contains(&DocClass::AgentMemory)
        {
            return Err(access_denied());
        }
        if auth.taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        Ok(())
    }

    pub(super) fn keeper(
        self,
        auth: &EngineAuthContext,
        run: AgentRunId,
        ability_ids: BTreeSet<AbilityId>,
    ) -> Result<EngineAuthContext, PortError> {
        self.check(auth)?;
        Ok(auth.for_keeper(
            run,
            self.space.clone(),
            self.project.map(|p| p.folder_id.clone()),
            ability_ids,
        )?)
    }

    pub(super) fn includes(self, placement: &AbilityPlacement) -> bool {
        match placement {
            AbilityPlacement::OwnedProject(folder) => self.project == Some(folder),
            AbilityPlacement::OwnedSpace(space) => self.space == space,
            AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => true,
        }
    }

    fn includes_descriptor(self, descriptor: &AbilityDescriptor, kind: AbilityKind) -> bool {
        self.includes(&descriptor.reference.placement)
            && descriptor.kind == kind
            && descriptor.lifecycle == Lifecycle::Active
            && descriptor.healthy
            && match &descriptor.reference.placement {
                AbilityPlacement::System => descriptor.entrypoint.is_none(),
                _ => descriptor
                    .entrypoint
                    .as_ref()
                    .is_some_and(|entry| &entry.space_id == self.space),
            }
    }
}

pub(super) fn package_ids(role: &AbilityRef, skills: &[AbilityRef]) -> BTreeSet<AbilityId> {
    std::iter::once(role.id.clone())
        .chain(skills.iter().map(|skill| skill.id.clone()))
        .collect()
}

fn valid_skill_set(skills: &[AbilityRef]) -> bool {
    skills.len() <= MAX_ATTACHED_SKILLS
        && skills.iter().enumerate().all(|(index, skill)| {
            skills[..index]
                .iter()
                .all(|other| skill.identity() != other.identity())
        })
}

fn package_refs(role: &AbilityRef, skills: &[AbilityRef]) -> Vec<AbilityRef> {
    std::iter::once(role.clone())
        .chain(skills.iter().cloned())
        .collect()
}

struct ApprovalRefs<'a> {
    role: &'a AbilityRef,
    skills: &'a [AbilityRef],
}

impl ApprovalRefs<'_> {
    fn matches(&self, scope: ScheduleScope<'_>, descriptors: &[AbilityDescriptor]) -> bool {
        if !valid_skill_set(self.skills) || descriptors.len() != self.skills.len() + 1 {
            return false;
        }
        let Some(role) = descriptors.iter().find(|item| &item.reference == self.role) else {
            return false;
        };
        scope.includes_descriptor(role, AbilityKind::Role)
            && valid_skill_set(&role.attached_skills)
            && role.attached_skills.len() == self.skills.len()
            && self.skills.iter().all(|skill| {
                role.attached_skills
                    .iter()
                    .any(|attached| attached.identity() == skill.identity())
                    && descriptors.iter().any(|item| {
                        &item.reference == skill
                            && item.attached_skills.is_empty()
                            && scope.includes_descriptor(item, AbilityKind::Skill)
                    })
            })
    }
}

impl ControlService {
    pub async fn schedule_ability_candidate(
        &self,
        ctx: AccountContext,
        selection: ScheduleAbilitySelection,
    ) -> Result<ScheduleAbilityCandidate, PortError> {
        ctx.auth().authorize_human_management()?;
        let scope = ScheduleScope {
            space: &selection.space,
            project: selection.project.as_ref(),
        };
        let budget = OperationBudget::new(ctx.budget.clone());
        let (rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        if !scope.includes(&selection.role.placement) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let run = AgentRunId::from_bytes([0; 16]);
        let role_auth = scope.keeper(&auth, run.clone(), [selection.role.id.clone()].into())?;
        let role_ctx = AccountContext::new(role_auth, budget.context(ctx.budget.request.clone()));
        let (role, skills, mut lease) = budget
            .run(
                async {
                    self.schedule_history(&role_ctx, scope).await?;
                    let role = self.raw_ability(&role_ctx, selection.role).await?;
                    if !scope.includes_descriptor(&role, AbilityKind::Role)
                        || !valid_skill_set(&role.attached_skills)
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let reviewer = scope.keeper(
                        &auth,
                        run,
                        package_ids(&role.reference, &role.attached_skills),
                    )?;
                    let reviewer =
                        AccountContext::new(reviewer, budget.context(ctx.budget.request.clone()));
                    let mut skills = Vec::with_capacity(role.attached_skills.len());
                    for reference in &role.attached_skills {
                        if !scope.includes(&reference.placement) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let live = self.raw_ability(&reviewer, reference.identity()).await?;
                        skills.push(live.reference);
                    }
                    let lease = self
                        .pin_schedule_approval(reviewer, scope, &role.reference, &skills)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    Ok((role.reference, skills, lease))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let (mut rtx, fresh) = match self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await
        {
            Ok(pair) => pair,
            Err(error) => {
                let _ = lease.close().await;
                return Err(error);
            }
        };
        let fresh_ctx = AccountContext::new(fresh, budget.context(ctx.budget.request.clone()));
        let approved = lease.abilities();
        let candidate = budget
            .run(
                async {
                    scope.check(fresh_ctx.auth())?;
                    let owner =
                        user_read(rtx.inner_mut(), fresh_ctx.auth().principal().as_str()).await?;
                    if !self
                        .verify_schedule_approval_db(rtx.inner_mut(), &fresh_ctx, scope, approved)
                        .await?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    Ok(ScheduleAbilityCandidate {
                        account_revision: ControlRevision::new(owner.revision as u64)?,
                        approved_role: role,
                        approved_skills: skills,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await;
        let finish = budget.run(rtx.finish(), CommitEffect::NotCommitted).await;
        let _ = lease.close().await;
        finish?;
        candidate
    }

    pub(super) async fn schedule_history(
        &self,
        ctx: &AccountContext,
        scope: ScheduleScope<'_>,
    ) -> Result<HistoryScope, PortError> {
        let history = self.catalog_space(ctx, scope.space).await?.history;
        if let Some(project) = scope.project {
            self.catalog_project(ctx, project).await?;
        }
        Ok(history)
    }

    pub(super) async fn pin_schedule_approval(
        &self,
        ctx: AccountContext,
        scope: ScheduleScope<'_>,
        role: &AbilityRef,
        skills: &[AbilityRef],
    ) -> Result<Option<Box<dyn ScheduleAbilityLease>>, PortError> {
        if !scope.includes(&role.placement)
            || !valid_skill_set(skills)
            || skills.iter().any(|skill| {
                !scope.includes(&skill.placement) || skill.identity() == role.identity()
            })
        {
            return Ok(None);
        }
        let mut lease = match self
            .catalog
            .pin_schedule_abilities(ctx, package_refs(role, skills))
            .await
        {
            Ok(lease) => lease,
            Err(error) if hidden(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        if lease.history().space_id == *scope.space
            && (ApprovalRefs { role, skills }).matches(scope, lease.abilities())
        {
            Ok(Some(lease))
        } else {
            let _ = lease.close().await;
            Ok(None)
        }
    }

    pub(super) async fn verify_schedule_approval_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        scope: ScheduleScope<'_>,
        descriptors: &[AbilityDescriptor],
    ) -> Result<bool, PortError> {
        for descriptor in descriptors {
            // Trail and availability may change independently of canonical
            // package revisions. Observe both in the control transaction.
            let inspected = async {
                let reference = &descriptor.reference;
                let followed = self.follow_ability_db(tx, ctx, reference.clone()).await?;
                if &followed != reference {
                    return Ok(false);
                }
                Ok::<_, PortError>(
                    self.overlay(tx, ctx, descriptor.clone(), scope.project)
                        .await?
                        .enabled,
                )
            }
            .await;
            match inspected {
                Ok(true) => (),
                Ok(false) => return Ok(false),
                Err(error) if hidden(&error) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }

    /// Non-owning probe for credential revalidation. Provider dispatch already
    /// holds a canonical disclosure lease and checks these exact origins there.
    pub(super) async fn probe_schedule_approval(
        &self,
        ctx: &AccountContext,
        scope: ScheduleScope<'_>,
        role: &AbilityRef,
        skills: &[AbilityRef],
    ) -> Result<Vec<AbilityDescriptor>, PortError> {
        let mut descriptors = Vec::with_capacity(skills.len() + 1);
        for reference in package_refs(role, skills) {
            let current = self.raw_ability(ctx, reference.identity()).await?;
            if current.reference != reference {
                return Err(DomainError::RoleModifiedReconsent {
                    approved: reference.revision,
                    current: current.reference.revision,
                }
                .into());
            }
            descriptors.push(current);
        }
        if !(ApprovalRefs { role, skills }).matches(scope, &descriptors) {
            return Err(denied());
        }
        Ok(descriptors)
    }

    pub(super) async fn precheck_schedule_definition(
        &self,
        ctx: &AccountContext,
        budget: &OperationBudget,
        definition: &ScheduleDefinition,
        skills: &[AbilityRef],
    ) -> Result<Box<dyn ScheduleAbilityLease>, PortError> {
        let (rtx, auth) = self
            .open_revalidated_read(budget, &ctx.budget.request, ctx.auth())
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let scope = ScheduleScope::from(definition);
        let keeper = scope.keeper(
            &auth,
            AgentRunId::from_bytes([0; 16]),
            package_ids(&definition.approved_role, skills),
        )?;
        let limited = AccountContext::new(keeper, budget.context(ctx.budget.request.clone()));
        budget
            .run(
                async {
                    self.pin_schedule_approval(limited, scope, &definition.approved_role, skills)
                        .await?
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
}

use super::*;
use crate::service::commands::{Command, SavedResult};
use crate::store::statements::execute;
use notarium_core::auth::{PrincipalKind, SpaceRole};
use std::collections::BTreeSet;

impl ControlService {
    async fn lock_ability_spaces(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        owner: &UsersRow,
        references: &[&AbilityRef],
    ) -> Result<BTreeSet<SpaceId>, PortError> {
        ctx.auth().authorize_ability_mutation()?;
        if ctx.auth().kind() != &PrincipalKind::DirectHuman {
            return Err(access_denied());
        }
        self.live_human(tx, ctx.auth(), owner).await?;
        let mut spaces = BTreeSet::new();
        for reference in references {
            let space = match &reference.placement {
                AbilityPlacement::OwnedSpace(space) => space.clone(),
                AbilityPlacement::OwnedProject(project) => project.space_id.clone(),
                AbilityPlacement::OwnedPersonal(id) if id == ctx.auth().principal() => {
                    SpaceId::parse(
                        owner
                            .personal_space_id
                            .as_deref()
                            .ok_or(DomainError::ResourceNotFound)?,
                    )?
                }
                _ => return Err(access_denied()),
            };
            if ctx.auth().spaces().get(&space).is_none_or(|grant| grant.role == SpaceRole::Viewer || !grant.write_classes.contains(&DocClass::Skill) || grant.project_root.as_ref().is_some_and(|root| !matches!(&reference.placement, AbilityPlacement::OwnedProject(project) if &project.folder_id == root))) {
                return Err(access_denied());
            }
            spaces.insert(space);
        }
        // No shared Space admission precedes these exclusive locks.
        for space in &spaces {
            let admission = crate::service::spaces::admission(tx, space, true).await?;
            let member = rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),&owner.user_id)?.ok_or_else(access_denied)?;
            if admission.state != "active"
                || member.admission != "active"
                || !matches!(member.role.as_str(), "owner" | "editor")
            {
                return Err(access_denied());
            }
        }
        Ok(spaces)
    }
    async fn bump_ability_state(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        spaces: &BTreeSet<SpaceId>,
    ) -> Result<ControlRevision, PortError> {
        for space in spaces {
            let current = crate::service::spaces::admission(tx, space, false).await?;
            execute!(tx,"UPDATE space_admission SET revision=$1 WHERE space_id=$2","UPDATE v1_control.space_admission SET revision=$1 WHERE space_id=$2";next(current.revision)?,space.as_str())?;
        }
        let revision = next(owner.revision)?;
        execute!(tx,"UPDATE users SET revision=$1,metadata_revision=$2 WHERE user_id=$3","UPDATE v1_control.users SET revision=$1,metadata_revision=$2 WHERE user_id=$3";revision,next(owner.metadata_revision)?,&owner.user_id)?;
        Ok(ControlRevision::new(revision as u64)?)
    }
    pub async fn update_ability_binding(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityBindingUpdate>,
    ) -> Result<ControlCommit<AbilityDescriptor>, PortError> {
        if matches!(&request.input.projects, AbilityProjects::Selected(values) if values.len() > 200)
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let command = Command::new(request.identity, "update-ability-binding", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_ability_mutation()?;
        if ctx.auth().kind() != &PrincipalKind::DirectHuman {
            return Err(access_denied());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let value = budget
            .run(
                self.raw_ability(&current, request.input.ability.identity()),
                CommitEffect::NotCommitted,
            )
            .await?;
        if value.reference != request.input.ability {
            return Err(DomainError::ResourceNotFound.into());
        }
        if let AbilityProjects::Selected(projects) = &request.input.projects {
            let mut seen = BTreeSet::new();
            for project in projects {
                if !seen.insert((project.space_id.clone(), project.folder_id.clone())) {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
                budget
                    .run(
                        self.catalog_project(&current, project),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
            }
        }
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, value) = budget.run(async {
            let owner = user(tx.inner_mut(), ctx.auth().principal().as_str()).await?;
            let spaces = self.lock_ability_spaces(tx.inner_mut(), &ctx, &owner, &[&request.input.ability]).await?;
            let key = placement(&request.input.ability.placement)?;
            let project = match &request.input.ability.placement { AbilityPlacement::OwnedProject(project) => Some(project), _ => None };
            if let Some((revision, _)) = command.replay::<AbilityRef>(tx.inner_mut()).await? {
                return Ok((revision, self.overlay(tx.inner_mut(), &ctx, value, project).await?));
            }
            expect_revision(&owner, command.identity.expected)?;
            let old = rows!(tx.inner_mut(),AbilityAvailabilityRow,fetch_optional,"SELECT * FROM ability_availability WHERE placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";&key,request.input.ability.id.as_str())?;
            let previous = old.as_ref().map_or(0, |row| row.revision);
            if previous as u64 != request.input.expected.get() { return Err(DomainError::ControlRevisionConflict { current: ControlRevision::new(previous as u64)? }.into()); }
            let mode = match &request.input.projects { AbilityProjects::All => "all-projects", AbilityProjects::Selected(_) => "selected-projects" };
            let row = AbilityAvailabilityRow { placement: key.clone(), ability_id: request.input.ability.id.to_string(), mode: mode.into(), enabled: i64::from(request.input.enabled), revision: next(previous)? };
            TargetRecord::from(row.clone()).validate()?;
            execute!(tx.inner_mut(),"INSERT INTO ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision",
                "INSERT INTO v1_control.ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision";&key,&row.ability_id,mode,row.enabled,row.revision)?;
            execute!(tx.inner_mut(),"DELETE FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2";&key,&row.ability_id)?;
            if let AbilityProjects::Selected(projects) = &request.input.projects {
                let mut seen = BTreeSet::new();
                for project in projects {
                    if !spaces.contains(&project.space_id) || !seen.insert((project.space_id.clone(), project.folder_id.clone())) { return Err(invalid(ValidationReason::ScopeMismatch)); }
                    let record = TargetRecord::from(AbilityProjectBindingsRow { placement: key.clone(), ability_id: row.ability_id.clone(), target_space: project.space_id.to_string(), project_id: project.folder_id.to_string() });
                    record.validate()?; record.insert(tx.inner_mut()).await?;
                }
            }
            let revision = self.bump_ability_state(tx.inner_mut(), &owner, &spaces).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: request.input.ability.clone(), events: vec![] }, self.clock.now_ms()?).await?;
            Ok((revision, self.overlay(tx.inner_mut(), &ctx, value, project).await?))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit { revision, value })
    }
    pub async fn set_ability_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityPreferenceUpdate>,
    ) -> Result<ControlCommit<AbilityPreferenceUpdate>, PortError> {
        let command = Command::new(request.identity, "set-ability-preference", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_human_management()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let value = budget
            .run(
                self.raw_ability(&current, request.input.ability.identity()),
                CommitEffect::NotCommitted,
            )
            .await?;
        if value.reference != request.input.ability {
            return Err(DomainError::ResourceNotFound.into());
        }
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            auth.authorize_human_management()?;
            if let Some(replay) = command.replay::<AbilityPreferenceUpdate>(tx.inner_mut()).await? { return Ok(replay); }
            let owner = user(tx.inner_mut(), auth.principal().as_str()).await?;
            expect_revision(&owner, command.identity.expected)?;
            let key = placement(&request.input.ability.placement)?;
            let revision = self.bump_ability_state(tx.inner_mut(), &owner, &BTreeSet::new()).await?;
            execute!(tx.inner_mut(),"INSERT INTO ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,ability_id,placement) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision",
                "INSERT INTO v1_control.ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,ability_id,placement) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision";&owner.user_id,request.input.ability.id.as_str(),&key,i64::from(request.input.enabled),revision.get() as i64)?;
            let saved = SavedResult { value: request.input.clone(), events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, self.clock.now_ms()?).await?;
            Ok((revision, saved))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
    pub async fn set_ability_trail(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityTrailUpdate>,
    ) -> Result<ControlCommit<AbilityTrailUpdate>, PortError> {
        let command = Command::new(request.identity, "set-ability-trail", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_ability_mutation()?;
        if ctx.auth().kind() != &PrincipalKind::DirectHuman {
            return Err(access_denied());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let prechecked = if let Some(destination) = &request.input.destination {
            let current = self.current_account(&ctx, &budget).await?;
            let source = budget
                .run(
                    self.raw_ability(&current, request.input.source.identity()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            let target = budget
                .run(
                    self.raw_ability(&current, destination.identity()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            let mut rtx = self.store.read(budget.clone()).await?;
            let (_, visited) = budget
                .run(
                    self.follow_ability_chain_db(rtx.inner_mut(), &current, destination.clone()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget
                .run(rtx.rollback(), CommitEffect::NotCommitted)
                .await?;
            budget
                .run(
                    async {
                        for item in &visited {
                            self.ability_placement(&current, item).await?;
                        }
                        Ok::<_, PortError>(())
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            Some((source, target))
        } else {
            None
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let owner = user(tx.inner_mut(), ctx.auth().principal().as_str()).await?;
            let mut references = vec![&request.input.source];
            if let Some(destination) = &request.input.destination { references.push(destination); }
            let spaces = self.lock_ability_spaces(tx.inner_mut(), &ctx, &owner, &references).await?;
            if let Some(replay) = command.replay::<AbilityTrailUpdate>(tx.inner_mut()).await? { return Ok(replay); }
            expect_revision(&owner, command.identity.expected)?;
            let key = placement(&request.input.source.placement)?;
            let old = rows!(tx.inner_mut(),AbilityPlacementTrailRow,fetch_optional,"SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,request.input.source.id.as_str())?;
            let previous = old.map(|row| serde_json::from_str::<Trail>(&row.manifest_ref).map_err(|_| invalid(ValidationReason::InvalidState))).transpose()?;
            if previous.as_ref().map(|trail| &trail.destination) != request.input.expected_destination.as_ref()
                || previous.as_ref().is_some_and(|trail| trail.source != request.input.source) { return Err(invalid(ValidationReason::InvalidState)); }
            if let Some(destination) = &request.input.destination {
                let (source, target) = prechecked.ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                if source.reference != request.input.source || target.reference != *destination || source.kind != target.kind { return Err(DomainError::ResourceNotFound.into()); }
                let final_ref = self.follow_ability_db(tx.inner_mut(), &ctx, destination.clone()).await?;
                if final_ref.identity() == source.reference.identity() { return Err(invalid(ValidationReason::InvalidState)); }
                let trail = Trail { source: source.reference, destination: destination.clone() };
                let record = TargetRecord::from(AbilityPlacementTrailRow { source_placement: key.clone(), ability_id: request.input.source.id.to_string(), destination_placement: placement(&destination.placement)?, destination_id: destination.id.to_string(), manifest_ref: serde_json::to_string(&trail).map_err(|_| invalid(ValidationReason::InvalidState))?, created_at: self.clock.now_ms()? });
                record.validate()?;
                execute!(tx.inner_mut(),"DELETE FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,request.input.source.id.as_str())?;
                record.insert(tx.inner_mut()).await?;
                // Validate the newly installed chain, including its first hop.
                self.follow_ability_db(tx.inner_mut(), &ctx, request.input.source.clone()).await?;
            } else {
                execute!(tx.inner_mut(),"DELETE FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,request.input.source.id.as_str())?;
            }
            let revision = self.bump_ability_state(tx.inner_mut(), &owner, &spaces).await?;
            let saved = SavedResult { value: request.input.clone(), events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, self.clock.now_ms()?).await?;
            Ok((revision, saved))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}

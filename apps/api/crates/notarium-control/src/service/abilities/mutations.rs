use super::*;
use crate::service::commands::{Command, SavedResult};
use crate::store::statements::execute;
use notarium_core::auth::SpaceRole;
use std::collections::BTreeSet;

impl ControlService {
    async fn ensure_current_ability_mutation(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        ability: &AbilityDescriptor,
    ) -> Result<(), PortError> {
        if self
            .follow_ability_db(tx, ctx, ability.reference.clone())
            .await?
            != ability.reference
            || !self
                .promotion_is_committed(
                    tx,
                    ability.promoted_from.as_ref(),
                    &ability.reference.identity(),
                )
                .await?
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(())
    }
    async fn lock_ability_spaces(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        owner: &UsersRow,
        references: &[&AbilityRef],
    ) -> Result<BTreeSet<SpaceId>, PortError> {
        let auth = ctx.auth();
        let authority = self
            .credential_authority(
                tx,
                owner,
                auth.credential().cloned().ok_or_else(denied)?,
                true,
            )
            .await?;
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
            authority.authorize_ability_space(auth, &space)?;
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
            self.ensure_current_ability_mutation(tx.inner_mut(), &ctx, &value).await?;
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
        if !(ctx.auth().human_management() || ctx.auth().has_cap(Cap::AbilityWrite)) {
            return Err(DomainError::AbilityWriteForbidden.into());
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
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            if !(auth.human_management() || auth.has_cap(Cap::AbilityWrite)) {
                return Err(DomainError::AbilityWriteForbidden.into());
            }
            if !auth.human_management() {
                let entry = value.entrypoint.as_ref().ok_or(DomainError::AbilityWriteForbidden)?;
                let grant = auth.spaces().get(&entry.space_id).ok_or_else(access_denied)?;
                if grant.role == SpaceRole::Viewer
                    || !grant.write_classes.contains(&DocClass::Skill)
                    || grant.project_root.as_ref().is_some_and(|root| !matches!(&value.reference.placement, AbilityPlacement::OwnedProject(folder) if &folder.folder_id == root))
                {
                    return Err(access_denied());
                }
            }
            if let Some(replay) = command.replay::<AbilityPreferenceUpdate>(tx.inner_mut()).await? { return Ok(replay); }
            self.ensure_current_ability_mutation(tx.inner_mut(), &ctx, &value).await?;
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
        let budget = OperationBudget::new(ctx.budget.clone());
        let (prechecked, promotion_pin) = if let Some(destination) = &request.input.destination {
            let current = self.current_account(&ctx, &budget).await?;
            let target = budget
                .run(
                    self.raw_ability(&current, destination.identity()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            let source = budget
                .run(
                    async {
                        let original = &request.input.source;
                        match (&original.placement, &destination.placement) {
                            (
                                AbilityPlacement::OwnedProject(project),
                                AbilityPlacement::OwnedSpace(space),
                            ) if original.id == destination.id
                                && original.revision != destination.revision
                                && &project.space_id == space =>
                            {
                                self.catalog_project(&current, project).await?;
                                // Publishing the new placement changed the live lookup key.
                                // The source revision is still immutable and readable there.
                                let lookup = AbilityRef {
                                    id: original.id.clone(),
                                    placement: destination.placement.clone(),
                                    revision: original.revision.clone(),
                                };
                                let mut previous = self
                                    .catalog
                                    .ability(current.clone(), lookup.clone())
                                    .await?;
                                if previous.reference != lookup {
                                    return Err(DomainError::ResourceNotFound.into());
                                }
                                previous.reference = original.clone();
                                Ok(previous)
                            }
                            _ => self.raw_ability(&current, original.identity()).await,
                        }
                    },
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
            let promotion_pin = if target.promoted_from.as_ref() == Some(&source.reference) {
                let AbilityPlacement::OwnedSpace(space) = &target.reference.placement else {
                    return Err(invalid(ValidationReason::InvalidState));
                };
                let scoped = AccountContext::new(
                    current.auth().restrict_to_space(space)?,
                    current.budget.clone(),
                );
                let pin = self
                    .catalog
                    .pin_schedule_abilities(scoped, vec![target.reference.clone()])
                    .await?;
                if &pin.history().space_id != space
                    || !matches!(pin.abilities(), [pinned]
                        if pinned.reference == target.reference
                            && pinned.promoted_from == target.promoted_from
                            && pinned.healthy)
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Some(pin)
            } else {
                None
            };
            (Some((source, target)), promotion_pin)
        } else {
            (None, None)
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
                let (source, target) = prechecked.as_ref().ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                if source.reference != request.input.source || target.reference != *destination || source.kind != target.kind { return Err(DomainError::ResourceNotFound.into()); }
                let final_ref = self.follow_ability_db(tx.inner_mut(), &ctx, destination.clone()).await?;
                if final_ref.identity() == source.reference.identity() { return Err(invalid(ValidationReason::InvalidState)); }
                if !self.promotion_is_committed(tx.inner_mut(), target.promoted_from.as_ref(), &destination.identity()).await? {
                    let Some(original) = &target.promoted_from else { return Err(invalid(ValidationReason::InvalidState)); };
                    let AbilityPlacement::OwnedProject(project) = &original.placement else { return Err(invalid(ValidationReason::InvalidState)); };
                    if original != &source.reference
                        || destination.placement != AbilityPlacement::OwnedSpace(project.space_id.clone())
                        || destination.id != original.id
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    transfer_promotion_overlays(tx.inner_mut(), project, &key, &placement(&destination.placement)?, &original.id).await?;
                }
                let trail = Trail { source: source.reference.clone(), destination: destination.clone() };
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
        drop(promotion_pin);
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}

/// Both placements share one exclusively locked Space. Preserve effective old
/// project visibility and combine any existing destination restrictions.
async fn transfer_promotion_overlays(
    tx: &mut Transaction,
    project: &FolderRef,
    source: &str,
    destination: &str,
    ability: &AbilityId,
) -> Result<(), PortError> {
    let bindings = rows!(tx,AbilityAvailabilityRow,fetch_all,
        "SELECT * FROM ability_availability WHERE ability_id=$1 AND placement IN ($2,$3)",
        "SELECT * FROM v1_control.ability_availability WHERE ability_id=$1 AND placement IN ($2,$3)";
        ability.as_str(),source,destination)?;
    let enabled = i64::from(bindings.iter().all(|binding| binding.enabled == 1));
    let revision = next(
        bindings
            .iter()
            .map(|binding| binding.revision)
            .max()
            .unwrap_or(0),
    )?;
    let mut admits_project = true;
    for binding in &bindings {
        match binding.mode.as_str() {
            "all-projects" => (),
            "selected-projects" => {
                admits_project &= rows!(tx,AbilityProjectBindingsRow,fetch_optional,
                    "SELECT * FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4",
                    "SELECT * FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2 AND target_space=$3 AND project_id=$4";
                    &binding.placement,ability.as_str(),project.space_id.as_str(),project.folder_id.as_str())?.is_some();
            }
            _ => return Err(invalid(ValidationReason::InvalidState)),
        }
    }
    execute!(tx,
        "INSERT INTO ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,'selected-projects',$3,$4) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision",
        "INSERT INTO v1_control.ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,'selected-projects',$3,$4) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision";
        destination,ability.as_str(),enabled,revision)?;
    execute!(tx,
        "DELETE FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2",
        "DELETE FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2";
        destination,ability.as_str())?;
    if admits_project {
        let record = TargetRecord::from(AbilityProjectBindingsRow {
            placement: destination.into(),
            ability_id: ability.to_string(),
            target_space: project.space_id.to_string(),
            project_id: project.folder_id.to_string(),
        });
        record.validate()?;
        record.insert(tx).await?;
    }
    execute!(tx,
        "DELETE FROM ability_availability WHERE placement=$1 AND ability_id=$2",
        "DELETE FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";
        source,ability.as_str())?;

    // Moving an existing preference never updates its owner FK. Taking locks on
    // other owners here would invert the order used by preference writers.
    execute!(tx,
        "UPDATE ability_preferences AS dst SET enabled=CASE WHEN dst.enabled=1 AND src.enabled=1 THEN 1 ELSE 0 END, revision=MAX(dst.revision,src.revision) FROM ability_preferences AS src WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3 AND src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id",
        "UPDATE v1_control.ability_preferences AS dst SET enabled=CASE WHEN dst.enabled=1 AND src.enabled=1 THEN 1 ELSE 0 END, revision=GREATEST(dst.revision,src.revision) FROM v1_control.ability_preferences AS src WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3 AND src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id";
        destination,source,ability.as_str())?;
    execute!(tx,
        "DELETE FROM ability_preferences AS src WHERE src.placement=$1 AND src.ability_id=$2 AND EXISTS (SELECT 1 FROM ability_preferences AS dst WHERE dst.placement=$3 AND dst.owner_id=src.owner_id AND dst.ability_id=src.ability_id)",
        "DELETE FROM v1_control.ability_preferences AS src WHERE src.placement=$1 AND src.ability_id=$2 AND EXISTS (SELECT 1 FROM v1_control.ability_preferences AS dst WHERE dst.placement=$3 AND dst.owner_id=src.owner_id AND dst.ability_id=src.ability_id)";
        source,ability.as_str(),destination)?;
    execute!(tx,
        "UPDATE ability_preferences SET placement=$1 WHERE placement=$2 AND ability_id=$3",
        "UPDATE v1_control.ability_preferences SET placement=$1 WHERE placement=$2 AND ability_id=$3";
        destination,source,ability.as_str())?;
    Ok(())
}

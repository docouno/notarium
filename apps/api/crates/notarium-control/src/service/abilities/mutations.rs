use super::*;
use crate::service::commands::{Command, SavedResult};
use crate::store::statements::execute;
use notarium_core::auth::SpaceRole;
use std::collections::BTreeSet;

enum PreferencePrecondition {
    Account,
    Target(Option<ControlRevision>),
}

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
        self.bump_ability_state_at_least(tx, owner, spaces, owner.revision)
            .await
    }
    async fn bump_ability_state_at_least(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        spaces: &BTreeSet<SpaceId>,
        min_previous: i64,
    ) -> Result<ControlRevision, PortError> {
        for space in spaces {
            let current = crate::service::spaces::admission(tx, space, false).await?;
            execute!(tx,"UPDATE space_admission SET revision=$1 WHERE space_id=$2","UPDATE v1_control.space_admission SET revision=$1 WHERE space_id=$2";next(current.revision)?,space.as_str())?;
        }
        let revision = next(owner.revision.max(min_previous))?;
        execute!(tx,"UPDATE users SET revision=$1,metadata_revision=$2 WHERE user_id=$3","UPDATE v1_control.users SET revision=$1,metadata_revision=$2 WHERE user_id=$3";revision,next(owner.metadata_revision)?,&owner.user_id)?;
        Ok(ControlRevision::new(revision as u64)?)
    }
    async fn pin_authoring_target(
        &self,
        current: &AccountContext,
        budget: &OperationBudget,
        target: &AbilityDescriptor,
    ) -> Result<Box<dyn ScheduleAbilityLease>, PortError> {
        let entry = target
            .entrypoint
            .as_ref()
            .ok_or(DomainError::AbilityWriteForbidden)?;
        let scope = AccountContext::new(
            current.auth().restrict_to_space(&entry.space_id)?,
            budget.context(current.budget.request.clone()),
        );
        let pin = self
            .catalog
            .pin_schedule_abilities(scope, vec![target.reference.clone()])
            .await?;
        if pin.history().space_id != entry.space_id
            || !matches!(pin.abilities(), [pinned] if pinned.reference == target.reference)
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(pin)
    }

    pub async fn update_ability_binding(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityBindingUpdate>,
    ) -> Result<ControlCommit<AbilityDescriptor>, PortError> {
        let command = Command::new(request.identity, "update-ability-binding", &request.input)?;
        let input = AbilityBindingChange {
            ability: request.input.ability,
            enabled: request.input.enabled,
            expected: Some(request.input.expected),
            projects: request.input.projects,
        };
        let (revision, _, descriptor) = self
            .write_ability_binding(ctx, command, input, false)
            .await?;
        Ok(ControlCommit {
            revision,
            value: descriptor.ok_or(DomainError::ResourceNotFound)?,
        })
    }

    pub async fn compare_authored_ability_binding(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityBindingChange>,
    ) -> Result<ControlCommit<AbilityRef>, PortError> {
        let command = Command::new(
            request.identity,
            "compare-authored-ability-binding",
            &request.input,
        )?;
        let (revision, reference, _) = self
            .write_ability_binding(ctx, command, request.input, true)
            .await?;
        Ok(ControlCommit {
            revision,
            value: reference,
        })
    }

    async fn write_ability_binding(
        &self,
        ctx: AccountContext,
        command: Command,
        input: AbilityBindingChange,
        authoring: bool,
    ) -> Result<(ControlRevision, AbilityRef, Option<AbilityDescriptor>), PortError> {
        if matches!(&input.projects, AbilityProjects::Selected(values) if values.len() > 200) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_ability_mutation()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let prechecked: Result<
            (AbilityDescriptor, Option<Box<dyn ScheduleAbilityLease>>),
            PortError,
        > = async {
            let value = budget
                .run(
                    self.raw_ability(&current, input.ability.identity()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if value.reference != input.ability {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let AbilityProjects::Selected(projects) = &input.projects {
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
            let pin = if authoring {
                Some(
                    budget
                        .run(
                            self.pin_authoring_target(&current, &budget, &value),
                            CommitEffect::NotCommitted,
                        )
                        .await?,
                )
            } else {
                None
            };
            Ok((value, pin))
        }
        .await;
        let (prechecked, pin) = match prechecked {
            Ok((value, pin)) => (Ok(value), pin),
            Err(error) if authoring => (Err(error), None),
            Err(error) => return Err(error),
        };
        let mut tx = self.store.write(budget.clone()).await?;
        if let Some(pin) = pin {
            tx.hold_schedule_pin(pin);
        }
        let (revision, reference, descriptor) = budget.run(async {
            let owner = user(tx.inner_mut(), ctx.auth().principal().as_str()).await?;
            let spaces = self.lock_ability_spaces(tx.inner_mut(), &ctx, &owner, &[&input.ability]).await?;
            let key = placement(&input.ability.placement)?;
            let project = match &input.ability.placement { AbilityPlacement::OwnedProject(project) => Some(project), _ => None };
            if let Some((revision, saved)) = command.replay::<AbilityRef>(tx.inner_mut()).await? {
                let descriptor = if authoring {
                    None
                } else {
                    let descriptor = prechecked?;
                    Some(self.overlay(tx.inner_mut(), &ctx, descriptor, project).await?)
                };
                return Ok((revision, saved.value, descriptor));
            }
            let value = prechecked?;
            self.ensure_current_ability_mutation(tx.inner_mut(), &ctx, &value).await?;
            if !authoring { expect_revision(&owner, command.identity.expected)?; }
            let old = rows!(tx.inner_mut(),AbilityAvailabilityRow,fetch_optional,"SELECT * FROM ability_availability WHERE placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_availability WHERE placement=$1 AND ability_id=$2";&key,input.ability.id.as_str())?;
            let previous = old.as_ref().map_or(0, |row| row.revision);
            let current = ControlRevision::new(previous as u64)?;
            let actual = (old.is_some() || !authoring).then_some(current);
            if actual != input.expected { return Err(DomainError::ControlRevisionConflict { current }.into()); }
            let mode = match &input.projects { AbilityProjects::All => "all-projects", AbilityProjects::Selected(_) => "selected-projects" };
            let row = AbilityAvailabilityRow { placement: key.clone(), ability_id: input.ability.id.to_string(), mode: mode.into(), enabled: i64::from(input.enabled), revision: next(previous)? };
            TargetRecord::from(row.clone()).validate()?;
            execute!(tx.inner_mut(),"INSERT INTO ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision",
                "INSERT INTO v1_control.ability_availability(placement,ability_id,mode,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(placement,ability_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,revision=excluded.revision";&key,&row.ability_id,mode,row.enabled,row.revision)?;
            execute!(tx.inner_mut(),"DELETE FROM ability_project_bindings WHERE placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_project_bindings WHERE placement=$1 AND ability_id=$2";&key,&row.ability_id)?;
            if let AbilityProjects::Selected(projects) = &input.projects {
                let mut seen = BTreeSet::new();
                for project in projects {
                    if !spaces.contains(&project.space_id) || !seen.insert((project.space_id.clone(), project.folder_id.clone())) { return Err(invalid(ValidationReason::ScopeMismatch)); }
                    let record = TargetRecord::from(AbilityProjectBindingsRow { placement: key.clone(), ability_id: row.ability_id.clone(), target_space: project.space_id.to_string(), project_id: project.folder_id.to_string() });
                    record.validate()?; record.insert(tx.inner_mut()).await?;
                }
            }
            let revision = self.bump_ability_state(tx.inner_mut(), &owner, &spaces).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: input.ability.clone(), events: vec![] }, self.clock.now_ms()?).await?;
            let descriptor = if authoring {
                None
            } else {
                Some(self.overlay(tx.inner_mut(), &ctx, value, project).await?)
            };
            Ok((revision, input.ability, descriptor))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok((revision, reference, descriptor))
    }
    pub async fn set_ability_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityPreferenceUpdate>,
    ) -> Result<ControlCommit<AbilityPreferenceUpdate>, PortError> {
        let command = Command::new(request.identity, "set-ability-preference", &request.input)?;
        self.write_ability_preference(ctx, command, request.input, PreferencePrecondition::Account)
            .await
    }

    pub async fn compare_authored_ability_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityPreferenceChange>,
    ) -> Result<ControlCommit<AbilityPreferenceUpdate>, PortError> {
        ctx.auth().authorize_ability_mutation()?;
        let command = Command::new(
            request.identity,
            "compare-authored-ability-preference",
            &request.input,
        )?;
        self.write_ability_preference(
            ctx,
            command,
            request.input.preference,
            PreferencePrecondition::Target(request.input.expected),
        )
        .await
    }

    async fn write_ability_preference(
        &self,
        ctx: AccountContext,
        command: Command,
        input: AbilityPreferenceUpdate,
        precondition: PreferencePrecondition,
    ) -> Result<ControlCommit<AbilityPreferenceUpdate>, PortError> {
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        if !(ctx.auth().human_management() || ctx.auth().has_cap(Cap::AbilityWrite)) {
            return Err(DomainError::AbilityWriteForbidden.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let current = self.current_account(&ctx, &budget).await?;
        let authoring = matches!(precondition, PreferencePrecondition::Target(_));
        if authoring {
            ctx.auth().authorize_ability_mutation()?;
        }
        let prechecked: Result<
            (AbilityDescriptor, Option<Box<dyn ScheduleAbilityLease>>),
            PortError,
        > = async {
            let value = budget
                .run(
                    self.raw_ability(&current, input.ability.identity()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if value.reference != input.ability {
                return Err(DomainError::ResourceNotFound.into());
            }
            let pin = if authoring {
                Some(
                    budget
                        .run(
                            self.pin_authoring_target(&current, &budget, &value),
                            CommitEffect::NotCommitted,
                        )
                        .await?,
                )
            } else {
                None
            };
            Ok((value, pin))
        }
        .await;
        let (prechecked, pin) = match prechecked {
            Ok((value, pin)) => (Ok(value), pin),
            Err(error) if authoring => (Err(error), None),
            Err(error) => return Err(error),
        };
        let mut tx = self.store.write(budget.clone()).await?;
        if let Some(pin) = pin {
            tx.hold_schedule_pin(pin);
        }
        let (revision, saved) = budget.run(async {
            let (owner, live_ctx) = if authoring {
                let owner = user(tx.inner_mut(), ctx.auth().principal().as_str()).await?;
                self.lock_ability_spaces(tx.inner_mut(), &ctx, &owner, &[&input.ability]).await?;
                (owner, ctx.clone())
            } else {
                let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                if !(auth.human_management() || auth.has_cap(Cap::AbilityWrite)) {
                    return Err(DomainError::AbilityWriteForbidden.into());
                }
                if !auth.human_management() {
                    let entry = prechecked
                        .as_ref()
                        .ok()
                        .and_then(|value| value.entrypoint.as_ref())
                        .ok_or(DomainError::AbilityWriteForbidden)?;
                    let grant = auth.spaces().get(&entry.space_id).ok_or_else(access_denied)?;
                    if grant.role == SpaceRole::Viewer
                        || !grant.write_classes.contains(&DocClass::Skill)
                        || grant.project_root.as_ref().is_some_and(|root| !matches!(&input.ability.placement, AbilityPlacement::OwnedProject(folder) if &folder.folder_id == root))
                    {
                        return Err(access_denied());
                    }
                }
                let owner = user(tx.inner_mut(), auth.principal().as_str()).await?;
                (owner, AccountContext::new(auth, ctx.budget.clone()))
            };
            if let Some(replay) = command.replay::<AbilityPreferenceUpdate>(tx.inner_mut()).await? { return Ok(replay); }
            let value = prechecked?;
            self.ensure_current_ability_mutation(tx.inner_mut(), &live_ctx, &value).await?;
            let key = placement(&input.ability.placement)?;
            let existing = ability_preference(tx.inner_mut(), live_ctx.auth().principal(), &key, &input.ability.id).await?;
            if let PreferencePrecondition::Target(expected) = precondition {
                let actual = existing.as_ref().map(|row| ControlRevision::new(row.revision as u64)).transpose()?;
                if actual != expected { return Err(DomainError::ControlRevisionConflict { current: actual.unwrap_or(ControlRevision::ZERO) }.into()); }
            } else {
                expect_revision(&owner, command.identity.expected)?;
            }
            let min_previous = existing.as_ref().map_or(0, |row| row.revision);
            let revision = self.bump_ability_state_at_least(tx.inner_mut(), &owner, &BTreeSet::new(), min_previous).await?;
            execute!(tx.inner_mut(),"INSERT INTO ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,ability_id,placement) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision",
                "INSERT INTO v1_control.ability_preferences(owner_id,ability_id,placement,enabled,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,ability_id,placement) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision";&owner.user_id,input.ability.id.as_str(),&key,i64::from(input.enabled),revision.get() as i64)?;
            let saved = SavedResult { value: input, events: vec![] };
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
        let result = self
            .write_ability_trail(ctx, command, request.input.clone(), false)
            .await?;
        Ok(ControlCommit {
            revision: result.revision,
            value: request.input,
        })
    }

    pub async fn adopt_authored_ability_promotion(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AdoptAbilityPromotion>,
    ) -> Result<ControlCommit<AbilityPromotionResult>, PortError> {
        let AdoptAbilityPromotion {
            source,
            destination,
        } = request.input;
        if !matches!(
            (&source.placement, &destination.placement),
            (AbilityPlacement::OwnedProject(project), AbilityPlacement::OwnedSpace(space))
                if &project.space_id == space && source.id == destination.id
                    && source.revision != destination.revision
        ) {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        let input = AbilityTrailUpdate {
            source,
            expected_destination: None,
            destination: Some(destination),
        };
        let command = Command::new(request.identity, "adopt-authored-ability-promotion", &input)?;
        let result = self.write_ability_trail(ctx, command, input, true).await?;
        Ok(ControlCommit {
            revision: result.revision,
            value: result
                .value
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
        })
    }

    async fn write_ability_trail(
        &self,
        ctx: AccountContext,
        command: Command,
        input: AbilityTrailUpdate,
        promotion: bool,
    ) -> Result<ControlCommit<Option<AbilityPromotionResult>>, PortError> {
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_ability_mutation()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        type PrecheckedTrail = (
            Option<(AbilityDescriptor, AbilityDescriptor)>,
            Option<Box<dyn ScheduleAbilityLease>>,
        );
        let prechecked: Result<PrecheckedTrail, PortError> = if let Some(destination) =
            &input.destination
        {
            let current = self.current_account(&ctx, &budget).await?;
            async {
                let target = budget
                    .run(
                        self.raw_ability(&current, destination.identity()),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if promotion && target.reference != *destination {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let source = budget
                    .run(
                        async {
                            let original = &input.source;
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
                        self.follow_ability_chain_db(
                            rtx.inner_mut(),
                            &current,
                            destination.clone(),
                        ),
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
                        budget.context(ctx.budget.request.clone()),
                    );
                    let pin = budget
                        .run(
                            self.catalog
                                .pin_schedule_abilities(scoped, vec![target.reference.clone()]),
                            CommitEffect::NotCommitted,
                        )
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
                Ok((Some((source, target)), promotion_pin))
            }
            .await
        } else {
            Ok((None, None))
        };
        let (prechecked, promotion_pin) = match prechecked {
            Ok((pair, pin)) => (Ok(pair), pin),
            Err(error) if promotion => (Err(error), None),
            Err(error) => return Err(error),
        };
        let has_promotion_pin = promotion_pin.is_some();
        let mut tx = self.store.write(budget.clone()).await?;
        if let Some(pin) = promotion_pin {
            tx.hold_schedule_pin(pin);
        }
        let (revision, value) = budget.run(async {
            let owner = user(tx.inner_mut(), ctx.auth().principal().as_str()).await?;
            let mut references = vec![&input.source];
            if let Some(destination) = &input.destination { references.push(destination); }
            let spaces = self.lock_ability_spaces(tx.inner_mut(), &ctx, &owner, &references).await?;
            if promotion {
                if let Some((revision, saved)) = command.replay::<AbilityPromotionResult>(tx.inner_mut()).await? {
                    return Ok((revision, Some(saved.value)));
                }
            } else {
                if let Some((revision, _)) = command.replay::<AbilityTrailUpdate>(tx.inner_mut()).await? {
                    return Ok((revision, None));
                }
                expect_revision(&owner, command.identity.expected)?;
            }
            let prechecked = prechecked?;
            if promotion && !has_promotion_pin {
                return Err(DomainError::ResourceNotFound.into());
            }
            let key = placement(&input.source.placement)?;
            let old = rows!(tx.inner_mut(),AbilityPlacementTrailRow,fetch_optional,"SELECT * FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","SELECT * FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,input.source.id.as_str())?;
            let previous = old.map(|row| serde_json::from_str::<Trail>(&row.manifest_ref).map_err(|_| invalid(ValidationReason::InvalidState))).transpose()?;
            if previous.as_ref().map(|trail| &trail.destination) != input.expected_destination.as_ref()
                || previous.as_ref().is_some_and(|trail| trail.source != input.source) { return Err(invalid(ValidationReason::InvalidState)); }
            let value = if let Some(destination) = &input.destination {
                let (source, target) = prechecked.as_ref().ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                if source.reference != input.source || target.reference != *destination || source.kind != target.kind { return Err(DomainError::ResourceNotFound.into()); }
                let final_ref = self.follow_ability_db(tx.inner_mut(), &ctx, destination.clone()).await?;
                if final_ref.identity() == source.reference.identity() { return Err(invalid(ValidationReason::InvalidState)); }
                let source_state = if promotion {
                    Some(read_overlay_state(tx.inner_mut(), ctx.auth().principal(), &key, &source.reference.id).await?)
                } else {
                    None
                };
                let destination_key = placement(&destination.placement)?;
                if !self.promotion_is_committed(tx.inner_mut(), target.promoted_from.as_ref(), &destination.identity()).await? {
                    let Some(original) = &target.promoted_from else { return Err(invalid(ValidationReason::InvalidState)); };
                    let AbilityPlacement::OwnedProject(project) = &original.placement else { return Err(invalid(ValidationReason::InvalidState)); };
                    if original != &source.reference
                        || destination.placement != AbilityPlacement::OwnedSpace(project.space_id.clone())
                        || destination.id != original.id
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    transfer_promotion_overlays(tx.inner_mut(), project, &key, &destination_key, &original.id).await?;
                }
                let trail = Trail { source: source.reference.clone(), destination: destination.clone() };
                let record = TargetRecord::from(AbilityPlacementTrailRow { source_placement: key.clone(), ability_id: input.source.id.to_string(), destination_placement: placement(&destination.placement)?, destination_id: destination.id.to_string(), manifest_ref: serde_json::to_string(&trail).map_err(|_| invalid(ValidationReason::InvalidState))?, created_at: self.clock.now_ms()? });
                record.validate()?;
                execute!(tx.inner_mut(),"DELETE FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,input.source.id.as_str())?;
                record.insert(tx.inner_mut()).await?;
                // Validate the newly installed chain, including its first hop.
                self.follow_ability_db(tx.inner_mut(), &ctx, input.source.clone()).await?;
                if let Some(source) = source_state {
                    let destination = read_overlay_state(tx.inner_mut(), ctx.auth().principal(), &destination_key, &destination.id).await?;
                    Some(AbilityPromotionResult { source, destination })
                } else {
                    None
                }
            } else {
                execute!(tx.inner_mut(),"DELETE FROM ability_placement_trail WHERE source_placement=$1 AND ability_id=$2","DELETE FROM v1_control.ability_placement_trail WHERE source_placement=$1 AND ability_id=$2";&key,input.source.id.as_str())?;
                None
            };
            let revision = self.bump_ability_state(tx.inner_mut(), &owner, &spaces).await?;
            let now = self.clock.now_ms()?;
            if let Some(snapshot) = &value {
                command.save(tx.inner_mut(), revision, &SavedResult { value: snapshot, events: vec![] }, now).await?;
            } else {
                command.save(tx.inner_mut(), revision, &SavedResult { value: input, events: vec![] }, now).await?;
            }
            Ok((revision, value))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit { revision, value })
    }
}

async fn read_overlay_state(
    tx: &mut Transaction,
    owner: &PrincipalId,
    key: &str,
    ability: &AbilityId,
) -> Result<AbilityOverlayState, PortError> {
    let (binding, preference) = ability_control_state(tx, owner, key, ability).await?;
    overlay_state(binding.as_ref(), preference.as_ref())
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
    let max_merged_rev = rows!(tx,(Option<i64>,),fetch_one,
        "SELECT MAX(MAX(dst.revision,src.revision)) FROM ability_preferences AS dst JOIN ability_preferences AS src ON src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3",
        "SELECT MAX(GREATEST(dst.revision,src.revision)) FROM v1_control.ability_preferences AS dst JOIN v1_control.ability_preferences AS src ON src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3";
        destination,source,ability.as_str())?.0;
    if let Some(max_rev) = max_merged_rev {
        next(max_rev)?;
        execute!(tx,
            "UPDATE ability_preferences AS dst SET enabled=CASE WHEN dst.enabled=1 AND src.enabled=1 THEN 1 ELSE 0 END, revision=MAX(dst.revision,src.revision)+1 FROM ability_preferences AS src WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3 AND src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id",
            "UPDATE v1_control.ability_preferences AS dst SET enabled=CASE WHEN dst.enabled=1 AND src.enabled=1 THEN 1 ELSE 0 END, revision=GREATEST(dst.revision,src.revision)+1 FROM v1_control.ability_preferences AS src WHERE dst.placement=$1 AND src.placement=$2 AND dst.ability_id=$3 AND src.ability_id=dst.ability_id AND src.owner_id=dst.owner_id";
            destination,source,ability.as_str())?;
    }
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

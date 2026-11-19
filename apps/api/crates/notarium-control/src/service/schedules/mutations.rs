use super::*;

enum Change {
    Create(CreateSchedule),
    Update(UpdateSchedule),
    Delete(DeleteSchedule),
}
fn pause_only(input: &UpdateSchedule, previous: &AgentSchedule) -> bool {
    input.paused
        && input.approved_skills.is_none()
        && input.definition == previous.definition
        && input.next_slot == previous.next_slot
}

impl ControlService {
    fn mutate_schedule<'a>(
        &'a self,
        ctx: AccountContext,
        command: Command,
        change: Change,
    ) -> PortFuture<'a, ControlCommit<ScheduleId>> {
        Box::pin(async move {
            ctx.auth().authorize_human_management()?;
            command.require(ctx.auth().principal(), ctx.auth().principal())?;
            let budget = OperationBudget::new(ctx.budget.clone());
            let prechecked = match &change {
                Change::Create(input) => self
                    .precheck_schedule_definition(
                        &ctx,
                        &budget,
                        &input.definition,
                        &input.approved_skills,
                    )
                    .await
                    .map(Some),
                Change::Update(input) => {
                    async {
                        let row = self.observe_schedule(&budget, &input.schedule).await?;
                        if row.owner_id != ctx.auth().principal().as_str()
                            || row.deleted_at.is_some()
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let previous = schedule_info(&row)?;
                        if pause_only(input, &previous) {
                            return Ok(None);
                        }
                        let skills = input
                            .approved_skills
                            .as_deref()
                            .unwrap_or(&previous.approved_skills);
                        self.precheck_schedule_definition(&ctx, &budget, &input.definition, skills)
                            .await
                            .map(Some)
                    }
                    .await
                }
                Change::Delete(_) => Ok(None),
            };
            let approved = prechecked
                .as_ref()
                .map(|pin| pin.as_deref().map(ScheduleAbilityLease::abilities));
            let mut tx = self.store.write(budget.clone()).await?;
            let (revision,saved) = budget.run(async {
            let (owner,_) = self.manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            if let Some(replay) = command.replay::<ScheduleId>(tx.inner_mut()).await? {return Ok(replay);}
            expect_revision(&owner,command.identity.expected)?;
            let auth = self.revalidate(tx.inner_mut(),ctx.auth()).await?;
            let current = AccountContext::new(auth,budget.context(ctx.budget.request.clone()));
            let now = self.clock.now_ms()?;
            let (id, revoke) = match change {
                Change::Create(input) => {
                    validate(&input.definition,Some(input.next_slot),self.config.schedule_limits,false)?;
                    let scope = ScheduleScope::from(&input.definition);
                    scope.check(current.auth())?;
                    let descriptors = approved.map_err(Clone::clone)?
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                    if !self.verify_schedule_approval_db(tx.inner_mut(),&current,scope,descriptors).await? {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    if rows!(tx.inner_mut(),(i64,),fetch_optional,"SELECT 1 FROM agent_schedules WHERE schedule_id=$1","SELECT 1 FROM v1_control.agent_schedules WHERE schedule_id=$1";input.id.as_str())?.is_some() {return Err(DomainError::IdempotencyKeyReused.into());}
                    let row = AgentSchedulesRow {
                        schedule_id:input.id.to_string(),owner_id:owner.user_id.clone(),space_id:input.definition.space.to_string(),
                        project_folder_id:input.definition.project.as_ref().map(|p|p.folder_id.to_string()),title:input.definition.title,init_prompt:input.definition.init_prompt,
                        cron_expr:input.definition.cron,timezone:input.definition.timezone,approved_role:json(&input.definition.approved_role)?,
                        approved_skills:json(&input.approved_skills)?,
                        paused_reason:input.paused.then(||"manual".into()),write_class_mask:1,budgets:json(&input.definition.limits)?,misfire_policy:"coalesce_latest".into(),
                        next_slot_utc_ms:Some(ms(input.next_slot)?),deleted_at:None,revision:0,config_revision:0,created_at:now,updated_at:now,
                    };
                    let record = TargetRecord::from(row);
                    record.validate()?;
                    record
                        .insert_or_conflict(tx.inner_mut())
                        .await
                        .map_err(|err| {
                            if matches!(
                                &err,
                                PortError::Domain(DomainError::ValidationFailed { diagnostic })
                                    if diagnostic.reason == ValidationReason::DuplicateKey
                            ) {
                                DomainError::IdempotencyKeyReused.into()
                            } else {
                                err
                            }
                        })?;
                    (input.id,false)
                }
                Change::Update(input) => {
                    // All current memberships were locked before this schedule.
                    let row = schedule(tx.inner_mut(),&input.schedule,true).await?;
                    if row.owner_id!=owner.user_id || row.deleted_at.is_some() {return Err(DomainError::ResourceNotFound.into());}
                    expect(&row,input.expected)?;
                    if row.space_id!=input.definition.space.as_str() {return Err(invalid(ValidationReason::ScopeMismatch));}
                    let previous = schedule_info(&row)?;
                    let scope = ScheduleScope::from(&input.definition);
                    scope.check(current.auth())?;
                    let calendar_unchanged = input.definition.cron == previous.definition.cron
                        && input.definition.timezone == previous.definition.timezone;
                    if !pause_only(&input, &previous) {
                        // Only a claim can exhaust a calendar. Ordinary
                        // updates may preserve its already exhausted state.
                        if input.next_slot.is_none() && (previous.next_slot.is_some() || !calendar_unchanged) {
                            return Err(invalid(ValidationReason::InvalidTimestamp));
                        }
                        if input.approved_skills.is_none() && input.definition.approved_role != previous.definition.approved_role {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                        let unchanged_due = calendar_unchanged && input.next_slot == previous.next_slot;
                        validate(&input.definition,input.next_slot,self.config.schedule_limits,unchanged_due)?;
                        let descriptors = approved.map_err(Clone::clone)?
                            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                        if !self.verify_schedule_approval_db(tx.inner_mut(),&current,scope,descriptors).await? {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                    }
                    let project = input.definition.project.as_ref().map(|p|p.folder_id.to_string());
                    let approved = json(&input.definition.approved_role)?;
                    let skills = json(input.approved_skills.as_ref().unwrap_or(&previous.approved_skills))?;
                    let limits = json(&input.definition.limits)?;
                    let reason:Option<&str> = input.paused.then_some("manual");
                    execute!(tx.inner_mut(),
                        "UPDATE agent_schedules SET project_folder_id=$1,title=$2,init_prompt=$3,cron_expr=$4,timezone=$5,approved_role=$6,approved_skills=$7,budgets=$8,next_slot_utc_ms=$9,paused_reason=$10,revision=$11,config_revision=$12,updated_at=$13 WHERE schedule_id=$14",
                        "UPDATE v1_control.agent_schedules SET project_folder_id=$1,title=$2,init_prompt=$3,cron_expr=$4,timezone=$5,approved_role=$6,approved_skills=$7,budgets=$8,next_slot_utc_ms=$9,paused_reason=$10,revision=$11,config_revision=$12,updated_at=$13 WHERE schedule_id=$14";
                        project,&input.definition.title,&input.definition.init_prompt,&input.definition.cron,&input.definition.timezone,approved,skills,limits,input.next_slot.map(ms).transpose()?,reason,next(row.revision)?,next(row.config_revision)?,now,input.schedule.as_str())?;
                    (input.schedule,true)
                }
                Change::Delete(input) => {
                    let row = schedule(tx.inner_mut(),&input.schedule,true).await?;
                    if row.owner_id!=owner.user_id || row.deleted_at.is_some() {return Err(DomainError::ResourceNotFound.into());}
                    expect(&row,input.expected)?;
                    // Deletion of one's known schedule remains possible after a
                    // project or role disappears, without loading its content.
                    let space = SpaceId::parse(&row.space_id)?;
                    let grant = current.auth().spaces().get(&space).ok_or(DomainError::ResourceNotFound)?;
                    if grant.role==SpaceRole::Viewer || !grant.write_classes.contains(&DocClass::AgentMemory) {return Err(access_denied());}
                    execute!(tx.inner_mut(),"UPDATE agent_schedules SET init_prompt='',deleted_at=$1,revision=$2,config_revision=$3,updated_at=$1 WHERE schedule_id=$4","UPDATE v1_control.agent_schedules SET init_prompt='',deleted_at=$1,revision=$2,config_revision=$3,updated_at=$1 WHERE schedule_id=$4";now,next(row.revision)?,next(row.config_revision)?,input.schedule.as_str())?;
                    (input.schedule,true)
                }
            };
            let revision = next(owner.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
            let mut events = Vec::new();
            if revoke {events.push(super::super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Schedule(id.clone()),RevocationReason::PermissionChanged,revision,now).await?);}
            let revision = ControlRevision::new(revision as u64)?;
            let saved = SavedResult {value:id,events};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
            if let Ok(Some(pin)) = prechecked {
                tx.hold_schedule_pin(pin);
            }
            self.commit_revocations(tx, &budget, &saved.events).await?;
            for event in &saved.events {
                self.flush_event(&budget, event).await?;
            }
            Ok(ControlCommit {
                revision,
                value: saved.value,
            })
        })
    }
    pub async fn create_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSchedule>,
    ) -> Result<ControlCommit<AgentSchedule>, PortError> {
        let command = Command::new(request.identity, "create-schedule", &request.input)?;
        let commit = self
            .mutate_schedule(ctx.clone(), command, Change::Create(request.input))
            .await?;
        Ok(ControlCommit {
            revision: commit.revision,
            value: self.account_schedule(ctx, commit.value).await?,
        })
    }
    pub async fn update_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateSchedule>,
    ) -> Result<ControlCommit<AgentSchedule>, PortError> {
        let command = Command::new(request.identity, "update-schedule", &request.input)?;
        let commit = self
            .mutate_schedule(ctx.clone(), command, Change::Update(request.input))
            .await?;
        Ok(ControlCommit {
            revision: commit.revision,
            value: self.account_schedule(ctx, commit.value).await?,
        })
    }
    pub async fn delete_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteSchedule>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(request.identity, "delete-schedule", &request.input)?;
        let commit = self
            .mutate_schedule(ctx, command, Change::Delete(request.input))
            .await?;
        Ok(ControlCommit {
            revision: commit.revision,
            value: (),
        })
    }
}

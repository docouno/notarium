use super::*;

/// Maximum serialized request size hashed by `Command::new_with_limit` for
/// schedule mutations. Valid `<= 32 KiB` UTF-8 `init_prompt` strings can
/// expand up to 6x under JSON escaping (~196 KiB) plus up to 32 approved
/// skills (~6 KiB); using a 256 KiB hashing cap preserves bit-for-bit
/// `0001` BLAKE3 fingerprints while accepting every contract-valid prompt.
const SCHEDULE_COMMAND_HASH_LIMIT: usize = 256 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedScheduleReceipt {
    id: ScheduleId,
    owner: PrincipalId,
    approved_skills: Vec<AbilityRef>,
    paused_reason: Option<SchedulePauseReason>,
    revision: ControlRevision,
    config_revision: ControlRevision,
    next_slot: Option<Timestamp>,
}

/// Content-free schedule command receipt persisted in `control_commands.safe_result`
/// (omitting private `title` and `init_prompt` so deletion erasure holds and
/// `safe_result` stays well within the 64 KiB cap), with backwards-compatible
/// decoding of pre-upgrade `0001` bare `ScheduleId` receipts.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum StoredScheduleResult {
    Receipt(Option<SavedScheduleReceipt>),
    Legacy(ScheduleId),
}

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
    ) -> PortFuture<'a, ControlCommit<Option<AgentSchedule>>> {
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
            let (approved, mut schedule_pin) = match prechecked {
                Ok(Some(pin)) => (Ok(Some(pin.abilities().to_vec())), Some(pin)),
                Ok(None) => (Ok(None), None),
                Err(error) => (Err(error), None),
            };
            let mut tx = match self.store.write(budget.clone()).await {
                Ok(tx) => tx,
                Err(error) => {
                    if let Some(mut pin) = schedule_pin.take() {
                        let _ = pin.close().await;
                    }
                    return Err(error);
                }
            };
            if let Some(pin) = schedule_pin.take() {
                tx.hold_schedule_pin(pin);
            }
            let (revision, committed_value, events, enqueued) = budget.run(async {
            let (owner,_) = self.scoped_manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            let auth = self.revalidate(tx.inner_mut(),ctx.auth()).await?;
            let current = AccountContext::new(auth,budget.context(ctx.budget.request.clone()));
            let locked_row = match &change {
                Change::Create(input) => {
                    ScheduleScope::from(&input.definition).check(current.auth())?;
                    None
                }
                Change::Update(input) => {
                    ScheduleScope::from(&input.definition).check(current.auth())?;
                    // All current memberships were locked before this schedule.
                    let row = schedule(tx.inner_mut(),&input.schedule,true).await?;
                    if row.owner_id!=owner.user_id {return Err(DomainError::ResourceNotFound.into());}
                    let prev_space = SpaceId::parse(&row.space_id)?;
                    let prev_project = row
                        .project_folder_id
                        .as_deref()
                        .map(|folder| {
                            Ok::<_, PortError>(FolderRef {
                                space_id: prev_space.clone(),
                                folder_id: FolderId::parse(folder)?,
                            })
                        })
                        .transpose()?;
                    ScheduleScope {
                        space: &prev_space,
                        project: prev_project.as_ref(),
                    }
                    .check_existing(current.auth())?;
                    Some(row)
                }
                Change::Delete(input) => {
                    // Deletion of one's known schedule remains possible after a
                    // project or role disappears, without loading its content,
                    // while still enforcing space role, write class, project_root,
                    // and cross-space taint before replay or commit.
                    let row = schedule(tx.inner_mut(),&input.schedule,true).await?;
                    if row.owner_id!=owner.user_id {return Err(DomainError::ResourceNotFound.into());}
                    let space = SpaceId::parse(&row.space_id)?;
                    let project = row
                        .project_folder_id
                        .as_deref()
                        .map(|folder| {
                            Ok::<_, PortError>(FolderRef {
                                space_id: space.clone(),
                                folder_id: FolderId::parse(folder)?,
                            })
                        })
                        .transpose()?;
                    ScheduleScope {
                        space: &space,
                        project: project.as_ref(),
                    }
                    .check_existing(current.auth())?;
                    Some(row)
                }
            };
            if let Some((revision, saved)) = command.replay::<StoredScheduleResult>(tx.inner_mut()).await? {
                let replayed = match (saved.value, change) {
                    (StoredScheduleResult::Receipt(Some(receipt)), Change::Create(input)) => {
                        Some(AgentSchedule {
                            id: receipt.id,
                            owner: receipt.owner,
                            definition: input.definition,
                            approved_skills: receipt.approved_skills,
                            paused_reason: receipt.paused_reason,
                            revision: receipt.revision,
                            config_revision: receipt.config_revision,
                            next_slot: receipt.next_slot,
                        })
                    }
                    (StoredScheduleResult::Receipt(Some(receipt)), Change::Update(input)) => {
                        Some(AgentSchedule {
                            id: receipt.id,
                            owner: receipt.owner,
                            definition: input.definition,
                            approved_skills: receipt.approved_skills,
                            paused_reason: receipt.paused_reason,
                            revision: receipt.revision,
                            config_revision: receipt.config_revision,
                            next_slot: receipt.next_slot,
                        })
                    }
                    (StoredScheduleResult::Receipt(None), Change::Delete(_))
                    | (StoredScheduleResult::Legacy(_), Change::Delete(_)) => None,
                    (StoredScheduleResult::Legacy(id), Change::Create(_)) => {
                        let row = schedule(tx.inner_mut(), &id, false).await?;
                        if row.owner_id != owner.user_id || row.deleted_at.is_some() {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let row_space = SpaceId::parse(&row.space_id)?;
                        let row_project = row
                            .project_folder_id
                            .as_deref()
                            .map(|folder| {
                                Ok::<_, PortError>(FolderRef {
                                    space_id: row_space.clone(),
                                    folder_id: FolderId::parse(folder)?,
                                })
                            })
                            .transpose()?;
                        ScheduleScope {
                            space: &row_space,
                            project: row_project.as_ref(),
                        }
                        .check_existing(current.auth())?;
                        Some(schedule_info(&row)?)
                    }
                    (StoredScheduleResult::Legacy(id), Change::Update(_)) => {
                        let row = match locked_row {
                            Some(row) if row.schedule_id == id.as_str() => row,
                            _ => schedule(tx.inner_mut(), &id, false).await?,
                        };
                        if row.owner_id != owner.user_id || row.deleted_at.is_some() {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        Some(schedule_info(&row)?)
                    }
                    _ => return Err(invalid(ValidationReason::InvalidState)),
                };
                return Ok((revision, replayed, saved.events, Vec::new()));
            }
            expect_revision(&owner,command.identity.expected)?;
            let now = self.clock.now_ms()?;
            let (id, committed_schedule, revoke) = match change {
                Change::Create(input) => {
                    validate(&input.definition,Some(input.next_slot),self.config.schedule_limits,false)?;
                    let scope = ScheduleScope::from(&input.definition);
                    scope.check_mint(current.auth(), owner.personal_space_id.as_deref())?;
                    let descriptors = approved
                        .as_ref()
                        .map_err(Clone::clone)?
                        .as_deref()
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                    if !self.verify_schedule_approval_db(tx.inner_mut(),&current,scope,descriptors).await? {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    if rows!(tx.inner_mut(),(i64,),fetch_optional,"SELECT CAST(1 AS BIGINT) FROM agent_schedules WHERE schedule_id=$1","SELECT CAST(1 AS BIGINT) FROM v1_control.agent_schedules WHERE schedule_id=$1";input.id.as_str())?.is_some() {return Err(DomainError::IdempotencyKeyReused.into());}
                    let row = AgentSchedulesRow {
                        schedule_id:input.id.to_string(),owner_id:owner.user_id.clone(),space_id:input.definition.space.to_string(),
                        project_folder_id:input.definition.project.as_ref().map(|p|p.folder_id.to_string()),title:input.definition.title,init_prompt:input.definition.init_prompt,
                        cron_expr:input.definition.cron,timezone:input.definition.timezone,approved_role:json(&input.definition.approved_role)?,
                        approved_skills:json(&input.approved_skills)?,
                        paused_reason:input.paused.then(||"manual".into()),write_class_mask:1,budgets:json(&input.definition.limits)?,misfire_policy:"coalesce_latest".into(),
                        next_slot_utc_ms:Some(ms(input.next_slot)?),deleted_at:None,revision:0,config_revision:0,created_at:now,updated_at:now,
                    };
                    let info = schedule_info(&row)?;
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
                    (input.id, Some(info), false)
                }
                Change::Update(input) => {
                    let row = locked_row.expect("update pre-locked schedule");
                    if row.owner_id!=owner.user_id || row.deleted_at.is_some() {return Err(DomainError::ResourceNotFound.into());}
                    expect(&row,input.expected)?;
                    if row.space_id!=input.definition.space.as_str() {return Err(invalid(ValidationReason::ScopeMismatch));}
                    let previous = schedule_info(&row)?;
                    let scope = ScheduleScope::from(&input.definition);
                    scope.check(current.auth())?;
                    let calendar_unchanged = input.definition.cron == previous.definition.cron
                        && input.definition.timezone == previous.definition.timezone;
                    if !pause_only(&input, &previous) {
                        scope.check_mint(current.auth(), owner.personal_space_id.as_deref())?;
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
                        if input.next_slot != previous.next_slot && let Some(slot) = input.next_slot {
                            let slot = ms(slot)?;
                            // Run receipts have finite retention. Only the existing due
                            // can be kept for catch-up once its UTC instant has passed.
                            if slot < now || runs::slot_receipt(tx.inner_mut(), &input.schedule, slot).await?.is_some() {
                                return Err(invalid(ValidationReason::InvalidTimestamp));
                            }
                        }
                        let descriptors = approved
                            .as_ref()
                            .map_err(Clone::clone)?
                            .as_deref()
                            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                        if !self.verify_schedule_approval_db(tx.inner_mut(),&current,scope,descriptors).await? {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                    }
                    let project = input.definition.project.as_ref().map(|p|p.folder_id.to_string());
                    let approved = json(&input.definition.approved_role)?;
                    let skills = json(input.approved_skills.as_ref().unwrap_or(&previous.approved_skills))?;
                    let limits = json(&input.definition.limits)?;
                    let next_slot_ms = input.next_slot.map(ms).transpose()?;
                    let reason:Option<&str> = input.paused.then_some("manual");
                    let next_rev = next(row.revision)?;
                    let next_config_rev = next(row.config_revision)?;
                    let updated_row = AgentSchedulesRow {
                        schedule_id: row.schedule_id.clone(),
                        owner_id: row.owner_id.clone(),
                        space_id: row.space_id.clone(),
                        project_folder_id: project.clone(),
                        title: input.definition.title.clone(),
                        init_prompt: input.definition.init_prompt.clone(),
                        cron_expr: input.definition.cron.clone(),
                        timezone: input.definition.timezone.clone(),
                        approved_role: approved.clone(),
                        approved_skills: skills.clone(),
                        paused_reason: reason.map(str::to_owned),
                        write_class_mask: row.write_class_mask,
                        budgets: limits.clone(),
                        misfire_policy: row.misfire_policy.clone(),
                        next_slot_utc_ms: next_slot_ms,
                        deleted_at: None,
                        revision: next_rev,
                        config_revision: next_config_rev,
                        created_at: row.created_at,
                        updated_at: now,
                    };
                    let info = schedule_info(&updated_row)?;
                    execute!(tx.inner_mut(),
                        "UPDATE agent_schedules SET project_folder_id=$1,title=$2,init_prompt=$3,cron_expr=$4,timezone=$5,approved_role=$6,approved_skills=$7,budgets=$8,next_slot_utc_ms=$9,paused_reason=$10,revision=$11,config_revision=$12,updated_at=$13 WHERE schedule_id=$14",
                        "UPDATE v1_control.agent_schedules SET project_folder_id=$1,title=$2,init_prompt=$3,cron_expr=$4,timezone=$5,approved_role=$6,approved_skills=$7,budgets=$8,next_slot_utc_ms=$9,paused_reason=$10,revision=$11,config_revision=$12,updated_at=$13 WHERE schedule_id=$14";
                        project,&input.definition.title,&input.definition.init_prompt,&input.definition.cron,&input.definition.timezone,approved,skills,limits,next_slot_ms,reason,next_rev,next_config_rev,now,input.schedule.as_str())?;
                    (input.schedule, Some(info), true)
                }
                Change::Delete(input) => {
                    let row = locked_row.expect("delete pre-locked schedule");
                    if row.owner_id!=owner.user_id || row.deleted_at.is_some() {return Err(DomainError::ResourceNotFound.into());}
                    expect(&row,input.expected)?;
                    execute!(tx.inner_mut(),"UPDATE agent_schedules SET title='',init_prompt='',deleted_at=$1,revision=$2,config_revision=$3,updated_at=$1 WHERE schedule_id=$4","UPDATE v1_control.agent_schedules SET title='',init_prompt='',deleted_at=$1,revision=$2,config_revision=$3,updated_at=$1 WHERE schedule_id=$4";now,next(row.revision)?,next(row.config_revision)?,input.schedule.as_str())?;
                    (input.schedule, None, true)
                }
            };
            let revision = next(owner.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
            let mut events = Vec::new();
            if revoke {events.push(super::super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Schedule(id.clone()),RevocationReason::PermissionChanged,revision,now).await?);}
            let revision = ControlRevision::new(revision as u64)?;
            let saved_receipt = committed_schedule.as_ref().map(|info| SavedScheduleReceipt {
                id: info.id.clone(),
                owner: info.owner.clone(),
                approved_skills: info.approved_skills.clone(),
                paused_reason: info.paused_reason,
                revision: info.revision,
                config_revision: info.config_revision,
                next_slot: info.next_slot,
            });
            let saved = SavedResult {
                value: StoredScheduleResult::Receipt(saved_receipt),
                events: events.clone(),
            };
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            let enqueued = events.clone();
            Ok((revision,committed_schedule,events,enqueued))
        },CommitEffect::NotCommitted).await?;
            self.commit_revocations(tx, &budget, &enqueued).await?;
            for event in &events {
                self.flush_event(&budget, event).await?;
            }
            Ok(ControlCommit {
                revision,
                value: committed_value,
            })
        })
    }
    pub async fn create_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSchedule>,
    ) -> Result<ControlCommit<AgentSchedule>, PortError> {
        let command = Command::new_with_limit(
            request.identity,
            "create-schedule",
            &request.input,
            SCHEDULE_COMMAND_HASH_LIMIT,
        )?;
        let commit = self
            .mutate_schedule(ctx, command, Change::Create(request.input))
            .await?;
        Ok(ControlCommit {
            revision: commit.revision,
            value: commit
                .value
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
        })
    }
    pub async fn update_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateSchedule>,
    ) -> Result<ControlCommit<AgentSchedule>, PortError> {
        let command = Command::new_with_limit(
            request.identity,
            "update-schedule",
            &request.input,
            SCHEDULE_COMMAND_HASH_LIMIT,
        )?;
        let commit = self
            .mutate_schedule(ctx, command, Change::Update(request.input))
            .await?;
        Ok(ControlCommit {
            revision: commit.revision,
            value: commit
                .value
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
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

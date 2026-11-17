use super::*;

impl ControlService {
    pub async fn claim_schedule(
        &self,
        ctx: MaintenanceContext,
        request: ClaimSchedule,
    ) -> Result<ScheduleClaim, PortError> {
        Box::pin(async move {
        ctx.authority.require(ServicePurpose::Scheduler)?;
        let slot = ms(request.slot)?;
        let next_slot = ms(request.next_slot)?;
        let now = self.clock.now_ms()?;
        if next_slot <= slot || slot > now {
            return Err(invalid(ValidationReason::InvalidTimestamp));
        }
        let fingerprint = blake3::hash(json(&(1, &request))?.as_bytes())
            .as_bytes()
            .to_vec();
        let budget = OperationBudget::new(ctx.budget.clone());
        let observed = self.observe_schedule(&budget, &request.schedule).await?;
        let prechecked_catalog = if observed.deleted_at.is_none() && observed.paused_reason.is_none() {
            let observed_info = schedule_info(&observed)?;
            let space = SpaceId::parse(&observed.space_id)?;
            let mut rtx = self.store.read(budget.clone()).await?;
            let probe_source = budget
                .run(
                    async {
                        let owner = user_read(rtx.inner_mut(), &observed.owner_id).await?;
                        self.schedule_source(
                            rtx.inner_mut(),
                            &owner,
                            &space,
                            AuthenticatedCredential::ScheduledRun {
                                schedule: request.schedule.clone(),
                                run: AgentRunId::from_bytes([0; 16]),
                                lease: LeaseEpoch::new(1)?,
                            },
                            grant("scheduled-run-probe", request.schedule.as_str()),
                            false,
                        )
                        .await
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget
                .run(rtx.finish(), CommitEffect::NotCommitted)
                .await?;
            if let Some((probe_auth, _)) = probe_source {
                let keeper = probe_auth.for_keeper(
                    AgentRunId::from_bytes([0; 16]),
                    space.clone(),
                    observed_info
                        .definition
                        .project
                        .as_ref()
                        .map(|p| p.folder_id.clone()),
                    BTreeSet::from([observed_info.definition.approved_role.id.clone()]),
                )?;
                let current = AccountContext::new(keeper, budget.context(ctx.budget.request.clone()));
                Some(
                    budget
                        .run(
                            async {
                                let facts = self.catalog_space(&current, &space).await?;
                                if let Some(project) = &observed_info.definition.project {
                                    self.catalog_project(&current, project).await?;
                                }
                                let raw = match self
                                    .raw_ability(
                                        &current,
                                        observed_info.definition.approved_role.identity(),
                                    )
                                    .await
                                {
                                    Ok(raw) => Some(raw),
                                    Err(error) if hidden(&error) => None,
                                    Err(error) => return Err(error),
                                };
                                Ok::<_, PortError>((observed.config_revision, facts.history, raw))
                            },
                            CommitEffect::NotCommitted,
                        )
                        .await,
                )
            } else {
                None
            }
        } else {
            None
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let (result,events)=budget.run(async {
            let owner=user(tx.inner_mut(),&observed.owner_id).await?;
            let run=AgentRunId::from_bytes(crate::auth::token::random()?);
            let lease=LeaseEpoch::new(1)?;
            let space=SpaceId::parse(&observed.space_id)?;
            let credential=AuthenticatedCredential::ScheduledRun{schedule:request.schedule.clone(),run:run.clone(),lease};
            let source=self.schedule_source(tx.inner_mut(),&owner,&space,credential,grant("scheduled-run",run.as_str()),true).await?;
            let row=schedule(tx.inner_mut(),&request.schedule,true).await?;
            let previous=rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms=$2","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms=$2";request.schedule.as_str(),slot)?;
            if let Some(previous)=previous {
                if previous.claim_request_hash!=fingerprint {return Err(DomainError::IdempotencyKeyReused.into());}
                return Ok((ScheduleClaim::AlreadyClaimed(receipt(&previous)?),Vec::new()));
            }
            if row.deleted_at.is_some() {return Err(DomainError::ResourceNotFound.into());}
            let mut info=schedule_info(&row)?;
            if let Some(reason)=info.paused_reason {return Ok((ScheduleClaim::Paused(reason),Vec::new()));}
            expect(&row,request.expected)?;
            if row.next_slot_utc_ms!=slot || request.current_role!=info.definition.approved_role {return Err(invalid(ValidationReason::ScopeMismatch));}
            validate(&info.definition,request.next_slot,RunLimits::HARD_CEILING)?;
            let mut reason=None;
            let mut admitted=None;
            if !info.definition.limits.fits(self.config.schedule_limits) {reason=Some(SchedulePauseReason::BudgetExceeded);}
            else if let Some((source,admission))=source {
                let keeper=source.for_keeper(run.clone(),space.clone(),info.definition.project.as_ref().map(|p|p.folder_id.clone()),BTreeSet::from([info.definition.approved_role.id.clone()]))?;
                let current=AccountContext::new(keeper.clone(),budget.context(ctx.budget.request.clone()));
                match prechecked_catalog {
                    None => return Err(DomainError::ControlRevisionConflict{current:ControlRevision::new(row.revision as u64)?}.into()),
                    Some(Err(error)) if hidden(&error)=>reason=Some(SchedulePauseReason::SpaceUnavailable),
                    Some(Err(error))=>return Err(error),
                    Some(Ok((observed_cfg,history,raw_opt)))=>{
                        if observed_cfg != row.config_revision {
                            return Err(DomainError::ControlRevisionConflict{current:ControlRevision::new(row.revision as u64)?}.into());
                        }
                        if let Some(raw) = raw_opt
                            && raw.reference == info.definition.approved_role
                            && self
                                .current_role_db_only(
                                    tx.inner_mut(),
                                    &current,
                                    raw,
                                    info.definition.project.as_ref(),
                                )
                                .await?
                        {
                            admitted = Some((keeper, admission, history));
                        } else {
                            reason = Some(SchedulePauseReason::RoleChanged);
                        }
                    }
                }
            } else {
                let admission=super::super::spaces::admission(tx.inner_mut(),&space,false).await?;
                reason=Some(if admission.state!="active" {SchedulePauseReason::SpaceUnavailable} else {SchedulePauseReason::OwnerRevoked});
            }
            let now=self.clock.now_ms()?;
            if let Some(reason)=reason {
                let label:String=parse(&json(&reason)?)?;
                let revision=next(row.revision)?;
                execute!(tx.inner_mut(),"UPDATE agent_schedules SET paused_reason=$1,revision=$2,config_revision=$3,updated_at=$4 WHERE schedule_id=$5","UPDATE v1_control.agent_schedules SET paused_reason=$1,revision=$2,config_revision=$3,updated_at=$4 WHERE schedule_id=$5";label,revision,next(row.config_revision)?,now,request.schedule.as_str())?;
                let event=super::super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Schedule(request.schedule.clone()),RevocationReason::PermissionChanged,revision,now).await?;
                return Ok((ScheduleClaim::Paused(reason),vec![event]));
            }
            let (keeper,admission,history)=admitted.ok_or_else(||invalid(ValidationReason::InvalidState))?;
            let expires_at=now.checked_add(info.definition.limits.timeout_ms as i64).ok_or_else(||invalid(ValidationReason::InvalidTimestamp))?;
            let record=TargetRecord::from(AgentScheduleRunsRow{
                run_id:run.to_string(),schedule_id:request.schedule.to_string(),slot_utc_ms:slot,lease_epoch:1,
                claim_request_hash:fingerprint,claimed_schedule_revision:row.revision,reserved_next_slot:next_slot,status:"claimed".into(),
                started_at:now,finished_at:None,safe_result:None,owner_auth_version:owner.auth_version,config_revision:row.config_revision,
                admission_epoch:admission.admission_epoch,history_scope:json(&history)?,expires_at,
            }); record.validate()?;record.insert(tx.inner_mut()).await?;
            let revision=next(row.revision)?;
            execute!(tx.inner_mut(),"UPDATE agent_schedules SET next_slot_utc_ms=$1,revision=$2,updated_at=$3 WHERE schedule_id=$4","UPDATE v1_control.agent_schedules SET next_slot_utc_ms=$1,revision=$2,updated_at=$3 WHERE schedule_id=$4";next_slot,revision,now,request.schedule.as_str())?;
            info.next_slot=request.next_slot;info.revision=ControlRevision::new(revision as u64)?;
            let context=SpaceContext::new(keeper,history,CallBudget{request:ctx.budget.request.clone(),cancellation:Cancellation::default(),remaining:Duration::from_millis(info.definition.limits.timeout_ms)})?;
            Ok((ScheduleClaim::Claimed{run,lease,schedule:Box::new(info),context:Box::new(context)},Vec::new()))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &events).await?;
        for event in &events {
            self.flush_event(&budget, event).await?;
        }
        Ok(result)
        })
        .await
    }
    pub async fn record_schedule_result(
        &self,
        ctx: MaintenanceContext,
        result: ScheduleResult,
    ) -> Result<ScheduleRunReceipt, PortError> {
        ctx.authority.require(ServicePurpose::Scheduler)?;
        let budget = OperationBudget::new(ctx.budget);
        let observed = self.observe_schedule(&budget, &result.schedule).await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (receipt,events)=budget.run(async {
            // Terminal audit is independent of the old credential's expiration
            // or deletion, but uses the same owner -> schedule -> run lock order.
            user(tx.inner_mut(),&observed.owner_id).await?;
            schedule(tx.inner_mut(),&result.schedule,false).await?;
            let mut row=rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE run_id=$1 AND schedule_id=$2","SELECT * FROM v1_control.agent_schedule_runs WHERE run_id=$1 AND schedule_id=$2 FOR UPDATE";result.run.as_str(),result.schedule.as_str())?.ok_or(DomainError::ResourceNotFound)?;
            if row.lease_epoch as u64!=result.lease.get() {return Err(invalid(ValidationReason::GenerationMismatch));}
            let status:String=parse(&json(&result.outcome)?)?;
            if !matches!(row.status.as_str(),"claimed"|"running") {
                if row.status!=status {return Err(invalid(ValidationReason::InvalidState));}
                let events=super::super::outbox::pending(tx.inner_mut(),RevocationSelector::ScheduledRun(result.run.clone())).await?;
                return Ok((receipt(&row)?,events));
            }
            let now=self.clock.now_ms()?;
            execute!(tx.inner_mut(),"UPDATE agent_schedule_runs SET status=$1,finished_at=$2 WHERE run_id=$3","UPDATE v1_control.agent_schedule_runs SET status=$1,finished_at=$2 WHERE run_id=$3";&status,now,result.run.as_str())?;
            row.status=status;row.finished_at=Some(now);
            let event=super::super::outbox::enqueue(tx.inner_mut(),RevocationSelector::ScheduledRun(result.run.clone()),RevocationReason::Expired,row.lease_epoch,now).await?;
            Ok((receipt(&row)?,vec![event]))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &events).await?;
        for event in &events {
            self.flush_event(&budget, event).await?;
        }
        Ok(receipt)
    }
}

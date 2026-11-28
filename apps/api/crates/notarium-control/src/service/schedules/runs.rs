use super::*;

enum ClaimedApproval {
    SpaceUnavailable,
    RoleChanged,
    Ready(Box<dyn ScheduleAbilityLease>),
}

impl ControlService {
    async fn precheck_schedule_claim(
        &self,
        ctx: &MaintenanceContext,
        budget: &OperationBudget,
        observed: &AgentSchedulesRow,
    ) -> Result<Option<ClaimedApproval>, PortError> {
        let info = schedule_info(observed)?;
        let scope = ScheduleScope::from(&info.definition);
        let probe_run = AgentRunId::from_bytes([0; 16]);
        let mut rtx = self.store.read(budget.clone()).await?;
        let source = budget
            .run(
                async {
                    let owner = user_read(rtx.inner_mut(), &observed.owner_id).await?;
                    self.schedule_source(
                        rtx.inner_mut(),
                        &owner,
                        scope.space,
                        AuthenticatedCredential::ScheduledRun {
                            schedule: info.id.clone(),
                            run: probe_run.clone(),
                            lease: LeaseEpoch::new(1)?,
                        },
                        grant("scheduled-run-probe", info.id.as_str()),
                        false,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let Some((auth, _)) = source? else {
            return Ok(None);
        };
        let keeper = scope.keeper(
            &auth,
            probe_run,
            package_ids(&info.definition.approved_role, &info.approved_skills),
            system_package_ids(&info.definition.approved_role, &info.approved_skills),
        )?;
        let current = AccountContext::new(keeper, budget.context(ctx.budget.request.clone()));
        budget
            .run(
                async {
                    let history = match self.schedule_history(&current, scope).await {
                        Ok(history) => history,
                        Err(error) if hidden(&error) => {
                            return Ok(Some(ClaimedApproval::SpaceUnavailable));
                        }
                        Err(error) => return Err(error),
                    };
                    match self
                        .pin_schedule_approval(
                            current,
                            scope,
                            &info.definition.approved_role,
                            &info.approved_skills,
                        )
                        .await?
                    {
                        None => Ok(Some(ClaimedApproval::RoleChanged)),
                        Some(mut pin) => {
                            if let Err(error) = history.check(pin.history()) {
                                let _ = pin.close().await;
                                return Err(error.into());
                            }
                            Ok(Some(ClaimedApproval::Ready(pin)))
                        }
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await
    }

    pub async fn claim_schedule(
        &self,
        ctx: MaintenanceContext,
        request: ClaimSchedule,
    ) -> Result<ScheduleClaim, PortError> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Scheduler)?;
            let slot = ms(request.slot)?;
            let observed_at = self.clock.now_ms()?;
            if slot > observed_at {
                return Err(invalid(ValidationReason::InvalidTimestamp));
            }
            let fingerprint = blake3::hash(json(&(1, &request))?.as_bytes()).as_bytes().to_vec();
            let budget = OperationBudget::new(ctx.budget.clone());
            let observed = self.observe_schedule(&budget, &request.schedule).await?;
            let prechecked = if observed.deleted_at.is_none()
                && observed.paused_reason.is_none()
                && observed.next_slot_utc_ms == Some(slot)
            {
                self.precheck_schedule_claim(&ctx, &budget, &observed).await
            } else {
                Ok(None)
            };

            let (prechecked_claim, mut schedule_pin) = match prechecked {
                Ok(Some(ClaimedApproval::Ready(pin))) => {
                    let snapshot = (pin.abilities().to_vec(), pin.history().clone());
                    (Ok(Some(Ok(snapshot))), Some(pin))
                }
                Ok(Some(ClaimedApproval::SpaceUnavailable)) => {
                    (Ok(Some(Err(SchedulePauseReason::SpaceUnavailable))), None)
                }
                Ok(Some(ClaimedApproval::RoleChanged)) => {
                    (Ok(Some(Err(SchedulePauseReason::RoleChanged))), None)
                }
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
            let (mut result, events, claimed_at) = budget.run(async {
                let owner = user(tx.inner_mut(), &observed.owner_id).await?;
                let run = AgentRunId::from_bytes(crate::auth::token::random()?);
                let lease = LeaseEpoch::new(1)?;
                let space = SpaceId::parse(&observed.space_id)?;
                let credential = AuthenticatedCredential::ScheduledRun {
                    schedule: request.schedule.clone(),
                    run: run.clone(),
                    lease,
                };
                let source = self.schedule_source(
                    tx.inner_mut(), &owner, &space, credential,
                    grant("scheduled-run", run.as_str()), true,
                ).await?;
                let row = schedule(tx.inner_mut(), &request.schedule, true).await?;
                let locked_now = self.clock.now_ms()?;
                if slot > locked_now {
                    return Err(invalid(ValidationReason::InvalidTimestamp));
                }
                let previous = slot_receipt(tx.inner_mut(), &request.schedule, slot).await?;
                if let Some(previous) = &previous {
                    if previous.claim_request_hash == fingerprint {
                        return Ok((ScheduleClaim::AlreadyClaimed(receipt(previous)?), Vec::new(), None));
                    }
                    // Older configurations could rewind the current due to an already
                    // issued slot. Only its live revision may advance past that receipt.
                    let expected = request.expected.get();
                    let current = row.revision as u64;
                    let repairing = row.next_slot_utc_ms == Some(slot) && current == expected;
                    let repaired = row.next_slot_utc_ms != Some(slot) && current == expected.saturating_add(1);
                    if previous.claimed_schedule_revision as u64 >= expected || !(repairing || repaired) {
                        return Err(DomainError::IdempotencyKeyReused.into());
                    }
                }
                if row.deleted_at.is_some() {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let mut info = schedule_info(&row)?;
                if let Some(reason) = info.paused_reason {
                    return Ok((ScheduleClaim::Paused(reason), Vec::new(), None));
                }
                if request.current_role != info.definition.approved_role {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }

                let calendar = Calendar::parse(&info.definition.cron, &info.definition.timezone)?;
                let civil_slot = calendar.civil_slot_ms(slot)?;
                let skipped = if let Some(previous) = previous {
                    Some(ScheduleClaim::SkippedDuplicate(receipt(&previous)?))
                } else if civil_slot != slot {
                    match slot_receipt(tx.inner_mut(), &request.schedule, civil_slot).await? {
                        Some(early) => Some(ScheduleClaim::SkippedDuplicate(receipt(&early)?)),
                        None if locked_now.saturating_sub(civil_slot.max(row.created_at))
                            >= super::super::telemetry::MIN_COMPACT_MS &&
                            missing_cursor_history(tx.inner_mut(), &row, request.expected).await? =>
                            Some(ScheduleClaim::SkippedUnverifiedFold),
                        _ => None,
                    }
                } else {
                    None
                };
                if row.next_slot_utc_ms != Some(slot)
                    && info.revision.get().checked_sub(1) == Some(request.expected.get())
                    && let Some(outcome) = skipped
                {
                    return Ok((outcome, Vec::new(), None));
                }
                expect(&row, request.expected)?;
                if row.next_slot_utc_ms != Some(slot) {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
                // Control authoritatively computes the next due slot under the writer lock
                // from its own clock, eliminating cross-clock retries on the scheduler.
                let trusted_instant = Timestamp::from_unix_parts(locked_now.div_euclid(1000), 0)?;
                let next_slot = calendar.next_ms(request.slot.max(trusted_instant))?;
                if next_slot.is_some_and(|next| next <= slot) {
                    return Err(invalid(ValidationReason::InvalidTimestamp));
                }
                let next_slot_ts = next_slot
                    .map(|value| {
                        let secs = value.div_euclid(1000);
                        let nanos = u32::try_from(value.rem_euclid(1000))
                            .map_err(|_| invalid(ValidationReason::InvalidTimestamp))?
                            .saturating_mul(1_000_000);
                        Timestamp::from_unix_parts(secs, nanos).map_err(PortError::from)
                    })
                    .transpose()?;
                if let Some(outcome) = skipped {
                    advance(tx.inner_mut(), &request.schedule, next_slot, &row, locked_now).await?;
                    return Ok((outcome, Vec::new(), None));
                }
                validate(&info.definition, next_slot_ts, RunLimits::HARD_CEILING, false)?;

                let scope = ScheduleScope::from(&info.definition);
                let log_id = schedule_log_id(
                    &request.schedule,
                    &row.owner_id,
                    &space,
                    scope.project.map(|p| &p.folder_id),
                );
                let (reason, admitted) = if !info.definition.limits.fits(self.config.schedule_limits) {
                    (Some(SchedulePauseReason::BudgetExceeded), None)
                } else if let Some((auth, admission)) = source {
                    if observed.config_revision != row.config_revision {
                        return Err(DomainError::ControlRevisionConflict { current: info.revision }.into());
                    }
                    match prechecked_claim.as_ref().map_err(|error| error.clone())? {
                        None => return Err(DomainError::ControlRevisionConflict { current: info.revision }.into()),
                        Some(Err(reason)) => (Some(*reason), None),
                        Some(Ok((abilities, history))) => {
                            let keeper = scope.keeper(
                                &auth, run.clone(),
                                package_ids(&info.definition.approved_role, &info.approved_skills),
                                system_package_ids(&info.definition.approved_role, &info.approved_skills),
                            )?.with_verified_keeper_log(log_id.clone())?;
                            let current = AccountContext::new(keeper.clone(), budget.context(ctx.budget.request.clone()));
                            if self.verify_schedule_approval_db(tx.inner_mut(), &current, scope, abilities).await? {
                                (None, Some((keeper, admission, history.clone())))
                            } else {
                                (Some(SchedulePauseReason::RoleChanged), None)
                            }
                        }
                    }
                } else {
                    let admission = super::super::spaces::admission(tx.inner_mut(), &space, false).await?;
                    let reason = if admission.state == "active" {
                        SchedulePauseReason::OwnerRevoked
                    } else {
                        SchedulePauseReason::SpaceUnavailable
                    };
                    (Some(reason), None)
                };
                let now = locked_now;
                let claimed_at = std::time::Instant::now();
                if let Some(reason) = reason {
                    let label: String = parse(&json(&reason)?)?;
                    let revision = next(row.revision)?;
                    execute!(tx.inner_mut(),
                        "UPDATE agent_schedules SET paused_reason=$1,revision=$2,config_revision=$3,updated_at=$4 WHERE schedule_id=$5",
                        "UPDATE v1_control.agent_schedules SET paused_reason=$1,revision=$2,config_revision=$3,updated_at=$4 WHERE schedule_id=$5";
                        label,revision,next(row.config_revision)?,now,request.schedule.as_str()
                    )?;
                    let event = super::super::outbox::enqueue(
                        tx.inner_mut(), RevocationSelector::Schedule(request.schedule.clone()),
                        RevocationReason::PermissionChanged, revision, now,
                    ).await?;
                    return Ok((ScheduleClaim::Paused(reason), vec![event], None));
                }
                let (keeper, admission, history) = admitted.ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                let expires_at = now.checked_add(info.definition.limits.timeout_ms as i64)
                    .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                let record = TargetRecord::from(AgentScheduleRunsRow {
                    run_id: run.to_string(),
                    schedule_id: request.schedule.to_string(),
                    slot_utc_ms: slot,
                    lease_epoch: 1,
                    claim_request_hash: fingerprint,
                    claimed_schedule_revision: row.revision,
                    reserved_next_slot: next_slot,
                    approved_skills: row.approved_skills.clone(),
                    keeper_log_id: Some(log_id.to_string()),
                    keeper_project_folder_id: scope.project.map(|project| project.folder_id.to_string()),
                    status: "claimed".into(),
                    started_at: now,
                    finished_at: None,
                    safe_result: None,
                    owner_auth_version: owner.auth_version,
                    config_revision: row.config_revision,
                    admission_epoch: admission.admission_epoch,
                    history_scope: json(&history)?,
                    expires_at,
                });
                record.validate()?;
                record.insert(tx.inner_mut()).await?;
                info.revision = advance(tx.inner_mut(), &request.schedule, next_slot, &row, now).await?;
                info.next_slot = next_slot_ts;
                let context = SpaceContext::new(keeper, history, CallBudget {
                    request: ctx.budget.request.clone(),
                    cancellation: Cancellation::default(),
                    remaining: Duration::from_millis(info.definition.limits.timeout_ms),
                })?;
                Ok((ScheduleClaim::Claimed {
                    run, lease, schedule: Box::new(info), context: Box::new(context),
                }, Vec::new(), Some(claimed_at)))
            }, CommitEffect::NotCommitted).await?;
            self.commit_revocations(tx, &budget, &events).await?;
            for event in &events {
                self.flush_event(&budget, event).await?;
            }
            if let (ScheduleClaim::Claimed { context, .. }, Some(claimed_at)) =
                (&mut result, claimed_at)
            {
                context.budget.remaining = context
                    .budget
                    .remaining
                    .saturating_sub(claimed_at.elapsed());
            }
            Ok(result)
        }).await
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

/// Configuration edits bump both counters; claims and duplicate skips only
/// bump the schedule revision. If receipts explain all prior cursor advances,
/// the absence of an early-fold receipt still proves it was never issued.
async fn missing_cursor_history(
    tx: &mut Transaction,
    row: &AgentSchedulesRow,
    expected: ControlRevision,
) -> Result<bool, PortError> {
    let advances = expected.get().saturating_sub(row.config_revision as u64);
    if advances == 0 {
        return Ok(false);
    }
    let retained = rows!(tx, (i64,), fetch_one,
        "SELECT COUNT(*) FROM agent_schedule_runs WHERE schedule_id=$1",
        "SELECT COUNT(*) FROM v1_control.agent_schedule_runs WHERE schedule_id=$1";
        &row.schedule_id)?
    .0;
    Ok((retained as u64) < advances)
}

pub(super) async fn slot_receipt(
    tx: &mut Transaction,
    schedule: &ScheduleId,
    slot: i64,
) -> Result<Option<AgentScheduleRunsRow>, PortError> {
    rows!(tx,AgentScheduleRunsRow,fetch_optional,
        "SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms=$2",
        "SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms=$2";
        schedule.as_str(),slot)
}

async fn advance(
    tx: &mut Transaction,
    schedule: &ScheduleId,
    next_slot: Option<i64>,
    row: &AgentSchedulesRow,
    now: i64,
) -> Result<ControlRevision, PortError> {
    let revision = next(row.revision)?;
    execute!(tx,
        "UPDATE agent_schedules SET next_slot_utc_ms=$1,revision=$2,updated_at=$3 WHERE schedule_id=$4",
        "UPDATE v1_control.agent_schedules SET next_slot_utc_ms=$1,revision=$2,updated_at=$3 WHERE schedule_id=$4";
        next_slot,revision,now,schedule.as_str()
    )?;
    Ok(ControlRevision::new(revision as u64)?)
}

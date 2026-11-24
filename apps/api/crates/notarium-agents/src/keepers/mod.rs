//! Claim, run, and reconcile autonomous schedules through Control.
mod turn;

use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use notarium_control::service::{ControlClock, compute_next_slot};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, PrincipalKind},
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{AgentRunId, LeaseEpoch, RequestId, ScheduleId, SpaceId},
    ports::{schedules::*, *},
    value::Timestamp,
};
use tokio::{
    sync::Semaphore,
    task::JoinSet,
    time::{Instant, MissedTickBehavior},
};

use crate::{
    chats::ExclusiveDataRoot,
    mcp::{ToolRegistry, derive_digest},
    revocation::RevocationHub,
};

pub const MAX_CONCURRENT_KEEPERS: usize = 8;
const PAGE_SIZE: u16 = 64;
const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperSlot {
    pub schedule: ScheduleId,
    pub space: SpaceId,
    pub slot: Timestamp,
}

/// Shared writer routing, schedule ownership, and revocation for clustered
/// deployments. The same authority participates in provider fences.
/// Provider fences wait for provider sockets only. A revocation must never
/// wait for a scheduler worker or its slot or absence lease, as terminal
/// Control writes deliver revocation while the scheduler still holds a lease.
pub trait ClusterKeeperAuthority: SessionRevocationPort {
    /// Register the current writer for this Space before claiming the slot.
    /// Only one live lease for a schedule may exist, including different slots.
    /// Return None when another owner is responsible or already holds a lease.
    /// On loss of writer ownership cancel the supplied token immediately.
    /// Ordinary scheduled credential revocation goes through the run registry
    /// so the current writer can still audit the terminal outcome.
    fn acquire_slot(
        &self,
        ctx: MaintenanceContext,
        slot: KeeperSlot,
        ownership_lost: Cancellation,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>>;

    /// Give positive evidence that no live owner can still act for this receipt
    /// and prevent registration for that slot until the returned fence drops.
    /// An uncertain or still-live owner is represented by None.
    fn fence_orphan(
        &self,
        ctx: MaintenanceContext,
        run: ScheduleRunReceipt,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TickSummary {
    pub claimed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub unknown: usize,
    pub paused: usize,
    pub skipped_duplicate: usize,
    pub skipped_unverified_fold: usize,
    pub raced: usize,
    pub deferred: usize,
    pub errors: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReconcileSummary {
    pub recorded_unknown: usize,
    pub deferred: usize,
    pub errors: usize,
}

#[derive(Clone)]
pub struct KeeperScheduler {
    inner: Arc<SchedulerState>,
}

struct SchedulerState {
    registry: Arc<ToolRegistry>,
    revocations: Arc<RevocationHub>,
    coordination: Coordination,
    parallelism: Arc<Semaphore>,
}

type LocalSlots = Arc<Mutex<BTreeSet<ScheduleId>>>;

enum Coordination {
    Local(LocalSlots),
    Clustered(Arc<dyn ClusterKeeperAuthority>),
}

struct LocalSlot {
    slots: LocalSlots,
    schedule: ScheduleId,
}

impl RevocationLease for LocalSlot {
    fn check(&self) -> Result<(), PortError> {
        Ok(())
    }
}

impl Drop for LocalSlot {
    fn drop(&mut self) {
        self.slots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.schedule);
    }
}

fn acquire_local(slots: &LocalSlots, schedule: ScheduleId) -> Option<Box<dyn RevocationLease>> {
    slots
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(schedule.clone())
        .then(|| {
            Box::new(LocalSlot {
                slots: Arc::clone(slots),
                schedule,
            }) as Box<dyn RevocationLease>
        })
}

enum SlotAttempt {
    Deferred,
    Raced,
    Duplicate,
    UnverifiedFold,
    Paused,
    Claimed(Result<ScheduleOutcome, PortError>),
}

impl KeeperScheduler {
    /// The trusted DataRoot composition runs a single local scheduler. Worker
    /// clones share its active-slot registry and concurrency limit.
    pub fn new_local(
        registry: Arc<ToolRegistry>,
        revocations: Arc<RevocationHub>,
        _writer: ExclusiveDataRoot,
    ) -> Self {
        Self::new(
            registry,
            revocations,
            Coordination::Local(LocalSlots::default()),
        )
    }

    pub fn new_clustered(
        registry: Arc<ToolRegistry>,
        revocations: Arc<RevocationHub>,
        authority: Arc<dyn ClusterKeeperAuthority>,
    ) -> Self {
        Self::new(registry, revocations, Coordination::Clustered(authority))
    }

    fn new(
        registry: Arc<ToolRegistry>,
        revocations: Arc<RevocationHub>,
        coordination: Coordination,
    ) -> Self {
        Self {
            inner: Arc::new(SchedulerState {
                registry,
                revocations,
                coordination,
                parallelism: Arc::new(Semaphore::new(MAX_CONCURRENT_KEEPERS)),
            }),
        }
    }

    /// Complete the schedules that were due at this cut, at most one slot per
    /// schedule. Durable Control CAS chooses the winner across pollers.
    pub async fn tick(&self, now: Timestamp) -> Result<TickSummary, PortError> {
        let mut jobs = JoinSet::new();
        let mut summary = TickSummary::default();
        let started = Instant::now();
        let pages = self
            .enqueue_due(
                now,
                None,
                Some(started),
                &Cancellation::default(),
                &mut jobs,
                &mut summary,
            )
            .await;
        // Drain admitted work even if a later list page failed.
        while let Some(result) = jobs.join_next().await {
            summarize_attempt(&mut summary, result);
        }
        pages?;
        Ok(summary)
    }

    pub async fn reconcile(&self, now: Timestamp) -> Result<ReconcileSummary, PortError> {
        self.reconcile_until(now, &Cancellation::default()).await
    }

    /// Drive one scheduler generation until cancellation. Reconciliation runs
    /// independently from long provider turns and once on startup.
    pub async fn poll(
        &self,
        clock: Arc<dyn ControlClock>,
        poll_interval: Duration,
        reconcile_interval: Duration,
        cancellation: Cancellation,
    ) -> Result<(), PortError> {
        if poll_interval.is_zero() || reconcile_interval.is_zero() {
            return Err(invalid(ValidationReason::InvalidRange));
        }
        let startup = async {
            self.reconcile_until(clock_now(clock.as_ref())?, &cancellation)
                .await?;
            Ok::<_, PortError>(())
        }
        .await;
        if let Err(error) = startup {
            tracing::warn!(code = error.code(), "keeper startup reconciliation failed");
        }

        let due = async {
            let mut interval = tokio::time::interval(poll_interval);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut jobs = JoinSet::new();
            while wait_tick(&mut interval, &cancellation).await {
                let mut summary = TickSummary::default();
                while let Some(result) = jobs.try_join_next() {
                    summarize_attempt(&mut summary, result);
                }
                let result = match clock_now(clock.as_ref()) {
                    Ok(now) => {
                        self.enqueue_due(
                            now,
                            Some(&clock),
                            None,
                            &cancellation,
                            &mut jobs,
                            &mut summary,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result
                    && !cancellation.is_cancelled()
                {
                    tracing::warn!(code = error.code(), "keeper polling failed");
                }
            }
            let mut summary = TickSummary::default();
            while let Some(result) = jobs.join_next().await {
                summarize_attempt(&mut summary, result);
            }
        };
        let expired = async {
            let mut interval = tokio::time::interval(reconcile_interval);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            interval.tick().await; // Startup already reconciled.
            while wait_tick(&mut interval, &cancellation).await {
                let result = match clock_now(clock.as_ref()) {
                    Ok(now) => self.reconcile_until(now, &cancellation).await.map(|_| ()),
                    Err(error) => Err(error),
                };
                if let Err(error) = result
                    && !cancellation.is_cancelled()
                {
                    tracing::warn!(code = error.code(), "keeper reconciliation failed");
                }
            }
        };
        tokio::join!(due, expired);
        Ok(())
    }

    async fn enqueue_due(
        &self,
        now: Timestamp,
        clock: Option<&Arc<dyn ControlClock>>,
        tick_started: Option<Instant>,
        cancellation: &Cancellation,
        jobs: &mut JoinSet<Result<SlotAttempt, PortError>>,
        summary: &mut TickSummary,
    ) -> Result<(), PortError> {
        let mut continuation = None;
        while !cancellation.is_cancelled() {
            let page = self
                .inner
                .registry
                .control()
                .list_due_schedules(
                    maintenance(
                        ServicePurpose::Scheduler,
                        request_id("due", now, b""),
                        cancellation.clone(),
                    ),
                    now,
                    ControlPageRequest::new(PAGE_SIZE, continuation.take())?,
                )
                .await?;
            for schedule in page.items {
                if jobs.len() >= MAX_CONCURRENT_KEEPERS
                    && let Some(result) = jobs.join_next().await
                {
                    summarize_attempt(summary, result);
                }
                let permit = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(()),
                    result = Arc::clone(&self.inner.parallelism).acquire_owned() => {
                        result.map_err(|_| invalid(ValidationReason::InvalidState))?
                    }
                };
                let worker = self.clone();
                let shutdown = cancellation.clone();
                let clock = clock.cloned();
                jobs.spawn(async move {
                    let _permit = permit;
                    worker
                        .process_schedule(schedule, now, clock, tick_started, shutdown)
                        .await
                });
            }
            let Some(next) = page.continuation else {
                break;
            };
            continuation = Some(next);
        }
        Ok(())
    }

    async fn process_schedule(
        &self,
        schedule: AgentSchedule,
        now: Timestamp,
        clock: Option<Arc<dyn ControlClock>>,
        tick_started: Option<Instant>,
        shutdown: Cancellation,
    ) -> Result<SlotAttempt, PortError> {
        let cancellation = Cancellation::default();
        let ownership_lost = Cancellation::default();
        let work = self.claim_and_run(
            schedule,
            now,
            clock.as_deref(),
            tick_started,
            &cancellation,
            &ownership_lost,
        );
        tokio::pin!(work);
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                cancellation.cancel();
                work.await
            }
            _ = ownership_lost.cancelled() => {
                cancellation.cancel();
                work.await
            },
            result = &mut work => result,
        }
    }

    async fn claim_and_run(
        &self,
        schedule: AgentSchedule,
        now: Timestamp,
        clock: Option<&dyn ControlClock>,
        tick_started: Option<Instant>,
        cancellation: &Cancellation,
        ownership_lost: &Cancellation,
    ) -> Result<SlotAttempt, PortError> {
        if cancellation.is_cancelled() {
            return Ok(SlotAttempt::Deferred);
        }
        let slot = schedule
            .next_slot
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        let scope = KeeperSlot {
            schedule: schedule.id.clone(),
            space: schedule.definition.space.clone(),
            slot,
        };
        let request = request_id("claim", slot, schedule.id.as_str().as_bytes());
        let ctx = maintenance(
            ServicePurpose::Scheduler,
            request.clone(),
            cancellation.clone(),
        );
        let owner = match &self.inner.coordination {
            Coordination::Local(slots) => acquire_local(slots, scope.schedule.clone()),
            Coordination::Clustered(authority) => {
                authority
                    .acquire_slot(ctx.clone(), scope, ownership_lost.clone())
                    .await?
            }
        };
        let Some(mut owner) = owner else {
            return Ok(SlotAttempt::Deferred);
        };
        if cancellation.is_cancelled() || ownership_lost.is_cancelled() {
            return Ok(SlotAttempt::Deferred);
        }
        // A page can wait behind several long turns. Keep its eligibility cut
        // fixed and use the current clock for the next-slot witness.
        let next = |at| {
            compute_next_slot(
                &schedule.definition.cron,
                &schedule.definition.timezone,
                slot,
                at,
            )
        };
        let fresh = clock.map(clock_now).transpose()?.unwrap_or(now);
        let mut claim = ClaimSchedule {
            schedule: schedule.id.clone(),
            slot,
            expected: schedule.revision,
            current_role: schedule.definition.approved_role.clone(),
            next_slot: next(fresh)?,
        };
        owner.check()?;
        let control = self.inner.registry.control();
        let mut result = control.claim_schedule(ctx.clone(), claim.clone()).await;
        let mut tried = std::collections::BTreeSet::from([claim.next_slot]);
        let mut forward_cursor = fresh;
        // Track exact backward frontier `(anchor, upper)` where `next(anchor) == upper`.
        // Rewinding uses bounded O(log(gap)) exponential backoff + binary search to
        // locate the exact immediately preceding occurrence without skipping irregular
        // slots or spinning across long misfire gaps.
        let mut backward_state: Option<(Timestamp, Option<Timestamp>)> =
            (slot < fresh).then_some((fresh, claim.next_slot));
        let mut tried_now_probe = now == fresh;
        const MAX_NEXT_SLOT_RETRIES: usize = 20;
        let advance_untried = |cursor: &mut Timestamp,
                               tried: &std::collections::BTreeSet<Option<Timestamp>>|
         -> Result<Option<Option<Timestamp>>, PortError> {
            let mut candidate = next(*cursor)?;
            loop {
                if !tried.contains(&candidate) {
                    if let Some(ts) = candidate {
                        *cursor = (*cursor).max(ts);
                    }
                    return Ok(Some(candidate));
                }
                let Some(next_ts) = candidate else {
                    return Ok(None);
                };
                *cursor = (*cursor).max(next_ts);
                candidate = next(*cursor)?;
            }
        };
        let rewind_untried = |state: &mut Option<(Timestamp, Option<Timestamp>)>,
                              tried: &std::collections::BTreeSet<Option<Timestamp>>|
         -> Result<Option<Option<Timestamp>>, PortError> {
            while let Some((anchor, upper)) = *state {
                let Some((prev, next_anchor)) = find_previous_slot(slot, anchor, upper, &next)?
                else {
                    *state = None;
                    return Ok(None);
                };
                *state = next_anchor.map(|ts| (ts, Some(prev)));
                let candidate = Some(prev);
                if !tried.contains(&candidate) {
                    return Ok(Some(candidate));
                }
            }
            Ok(None)
        };
        for step in 0..MAX_NEXT_SLOT_RETRIES {
            if !matches!(&result, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidTimestamp)
            {
                break;
            }
            if cancellation.is_cancelled() || ownership_lost.is_cancelled() {
                break;
            }
            let latest = if let Some(clock) = clock {
                let current = clock_now(clock)?;
                if current < slot {
                    // Local clock stepped behind `slot`; advancing `next_slot` cannot satisfy `slot <= observed_at`.
                    break;
                }
                current
            } else if let Some(tick_started) = tick_started {
                advance_timestamp(now, tick_started.elapsed())?
            } else {
                now
            };
            let refreshed = if latest > forward_cursor {
                forward_cursor = latest;
                let latest_candidate = next(latest)?;
                if !tried.contains(&latest_candidate) {
                    if let Some(ts) = latest_candidate {
                        forward_cursor = forward_cursor.max(ts);
                    }
                    Some(latest_candidate)
                } else {
                    match advance_untried(&mut forward_cursor, &tried)? {
                        Some(found) => Some(found),
                        None => rewind_untried(&mut backward_state, &tried)?,
                    }
                }
            } else if !tried_now_probe {
                tried_now_probe = true;
                let probe = next(now)?;
                if !tried.contains(&probe) {
                    Some(probe)
                } else {
                    match advance_untried(&mut forward_cursor, &tried)? {
                        Some(found) => Some(found),
                        None => rewind_untried(&mut backward_state, &tried)?,
                    }
                }
            } else if step % 2 == 1 && backward_state.is_some() {
                match rewind_untried(&mut backward_state, &tried)? {
                    Some(found) => Some(found),
                    None => advance_untried(&mut forward_cursor, &tried)?,
                }
            } else {
                match advance_untried(&mut forward_cursor, &tried)? {
                    Some(found) => Some(found),
                    None => rewind_untried(&mut backward_state, &tried)?,
                }
            };
            let Some(refreshed) = refreshed else {
                break;
            };
            if !tried.insert(refreshed) {
                break;
            }
            owner.check()?;
            claim.next_slot = refreshed;
            result = control.claim_schedule(ctx.clone(), claim.clone()).await;
        }
        match result {
            Ok(ScheduleClaim::Claimed {
                run,
                lease,
                context,
                schedule,
            }) => {
                let mut context = *context;
                let turn_cancellation = Cancellation::default();
                if cancellation.is_cancelled() {
                    turn_cancellation.cancel();
                }
                context.budget.cancellation = turn_cancellation.clone();
                let run_lease = validate_claim(&schedule, &run, lease, &context)
                    .and_then(|()| {
                        self.inner.revocations.register_run(
                            maintenance(
                                ServicePurpose::Revocation,
                                context.budget.request.clone(),
                                turn_cancellation.clone(),
                            ),
                            context.auth(),
                            None,
                            turn_cancellation.clone(),
                        )
                    })
                    .ok();
                let outcome = match &run_lease {
                    Some(run_lease) => {
                        let work = self.run_claimed(
                            &schedule,
                            &run,
                            lease,
                            context,
                            owner.as_mut(),
                            run_lease,
                        );
                        tokio::pin!(work);
                        tokio::select! {
                            biased;
                            () = cancellation.cancelled() => {
                                turn_cancellation.cancel();
                                work.await
                            }
                            outcome = &mut work => outcome,
                        }
                    }
                    None => ScheduleOutcome::Failed,
                };
                // A lost writer cannot terminalize the claim. The current
                // owner reconciles it after durable expiry. Keep `run_lease`
                // alive until `record_result` settles durable status so any
                // waiting `rollback_run` sees the finalized schedule run.
                let result = match owner.check() {
                    Ok(()) if !ownership_lost.is_cancelled() => self
                        .record_result(
                            request,
                            ownership_lost.clone(),
                            ScheduleResult {
                                schedule: schedule.id.clone(),
                                run,
                                lease,
                                outcome,
                            },
                        )
                        .await
                        .map(|_| outcome),
                    Ok(()) => Err(unavailable()),
                    Err(error) => Err(error),
                };
                drop(run_lease);
                Ok(SlotAttempt::Claimed(result))
            }
            Ok(ScheduleClaim::AlreadyClaimed(_)) => Ok(SlotAttempt::Raced),
            Ok(ScheduleClaim::SkippedDuplicate(_)) => Ok(SlotAttempt::Duplicate),
            Ok(ScheduleClaim::SkippedUnverifiedFold) => Ok(SlotAttempt::UnverifiedFold),
            Ok(ScheduleClaim::Paused(_)) => Ok(SlotAttempt::Paused),
            Err(error) if claim_raced(&error) => Ok(SlotAttempt::Raced),
            Err(error) => Err(error),
        }
    }

    async fn run_claimed(
        &self,
        schedule: &AgentSchedule,
        run: &AgentRunId,
        lease: LeaseEpoch,
        mut context: SpaceContext,
        owner: &mut dyn RevocationLease,
        run_lease: &crate::revocation::RunRevocationLease,
    ) -> ScheduleOutcome {
        let result = async move {
            owner.check()?;
            validate_claim(schedule, run, lease, &context)?;
            let checked_at = Instant::now();
            let auth = self
                .inner
                .registry
                .control()
                .revalidate_auth(AccountContext::new(
                    context.auth().clone(),
                    context.budget.clone(),
                ))
                .await?;
            let mut budget = context.budget.clone();
            budget.remaining = budget.remaining.saturating_sub(checked_at.elapsed());
            context = SpaceContext::new(auth, context.scope().clone(), budget)?;
            validate_claim(schedule, run, lease, &context)?;
            owner.check()?;
            run_lease.check()?;
            turn::run_keeper_turn(
                &self.inner.registry,
                &self.inner.revocations,
                run_lease,
                schedule,
                run,
                context,
            )
            .await
        }
        .await;

        match result {
            Ok(()) => ScheduleOutcome::Succeeded,
            Err(error) => {
                tracing::warn!(code = error.code(), "keeper turn finished with an error");
                if unknown_effect(&error) {
                    ScheduleOutcome::Unknown
                } else {
                    ScheduleOutcome::Failed
                }
            }
        }
    }

    async fn reconcile_until(
        &self,
        now: Timestamp,
        cancellation: &Cancellation,
    ) -> Result<ReconcileSummary, PortError> {
        let mut summary = ReconcileSummary::default();
        let mut continuation = None;
        while !cancellation.is_cancelled() {
            let page = self
                .inner
                .registry
                .control()
                .list_expired_schedule_runs(
                    maintenance(
                        ServicePurpose::Scheduler,
                        request_id("expired", now, b""),
                        cancellation.clone(),
                    ),
                    now,
                    ControlPageRequest::new(PAGE_SIZE, continuation.take())?,
                )
                .await?;
            for run in page.items {
                if cancellation.is_cancelled() {
                    return Ok(summary);
                }
                match self.reconcile_run(run, cancellation).await {
                    Ok(true) => summary.recorded_unknown += 1,
                    Ok(false) => summary.deferred += 1,
                    Err(error) => {
                        summary.errors += 1;
                        tracing::warn!(code = error.code(), "keeper run reconciliation failed");
                    }
                }
            }
            let Some(next) = page.continuation else {
                break;
            };
            continuation = Some(next);
        }
        Ok(summary)
    }

    async fn reconcile_run(
        &self,
        receipt: ScheduleRunReceipt,
        cancellation: &Cancellation,
    ) -> Result<bool, PortError> {
        let request = request_id("reconcile", receipt.slot, receipt.run.as_str().as_bytes());
        let fence = match &self.inner.coordination {
            Coordination::Local(slots) => acquire_local(slots, receipt.schedule.clone()),
            Coordination::Clustered(authority) => {
                authority
                    .fence_orphan(
                        maintenance(
                            ServicePurpose::Scheduler,
                            request.clone(),
                            cancellation.clone(),
                        ),
                        receipt.clone(),
                    )
                    .await?
            }
        };
        let Some(fence) = fence else {
            return Ok(false);
        };
        fence.check()?;
        self.record_result(
            request,
            cancellation.clone(),
            ScheduleResult {
                schedule: receipt.schedule,
                run: receipt.run,
                lease: receipt.lease,
                outcome: ScheduleOutcome::Unknown,
            },
        )
        .await?;
        Ok(true)
    }

    async fn record_result(
        &self,
        request: RequestId,
        cancellation: Cancellation,
        result: ScheduleResult,
    ) -> Result<ScheduleRunReceipt, PortError> {
        let control = self.inner.registry.control();
        let first = control
            .record_schedule_result(
                maintenance(
                    ServicePurpose::Scheduler,
                    request.clone(),
                    cancellation.clone(),
                ),
                result.clone(),
            )
            .await;
        if first.as_ref().err().is_some_and(unknown_effect) && !cancellation.is_cancelled() {
            // Exact terminal replay can finish delivery of the revocation outbox
            // after an ambiguous commit. It never executes the turn again.
            return control
                .record_schedule_result(
                    maintenance(ServicePurpose::Scheduler, request, cancellation),
                    result,
                )
                .await;
        }
        first
    }
}

fn validate_claim(
    schedule: &AgentSchedule,
    run: &AgentRunId,
    lease: LeaseEpoch,
    context: &SpaceContext,
) -> Result<(), PortError> {
    let auth = context.auth();
    let credential = AuthenticatedCredential::ScheduledRun {
        schedule: schedule.id.clone(),
        run: run.clone(),
        lease,
    };
    if context.scope().space_id != schedule.definition.space
        || auth.kind() != &PrincipalKind::Keeper(run.clone())
        || auth.credential() != Some(&credential)
        || auth.keeper_log().is_none()
    {
        return Err(invalid(ValidationReason::InvalidAuthority));
    }
    if context.budget.remaining.is_zero() {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(())
}

fn summarize_attempt(
    summary: &mut TickSummary,
    result: Result<Result<SlotAttempt, PortError>, tokio::task::JoinError>,
) {
    match result {
        Ok(Ok(SlotAttempt::Deferred)) => summary.deferred += 1,
        Ok(Ok(SlotAttempt::Raced)) => summary.raced += 1,
        Ok(Ok(SlotAttempt::Duplicate)) => summary.skipped_duplicate += 1,
        Ok(Ok(SlotAttempt::UnverifiedFold)) => summary.skipped_unverified_fold += 1,
        Ok(Ok(SlotAttempt::Paused)) => summary.paused += 1,
        Ok(Ok(SlotAttempt::Claimed(outcome))) => {
            summary.claimed += 1;
            match outcome {
                Ok(ScheduleOutcome::Succeeded) => summary.succeeded += 1,
                Ok(ScheduleOutcome::Failed) => summary.failed += 1,
                Ok(ScheduleOutcome::Unknown) => summary.unknown += 1,
                Err(error) => {
                    summary.errors += 1;
                    tracing::warn!(code = error.code(), "keeper result was not confirmed");
                }
            }
        }
        Ok(Err(error)) => {
            summary.errors += 1;
            tracing::warn!(code = error.code(), "keeper slot claim was not confirmed");
        }
        Err(_) => {
            summary.errors += 1;
            tracing::warn!("keeper worker stopped before confirming its result");
        }
    }
}

fn claim_raced(error: &PortError) -> bool {
    match error {
        PortError::Domain(
            DomainError::ControlRevisionConflict { .. }
            | DomainError::IdempotencyKeyReused
            | DomainError::ResourceNotFound,
        ) => true,
        PortError::Domain(DomainError::ValidationFailed { diagnostic }) => {
            matches!(diagnostic.reason, ValidationReason::ScopeMismatch)
        }
        _ => false,
    }
}

fn advance_timestamp(base: Timestamp, elapsed: Duration) -> Result<Timestamp, PortError> {
    let added_secs = i64::try_from(elapsed.as_secs())
        .map_err(|_| invalid(ValidationReason::InvalidTimestamp))?;
    let total_nanos = u64::from(base.nanosecond()) + u64::from(elapsed.subsec_nanos());
    let carry = (total_nanos / 1_000_000_000) as i64;
    let nanos = (total_nanos % 1_000_000_000) as u32;
    let secs = base
        .unix_seconds()
        .checked_add(added_secs)
        .and_then(|s| s.checked_add(carry))
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    Ok(Timestamp::from_unix_parts(secs, nanos)?)
}

fn unknown_effect(error: &PortError) -> bool {
    match error {
        PortError::Cancelled(failure)
        | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure)
        | PortError::Internal(failure) => failure.effect() == CommitEffect::Unknown,
        PortError::Domain(DomainError::ProviderCallAlreadyStarted { .. }) => true,
        PortError::Domain(_) => false,
    }
}

fn request_id(operation: &str, time: Timestamp, target: &[u8]) -> RequestId {
    let digest = derive_digest(
        "notarium.keepers.request.v1",
        &[
            operation.as_bytes(),
            &time.unix_seconds().to_be_bytes(),
            &time.nanosecond().to_be_bytes(),
            target,
        ],
    );
    RequestId::from_bytes(
        digest.as_bytes()[..16]
            .try_into()
            .expect("sixteen digest bytes"),
    )
}

fn maintenance(
    purpose: ServicePurpose,
    request: RequestId,
    cancellation: Cancellation,
) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: CallBudget {
            request,
            cancellation,
            remaining: MAINTENANCE_TIMEOUT,
        },
    }
}

fn clock_now(clock: &dyn ControlClock) -> Result<Timestamp, PortError> {
    let millis = clock.now_ms()?;
    Ok(Timestamp::from_unix_parts(
        millis.div_euclid(1000),
        (millis.rem_euclid(1000) as u32) * 1_000_000,
    )?)
}

async fn wait_tick(interval: &mut tokio::time::Interval, cancellation: &Cancellation) -> bool {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        _ = interval.tick() => true,
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn unavailable() -> PortError {
    PortError::Unavailable(
        OperationalFailure::new(
            derive_digest("notarium.keepers.owner-unavailable.v1", &[]),
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .expect("valid owner failure"),
    )
}

/// Locate the exact latest schedule occurrence strictly before `upper` (or the
/// latest occurrence at or after `next(slot)` when `upper` is `None`) in
/// bounded `O(log(gap))` `next()` evaluations.
///
/// Returns `Ok(Some((prev, next_anchor)))` where `next_anchor` is the upper
/// search bound for a subsequent rewind step (`None` once `prev` reaches `next(slot)`).
fn find_previous_slot(
    slot: Timestamp,
    anchor: Timestamp,
    upper: Option<Timestamp>,
    next: &impl Fn(Timestamp) -> Result<Option<Timestamp>, DomainError>,
) -> Result<Option<(Timestamp, Option<Timestamp>)>, DomainError> {
    const MAX_PROBES: usize = 64;
    if anchor <= slot {
        return Ok(None);
    }
    let min_cand = next(slot)?;
    if min_cand == upper {
        return Ok(None);
    }
    let slot_sec = slot.unix_seconds();
    let mut hi_sec = anchor.unix_seconds();
    let mut delta: i64 = 60;
    let mut probes: usize = 1;
    let mut lo_sec = slot_sec;
    let mut lo_cand = min_cand;

    // 1. Exponentially step backward from `anchor` until `next(probe) != upper`.
    while probes < MAX_PROBES && hi_sec > slot_sec {
        let probe_sec = hi_sec.saturating_sub(delta).max(slot_sec);
        if probe_sec == slot_sec {
            lo_sec = slot_sec;
            lo_cand = min_cand;
            break;
        }
        probes += 1;
        let cand = next(Timestamp::from_unix_parts(probe_sec, 0)?)?;
        if cand != upper {
            lo_sec = probe_sec;
            lo_cand = cand;
            break;
        }
        hi_sec = probe_sec;
        delta = delta.saturating_mul(2);
    }

    let Some(mut best) = lo_cand else {
        return Ok(None);
    };
    if upper.is_some_and(|u| best >= u) {
        return Ok(None);
    }

    // 2. Fast path: if `next(best) == upper`, `best` is already the exact predecessor.
    if probes < MAX_PROBES {
        probes += 1;
        if next(best)? == upper {
            let next_anchor = (best.unix_seconds() > slot_sec)
                .then(|| Timestamp::from_unix_parts(best.unix_seconds() - 1, 0))
                .transpose()?;
            let next_anchor = next_anchor.filter(|ts| *ts > slot && Some(best) != min_cand);
            return Ok(Some((best, next_anchor)));
        }
    }

    // 3. Binary search `[lo_sec, hi_sec]` where `next(lo_sec) != upper` and
    //    `next(hi_sec) == upper` to converge onto the exact immediate predecessor.
    while probes < MAX_PROBES && hi_sec - lo_sec > 1 {
        let mid_sec = lo_sec + (hi_sec - lo_sec) / 2;
        probes += 1;
        let cand = next(Timestamp::from_unix_parts(mid_sec, 0)?)?;
        if cand == upper {
            hi_sec = mid_sec;
        } else {
            lo_sec = mid_sec;
            if let Some(ts) = cand {
                best = ts;
            }
        }
    }
    let next_anchor = (best.unix_seconds() > slot_sec)
        .then(|| Timestamp::from_unix_parts(best.unix_seconds() - 1, 0))
        .transpose()?;
    let next_anchor = next_anchor.filter(|ts| *ts > slot && Some(best) != min_cand);
    Ok(Some((best, next_anchor)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn find_previous_slot_handles_irregular_weekday_and_multi_slot_crons_in_log_probes() {
        // Trace 1: Mon-Fri 09:00 UTC, misfired Mon -> Thu 09:02 (2.5m backward skew).
        let cron_wk = "0 0 9 * * Mon-Fri *";
        let slot = Timestamp::parse("2026-03-02T09:00:00Z").unwrap(); // Monday
        let anchor = Timestamp::parse("2026-03-05T09:02:00Z").unwrap(); // Thursday
        let upper = compute_next_slot(cron_wk, "UTC", slot, anchor).unwrap(); // Friday 09:00
        assert_eq!(
            upper,
            Some(Timestamp::parse("2026-03-06T09:00:00Z").unwrap())
        );
        let calls = Cell::new(0usize);
        let next = |ts: Timestamp| {
            calls.set(calls.get() + 1);
            compute_next_slot(cron_wk, "UTC", slot, ts)
        };
        let (prev1, next_anchor1) = find_previous_slot(slot, anchor, upper, &next)
            .unwrap()
            .expect("must find Thu 09:00");
        assert_eq!(prev1, Timestamp::parse("2026-03-05T09:00:00Z").unwrap());
        assert!(calls.get() <= 16, "too many probes: {}", calls.get());
        let (prev2, _) = find_previous_slot(slot, next_anchor1.unwrap(), Some(prev1), &next)
            .unwrap()
            .expect("must find Wed 09:00");
        assert_eq!(prev2, Timestamp::parse("2026-03-04T09:00:00Z").unwrap());

        // Trace 2: irregular `0 0,5,10 * * * * *`, 2m backward skew from 10:06:30.
        let cron_irr = "0 0,5,10 * * * * *";
        let slot_irr = Timestamp::parse("2026-03-05T08:00:00Z").unwrap();
        let anchor_irr = Timestamp::parse("2026-03-05T10:06:30Z").unwrap();
        let upper_irr = compute_next_slot(cron_irr, "UTC", slot_irr, anchor_irr).unwrap(); // 10:10:00
        assert_eq!(
            upper_irr,
            Some(Timestamp::parse("2026-03-05T10:10:00Z").unwrap())
        );
        let calls_irr = Cell::new(0usize);
        let next_irr = |ts: Timestamp| {
            calls_irr.set(calls_irr.get() + 1);
            compute_next_slot(cron_irr, "UTC", slot_irr, ts)
        };
        let (prev_irr, _) = find_previous_slot(slot_irr, anchor_irr, upper_irr, &next_irr)
            .unwrap()
            .expect("must find 10:05:00");
        assert_eq!(prev_irr, Timestamp::parse("2026-03-05T10:05:00Z").unwrap());
        assert!(
            calls_irr.get() <= 16,
            "too many probes: {}",
            calls_irr.get()
        );
    }

    #[test]
    fn find_previous_slot_bounds_annual_misfire_and_finite_exhaustion() {
        // Annual `0 0,1 12 1 1 * *`: 11-month misfire must terminate in <= 64 probes (NOT 480k!).
        let cron_ann = "0 0,1 12 1 1 * *";
        let slot = Timestamp::parse("2026-01-01T12:00:00Z").unwrap();
        let anchor = Timestamp::parse("2026-12-01T12:00:00Z").unwrap();
        let upper = compute_next_slot(cron_ann, "UTC", slot, anchor).unwrap(); // 2027-01-01T12:00:00Z
        let calls = Cell::new(0usize);
        let next = |ts: Timestamp| {
            calls.set(calls.get() + 1);
            compute_next_slot(cron_ann, "UTC", slot, ts)
        };
        let (prev, next_anchor) = find_previous_slot(slot, anchor, upper, &next)
            .unwrap()
            .expect("must find 2026-01-01T12:01:00Z");
        assert_eq!(prev, Timestamp::parse("2026-01-01T12:01:00Z").unwrap());
        assert!(next_anchor.is_none());
        assert!(
            calls.get() <= 64,
            "annual gap exceeded probe cap: {}",
            calls.get()
        );

        // Finite schedule exhausted forward (`upper == None`): must find last occurrence 23:59:00.
        let cron_fin = "0 * * * * * 2026";
        let fin_slot = Timestamp::parse("2026-12-31T23:58:00Z").unwrap();
        let fin_anchor = Timestamp::parse("2026-12-31T23:59:05Z").unwrap();
        assert_eq!(
            compute_next_slot(cron_fin, "UTC", fin_slot, fin_anchor).unwrap(),
            None
        );
        let fin_calls = Cell::new(0usize);
        let next_fin = |ts: Timestamp| {
            fin_calls.set(fin_calls.get() + 1);
            compute_next_slot(cron_fin, "UTC", fin_slot, ts)
        };
        let (fin_prev, fin_next) = find_previous_slot(fin_slot, fin_anchor, None, &next_fin)
            .unwrap()
            .expect("must find final occurrence 23:59:00");
        assert_eq!(fin_prev, Timestamp::parse("2026-12-31T23:59:00Z").unwrap());
        assert!(fin_next.is_none());
        assert!(
            fin_calls.get() <= 16,
            "too many probes: {}",
            fin_calls.get()
        );
    }

    #[test]
    fn backward_ntp_jump_fresh_before_now_reaches_both_backward_and_intervening_slots() {
        // If NTP steps the clock backward mid-poll (`fresh < now`), both `forward_cursor`
        // and `backward_state` must anchor at `fresh` where `next(fresh) == claim.next_slot`,
        // so rewinding finds slots < fresh and advancing visits slots in (fresh, now).
        let cron = "0 * * * * * *";
        let slot = Timestamp::parse("2026-03-05T10:00:00Z").unwrap();
        let now = Timestamp::parse("2026-03-05T10:05:30Z").unwrap();
        let fresh = Timestamp::parse("2026-03-05T10:03:30Z").unwrap();
        assert!(fresh < now);
        let next = |ts: Timestamp| compute_next_slot(cron, "UTC", slot, ts);
        let initial = next(fresh).unwrap();
        assert_eq!(
            initial,
            Some(Timestamp::parse("2026-03-05T10:04:00Z").unwrap())
        );

        // Rewinding from `(fresh, initial)` finds 10:03:00 (would return None if anchored at `now`).
        let (prev, _) = find_previous_slot(slot, fresh, initial, &next)
            .unwrap()
            .expect("backward search anchored at fresh must find 10:03:00");
        assert_eq!(prev, Timestamp::parse("2026-03-05T10:03:00Z").unwrap());

        // Advancing from `forward_cursor = fresh` visits 10:05:00 in (fresh, now) without skipping it.
        let mut cursor = fresh;
        let tried = std::collections::BTreeSet::from([initial]);
        let mut candidate = next(cursor).unwrap();
        while tried.contains(&candidate) {
            cursor = cursor.max(candidate.unwrap());
            candidate = next(cursor).unwrap();
        }
        assert_eq!(
            candidate,
            Some(Timestamp::parse("2026-03-05T10:05:00Z").unwrap())
        );
    }
}

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
        let mut cursor = fresh;
        let mut tried_now_probe = false;
        let mut tried_slot_probe = false;
        const MAX_NEXT_SLOT_RETRIES: usize = 16;
        for _ in 0..MAX_NEXT_SLOT_RETRIES {
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
            let refreshed = {
                let latest_candidate = next(latest)?;
                if !tried.contains(&latest_candidate) {
                    cursor = latest;
                    latest_candidate
                } else if !tried_now_probe {
                    tried_now_probe = true;
                    let probe = next(now)?;
                    if !tried.contains(&probe) {
                        cursor = now.min(latest);
                        probe
                    } else {
                        cursor = cursor.max(latest);
                        let mut candidate = next(cursor)?;
                        while tried.contains(&candidate) {
                            let Some(next_ts) = candidate else {
                                break;
                            };
                            cursor = cursor.max(next_ts);
                            candidate = next(cursor)?;
                        }
                        candidate
                    }
                } else if !tried_slot_probe && slot < cursor {
                    tried_slot_probe = true;
                    let probe = next(slot)?;
                    if !tried.contains(&probe) {
                        cursor = slot;
                        probe
                    } else {
                        let mut candidate = next(cursor)?;
                        while tried.contains(&candidate) {
                            let Some(next_ts) = candidate else {
                                break;
                            };
                            cursor = cursor.max(next_ts);
                            candidate = next(cursor)?;
                        }
                        candidate
                    }
                } else {
                    let mut candidate = next(cursor)?;
                    while tried.contains(&candidate) {
                        let Some(next_ts) = candidate else {
                            break;
                        };
                        cursor = cursor.max(next_ts);
                        candidate = next(cursor)?;
                    }
                    candidate
                }
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

use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use notarium_canonical::{
    ArchiveJobClass, CanonicalStore, ClaimedContentJob, JobCompletionOutcome, codec,
    peers::archive_import::ArchiveCommitAuthority,
};
use notarium_control::service::ControlService;
use notarium_core::{
    DomainError,
    auth::JobDelegation,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{ContentDigest, RequestId, SpaceId},
    model::HistoryScope,
    ports::{CallBudget, Cancellation, PageLimit, PortFuture, SpaceContext},
};
use tokio::{sync::Semaphore, task::JoinSet, time::Instant};

const SCOPE_PAGE_SIZE: u16 = 64;
const COMMAND_BUDGET: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug)]
pub struct JobWorkerConfig {
    pub imports: usize,
    pub exports: usize,
    pub blocking_threads: usize,
    pub lease: Duration,
    pub heartbeat: Duration,
    pub idle_poll: Duration,
}

impl Default for JobWorkerConfig {
    fn default() -> Self {
        Self {
            imports: 1,
            exports: 1,
            blocking_threads: 2,
            lease: Duration::from_secs(30),
            heartbeat: Duration::from_secs(10),
            idle_poll: Duration::from_millis(250),
        }
    }
}

impl JobWorkerConfig {
    fn validate(self) -> Result<(), PortError> {
        if self.imports > 16
            || self.exports > 16
            || self.imports + self.exports == 0
            || !(1..=32).contains(&self.blocking_threads)
            || self.heartbeat < Duration::from_millis(1)
            || self
                .heartbeat
                .checked_mul(2)
                .is_none_or(|twice| twice >= self.lease)
            || self.lease > Duration::from_secs(300)
            || self.idle_poll.is_zero()
        {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        Ok(())
    }
}

/// A claimed job with freshly revalidated caller authority. Implementations
/// must apply durable effects through the canonical writer using this fence.
pub struct JobExecution {
    store: CanonicalStore,
    control: Arc<ControlService>,
    claim: ClaimedContentJob,
    delegation: JobDelegation,
    cancellation: Cancellation,
    authority: ArchiveCommitAuthority,
    blocking: Arc<Semaphore>,
    progress: Mutex<(u64, Option<u64>)>,
}

impl JobExecution {
    pub fn claim(&self) -> &ClaimedContentJob {
        &self.claim
    }

    pub fn scope(&self) -> &HistoryScope {
        self.delegation.scope()
    }

    pub fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }

    pub(crate) fn commit_authority(&self) -> ArchiveCommitAuthority {
        self.authority.clone()
    }

    pub fn report_progress(&self, completed: u64, total: Option<u64>) {
        let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        if completed >= progress.0 {
            *progress = (completed, total);
        }
    }

    /// Gets current caller authority and confirms the claim before starting a
    /// bounded unit of work. Call again before a new batch or publication.
    pub async fn authorize(&self) -> Result<SpaceContext, PortError> {
        self.authority.check()?;
        let budget = command_budget(&self.cancellation)?;
        let ctx = self
            .control
            .refresh_archive_job(budget, &self.delegation)
            .await?;
        self.store
            .check_archive_job_lease(
                &ctx.budget,
                ctx.scope(),
                &self.claim.job.id,
                &self.claim.lease_owner,
                self.claim.job.lease,
            )
            .await?;
        Ok(ctx)
    }

    /// Run one bounded synchronous ZIP, Zstd or file operation. Even if the
    /// async caller is dropped, the closure owns its permit until it exits.
    pub async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Cancellation) -> Result<T, PortError> + Send + 'static,
    ) -> Result<T, PortError> {
        let permit = tokio::select! {
            biased;
            () = self.cancellation.cancelled() => return Err(cancelled()),
            result = self.blocking.clone().acquire_owned() => {
                result.map_err(|_| failure("archive_blocking_pool_closed"))?
            }
        };
        let cancellation = self.cancellation.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            work(&cancellation)
        })
        .await
        .map_err(|_| failure("archive_blocking_worker_failed"))?
    }
}

pub trait ArchiveOperation: Send + Sync {
    fn execute<'a>(&'a self, job: &'a JobExecution) -> PortFuture<'a, JobCompletionOutcome>;

    fn maintain<'a>(&'a self, shutdown: &'a Cancellation) -> PortFuture<'a, ()> {
        Box::pin(async move {
            shutdown.cancelled().await;
            Ok(())
        })
    }
}

/// Runs archive work on a separate Tokio runtime with independent class quotas.
/// The durable canonical lease serializes workers across processes.
pub struct ArchiveRunner {
    store: CanonicalStore,
    control: Arc<ControlService>,
    operation: Arc<dyn ArchiveOperation>,
    blocking: Arc<Semaphore>,
    config: JobWorkerConfig,
    owner: String,
}

impl ArchiveRunner {
    pub fn new(
        store: CanonicalStore,
        control: Arc<ControlService>,
        operation: Arc<dyn ArchiveOperation>,
        config: JobWorkerConfig,
    ) -> Result<Self, PortError> {
        config.validate()?;
        Ok(Self {
            store,
            control,
            operation,
            blocking: Arc::new(Semaphore::new(config.blocking_threads)),
            config,
            owner: codec::new_prefixed_hex_id("archive_worker_")?,
        })
    }

    /// Returns after shutdown and after all admitted work has stopped.
    pub async fn run(self, shutdown: Cancellation) -> Result<(), PortError> {
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let _stop_on_drop = StopOnDrop(shutdown.clone());
        thread::Builder::new()
            .name("notarium-archive".to_owned())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .max_blocking_threads(self.config.blocking_threads)
                    .thread_name("notarium-archive")
                    .build()
                    .map_err(|_| failure("archive_runtime_build"))
                    .and_then(|runtime| runtime.block_on(Arc::new(self).run_workers(shutdown)));
                let _ = result_tx.send(result);
            })
            .map_err(|_| failure("archive_runtime_start"))?;
        result_rx
            .await
            .map_err(|_| failure("archive_runtime_exit"))?
    }

    async fn run_workers(self: Arc<Self>, shutdown: Cancellation) -> Result<(), PortError> {
        let mut workers = JoinSet::new();
        for (class, limit) in [
            (ArchiveJobClass::Import, self.config.imports),
            (ArchiveJobClass::Export, self.config.exports),
        ] {
            for _ in 0..limit {
                let runner = self.clone();
                let shutdown = shutdown.clone();
                workers.spawn(async move {
                    runner.worker(class, &shutdown).await;
                    Ok(())
                });
            }
        }
        let runner = self.clone();
        let maintenance_shutdown = shutdown.clone();
        workers.spawn(async move { runner.operation.maintain(&maintenance_shutdown).await });
        let mut result = Ok(());
        while let Some(exit) = workers.join_next().await {
            match exit {
                Ok(Ok(())) => {}
                Ok(Err(err)) => result = Err(err),
                Err(_) => result = Err(failure("archive_worker_exit")),
            }
            if result.is_err() {
                shutdown.cancel();
            }
        }
        result
    }

    async fn worker(&self, class: ArchiveJobClass, shutdown: &Cancellation) {
        let mut cursor: Option<SpaceId> = None;
        while !shutdown.is_cancelled() {
            match self.next_job(class, &mut cursor, shutdown).await {
                Ok(Some((scope, claim))) => self.run_leased(scope, claim, shutdown).await,
                Ok(None) | Err(_) => {
                    cursor = None;
                    tokio::select! {
                        () = shutdown.cancelled() => break,
                        () = tokio::time::sleep(self.config.idle_poll) => {}
                    }
                }
            }
        }
    }

    async fn next_job(
        &self,
        class: ArchiveJobClass,
        cursor: &mut Option<SpaceId>,
        shutdown: &Cancellation,
    ) -> Result<Option<(HistoryScope, ClaimedContentJob)>, PortError> {
        let limit = PageLimit::new(SCOPE_PAGE_SIZE)?;
        while !shutdown.is_cancelled() {
            let scopes = self
                .store
                .archive_job_scopes(&command_budget(shutdown)?, cursor.as_ref(), limit)
                .await?;
            let reached_end = scopes.len() < usize::from(limit.get());
            for scope in scopes {
                *cursor = Some(scope.space_id.clone());
                let claim = self
                    .store
                    .claim_next_archive_job(
                        &command_budget(shutdown)?,
                        &scope,
                        &self.owner,
                        self.config.lease,
                        class,
                    )
                    .await;
                match claim {
                    Ok(Some(claim)) => return Ok(Some((scope, claim))),
                    // Space membership and writer leadership can change while
                    // walking this page. Continue scanning the remaining Spaces.
                    Ok(None) | Err(PortError::Domain(_)) | Err(PortError::Unavailable(_)) => {}
                    Err(err) => return Err(err),
                }
            }
            if reached_end {
                return Ok(None);
            }
        }
        Ok(None)
    }

    async fn run_leased(
        &self,
        scope: HistoryScope,
        claim: ClaimedContentJob,
        shutdown: &Cancellation,
    ) {
        let cancellation = Cancellation::default();
        let _stop_on_drop = StopOnDrop(cancellation.clone());
        let child = cancellation.clone();
        let shutdown = shutdown.clone();
        let relay = tokio::spawn(async move {
            tokio::select! {
                () = shutdown.cancelled() => child.cancel(),
                () = child.cancelled() => {}
            }
        });
        let result = self.admit_and_execute(&scope, &claim, &cancellation).await;
        if let Err(err) = result
            && terminal_failure(&err)
        {
            self.complete(
                &scope,
                &claim,
                &cancellation,
                failed_outcome((claim.job.completed_units, claim.job.total_units), &err),
            )
            .await;
        }
        cancellation.cancel();
        let _ = relay.await;
    }

    async fn admit_and_execute(
        &self,
        scope: &HistoryScope,
        claim: &ClaimedContentJob,
        cancellation: &Cancellation,
    ) -> Result<(), PortError> {
        let delegation = self
            .store
            .archive_job_delegation(&command_budget(cancellation)?, scope, &claim.job.id)
            .await?
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidAuthority))?;
        let (_, revocation) = self
            .control
            .register_archive_job(command_budget(cancellation)?, &delegation)
            .await?;
        let execution = JobExecution {
            store: self.store.clone(),
            control: self.control.clone(),
            claim: claim.clone(),
            delegation,
            cancellation: cancellation.clone(),
            authority: ArchiveCommitAuthority::new(revocation),
            blocking: self.blocking.clone(),
            progress: Mutex::new((claim.job.completed_units, claim.job.total_units)),
        };
        let mut work = self.operation.execute(&execution);
        let mut heartbeat = tokio::time::interval_at(
            Instant::now() + self.config.heartbeat,
            self.config.heartbeat,
        );
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let outcome = loop {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    let _ = work.await;
                    return Err(cancelled());
                }
                result = &mut work => {
                    execution.authorize().await?;
                    match result {
                        Ok(outcome) => break outcome,
                        Err(err) if terminal_failure(&err) => {
                            let progress = *execution.progress.lock().unwrap_or_else(|e| e.into_inner());
                            break failed_outcome(progress, &err);
                        }
                        Err(err) => return Err(err),
                    }
                }
                _ = heartbeat.tick() => {
                    if let Err(err) = self.heartbeat(&execution).await {
                        cancellation.cancel();
                        let _ = work.await;
                        return Err(err);
                    }
                }
            }
        };
        self.store
            .complete_archive_job(
                &command_budget(cancellation)?,
                scope,
                claim,
                outcome,
                execution.commit_authority(),
            )
            .await?;
        Ok(())
    }

    async fn complete(
        &self,
        scope: &HistoryScope,
        claim: &ClaimedContentJob,
        cancellation: &Cancellation,
        outcome: JobCompletionOutcome,
    ) {
        if let Ok(budget) = command_budget(cancellation) {
            let _ = self
                .store
                .complete_job(
                    &budget,
                    scope,
                    &claim.job.id,
                    &claim.lease_owner,
                    claim.job.lease,
                    outcome,
                )
                .await;
        }
    }

    async fn heartbeat(&self, job: &JobExecution) -> Result<(), PortError> {
        let ctx = job.authorize().await?;
        let (completed, total) = *job.progress.lock().unwrap_or_else(|e| e.into_inner());
        self.store
            .heartbeat_archive_job(
                &ctx.budget,
                ctx.scope(),
                &job.claim,
                self.config.lease,
                (completed, total),
                job.commit_authority(),
            )
            .await
            .map(drop)
    }
}

struct StopOnDrop(Cancellation);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(crate) fn command_budget(cancellation: &Cancellation) -> Result<CallBudget, PortError> {
    if cancellation.is_cancelled() {
        return Err(cancelled());
    }
    Ok(CallBudget {
        request: RequestId::from_bytes(codec::ordered_id_16()?),
        cancellation: cancellation.clone(),
        remaining: COMMAND_BUDGET,
    })
}

fn failed_outcome(
    (completed_units, total_units): (u64, Option<u64>),
    err: &PortError,
) -> JobCompletionOutcome {
    let code = match err {
        PortError::Domain(DomainError::ValidationFailed { diagnostic }) => {
            format!("{:?}", diagnostic.reason)
        }
        _ => err.code().to_owned(),
    };
    JobCompletionOutcome::Failed {
        completed_units,
        total_units,
        error_ref: ContentDigest::from_bytes(*blake3::hash(code.as_bytes()).as_bytes()),
    }
}

fn terminal_failure(error: &PortError) -> bool {
    matches!(error, PortError::Domain(domain)
        if !matches!(domain, DomainError::RateLimited { .. } | DomainError::MigrationInProgress))
}

fn cancelled() -> PortError {
    PortError::Cancelled(operational_failure("archive_cancelled"))
}

fn failure(code: &str) -> PortError {
    PortError::Internal(operational_failure(code))
}

fn operational_failure(code: &str) -> OperationalFailure {
    OperationalFailure::new(
        ContentDigest::from_bytes(*blake3::hash(code.as_bytes()).as_bytes()),
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("non-retryable operational failure")
}

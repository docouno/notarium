use super::*;
use notarium_core::error::RetryAdvice;
use tokio::sync::{oneshot, watch};

type Key = (HistoryScope, LeaseEpoch, String);
pub(crate) type Attempt = watch::Receiver<Option<Result<(), PortError>>>;
pub(crate) type HandoffSender = oneshot::Sender<Vec<Attempt>>;

#[derive(Default)]
pub(crate) struct RetirementWorkers {
    running: std::sync::Mutex<HashMap<Key, Attempt>>,
    pub(super) retries: super::gc_retry::Dispatcher,
}

pub(super) struct Work {
    store: crate::CanonicalStore,
    key: Key,
    outcome: watch::Sender<Option<Result<(), PortError>>>,
}

impl Drop for Work {
    fn drop(&mut self) {
        self.store
            .inner
            .retirement_workers
            .running
            .lock()
            .expect("retirement workers")
            .remove(&self.key);
    }
}

fn stopped() -> PortError {
    unavailable_retryable(
        "gc_worker_stopped",
        "storage closed during GC",
        Duration::from_millis(50),
    )
}

/// Earliest automatic retry allowed by the operation that failed.
pub(crate) fn retry_after(error: &PortError) -> Option<Duration> {
    let failure = match error {
        PortError::Domain(_) => return None,
        PortError::Cancelled(failure)
        | PortError::DeadlineExceeded(failure)
        | PortError::Unavailable(failure)
        | PortError::Internal(failure) => failure,
    };
    match failure.retry() {
        RetryAdvice::Never => None,
        RetryAdvice::RetrySameCommand => Some(Duration::ZERO),
        RetryAdvice::After(delay) => Some(delay),
    }
}

pub(crate) async fn outcome(attempt: &mut Attempt) -> Result<(), PortError> {
    attempt
        .wait_for(Option::is_some)
        .await
        .map_err(|_| stopped())?
        .as_ref()
        .expect("published retirement outcome")
        .clone()
}

pub(crate) async fn handoff_outcome(
    handoff: oneshot::Receiver<Vec<Attempt>>,
) -> Result<(), PortError> {
    for mut attempt in handoff.await.map_err(|_| stopped())? {
        outcome(&mut attempt).await?;
    }
    Ok(())
}

impl crate::CanonicalStore {
    /// Concurrent callers join the durable ID's existing attempt, including its backoff.
    pub(crate) fn schedule_retirements(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        ids: Vec<String>,
    ) -> Vec<Attempt> {
        self.schedule_retirements_with_slot(scope, epoch, ids, None)
    }

    pub(super) fn schedule_retirements_with_slot(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        ids: Vec<String>,
        sweep_slot: Option<tokio::sync::OwnedSemaphorePermit>,
    ) -> Vec<Attempt> {
        let mut pending = Vec::new();
        let mut attempts = Vec::with_capacity(ids.len());
        for id in ids {
            let (attempt, work) = self.reserve_retirement(scope, epoch, id);
            attempts.push(attempt);
            pending.extend(work);
        }
        if !pending.is_empty() {
            let shutdown = self.inner.backup_shutdown.clone();
            let handle = self.inner.backup_executor.spawn(async move {
                let run = async {
                    if let Some(slot) = sweep_slot {
                        for work in pending {
                            let store = work.store.clone();
                            if work.sweep_attempt().await {
                                store.wake_gc_retries();
                            }
                        }
                        drop(slot);
                    } else {
                        run(pending).await;
                    }
                };
                tokio::select! { biased; () = shutdown.cancelled() => {}, () = run => {} }
            });
            crate::backup::register_cleanup_task(&self.inner, handle);
        }
        attempts
    }

    pub(super) fn reserve_retirement(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        id: String,
    ) -> (Attempt, Option<Work>) {
        let mut running = self
            .inner
            .retirement_workers
            .running
            .lock()
            .expect("retirement workers");
        let key = (scope.clone(), epoch, id);
        if let Some(attempt) = running.get(&key) {
            return (attempt.clone(), None);
        }
        let (outcome, attempt) = watch::channel(None);
        running.insert(key.clone(), attempt.clone());
        (
            attempt,
            Some(Work {
                store: self.clone(),
                key,
                outcome,
            }),
        )
    }

    #[cfg(feature = "test-support")]
    pub fn storage_cleanup_idle_for_test(&self) -> bool {
        self.inner
            .backup_cleanups
            .lock()
            .expect("storage cleanup tasks")
            .iter()
            .all(tokio::task::JoinHandle::is_finished)
    }

    #[cfg(feature = "test-support")]
    pub fn active_retirement_workers_for_test(&self) -> usize {
        self.inner
            .retirement_workers
            .running
            .lock()
            .expect("retirement workers")
            .len()
    }
}

impl Work {
    async fn attempt(&self) -> Result<(), PortError> {
        let (scope, epoch, id) = &self.key;
        match self
            .store
            .drive_retirement_to_completion(scope, *epoch, id)
            .await
        {
            Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(()),
            result => result,
        }
    }

    pub(super) async fn retry_if_due(self) -> Result<Option<Duration>, PortError> {
        // The first attempt may have postponed or finished this ID after the scan.
        let (scope, _, id) = &self.key;
        let wait = self.store.gc_retry_wait(&scope.space_id, id).await?;
        if wait == Some(Duration::ZERO) {
            return Ok(self
                .sweep_attempt()
                .await
                .then_some(Duration::from_millis(250)));
        }
        let result = wait.map_or(Ok(()), |delay| {
            Err(unavailable_retryable(
                "gc_retry_delayed",
                "retirement is waiting for its next attempt",
                delay,
            ))
        });
        let outcome = self.outcome.clone();
        drop(self);
        outcome.send_replace(Some(result));
        Ok(wait)
    }

    pub(super) async fn sweep_attempt(self) -> bool {
        let result = self.attempt().await;
        let (scope, epoch, id) = &self.key;
        let mut retry = false;
        if let Err(error) = &result {
            let delay = retry_after(error);
            retry = delay.is_some();
            if !retry {
                tracing::warn!(?error, space = %scope.space_id.as_str(), retirement = id, "durable retirement stopped");
            }
            if let Err(update) = self.store.defer_gc_retry(scope, *epoch, id, delay).await {
                tracing::warn!(?update, "could not update the GC retry schedule");
                retry = true;
            }
        }
        let outcome = self.outcome.clone();
        drop(self);
        outcome.send_replace(Some(result));
        retry
    }
}

async fn run(mut pending: Vec<Work>) {
    let mut backoff = Duration::from_millis(25);
    while !pending.is_empty() {
        let mut retry = Vec::new();
        let mut delay = backoff;
        for work in pending {
            let (scope, _, id) = &work.key;
            let result = work.attempt().await;
            if let Some(minimum) = result.as_ref().err().and_then(retry_after) {
                delay = delay.max(minimum);
                work.outcome.send_replace(Some(result));
                retry.push(work);
            } else {
                if let Err(error) = &result {
                    tracing::warn!(?error, space = %scope.space_id.as_str(), retirement = id, "durable retirement stopped");
                }
                // Release the durable ID before a subscriber can explicitly retry.
                let outcome = work.outcome.clone();
                drop(work);
                outcome.send_replace(Some(result));
            }
        }
        pending = retry;
        if !pending.is_empty() {
            tokio::time::sleep(delay).await;
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
    }
}

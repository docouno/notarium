use super::*;
use notarium_core::error::RetryAdvice;
use tokio::sync::{oneshot, watch};

type Key = (HistoryScope, LeaseEpoch, String);
pub(crate) type Attempt = watch::Receiver<Option<Result<(), PortError>>>;
pub(crate) type HandoffSender = oneshot::Sender<Vec<Attempt>>;

#[derive(Default)]
pub(crate) struct RetirementWorkers(std::sync::Mutex<HashMap<Key, Attempt>>);

struct Work {
    store: crate::CanonicalStore,
    key: Key,
    outcome: watch::Sender<Option<Result<(), PortError>>>,
}

impl Drop for Work {
    fn drop(&mut self) {
        self.store
            .inner
            .retirement_workers
            .0
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
        {
            let mut running = self
                .inner
                .retirement_workers
                .0
                .lock()
                .expect("retirement workers");
            for id in ids {
                let key = (scope.clone(), epoch, id);
                if let Some(attempt) = running.get(&key) {
                    attempts.push(attempt.clone());
                    continue;
                }
                let (outcome, attempt) = watch::channel(None);
                running.insert(key.clone(), attempt.clone());
                attempts.push(attempt);
                pending.push(Work {
                    store: self.clone(),
                    key,
                    outcome,
                });
            }
        }
        if !pending.is_empty() {
            let shutdown = self.inner.backup_shutdown.clone();
            let handle = self.inner.backup_executor.spawn(async move {
                let _slot = sweep_slot;
                tokio::select! { biased; () = shutdown.cancelled() => {}, () = run(pending) => {} }
            });
            crate::backup::register_cleanup_task(&self.inner, handle);
        }
        attempts
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
            .0
            .lock()
            .expect("retirement workers")
            .len()
    }
}

async fn run(mut pending: Vec<Work>) {
    let mut backoff = Duration::from_millis(25);
    while !pending.is_empty() {
        let mut retry = Vec::new();
        let mut delay = backoff;
        for work in pending {
            let (scope, epoch, id) = &work.key;
            let result = match work
                .store
                .drive_retirement_to_completion(scope, *epoch, id)
                .await
            {
                Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(()),
                result => result,
            };
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

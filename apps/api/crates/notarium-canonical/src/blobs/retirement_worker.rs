use super::*;
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
                tokio::select! { biased; () = shutdown.cancelled() => {}, () = run(pending) => {} }
            });
            crate::backup::register_cleanup_task(&self.inner, handle);
        }
        attempts
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
            let retryable = result
                .as_ref()
                .is_err_and(|e| !matches!(e, PortError::Domain(_)));
            work.outcome.send_replace(Some(result));
            if retryable {
                retry.push(work);
            }
        }
        pending = retry;
        if !pending.is_empty() {
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(1));
        }
    }
}

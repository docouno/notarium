//! Transaction lifetimes remain bounded even when the consumer stops polling.
use super::{Transaction, WriteTransaction};
use crate::error::{database, invalid};
use notarium_core::{
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::ContentDigest,
    ports::{CallBudget, Cancellation},
};
use std::{
    future::Future,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit};

#[derive(Clone)]
pub(crate) struct OperationBudget {
    pub started: Instant,
    remaining: Duration,
    cancellation: Cancellation,
}
impl OperationBudget {
    pub fn context(&self, request: notarium_core::ids::RequestId) -> CallBudget {
        CallBudget {
            request,
            cancellation: self.cancellation.clone(),
            remaining: self.remaining.saturating_sub(self.started.elapsed()),
        }
    }
    pub fn new(budget: CallBudget) -> Self {
        Self {
            started: Instant::now(),
            remaining: budget.remaining,
            cancellation: budget.cancellation,
        }
    }
    pub fn check(&self, effect: CommitEffect) -> Result<(), PortError> {
        let failure = || {
            OperationalFailure::new(
                ContentDigest::from_bytes(*blake3::hash(b"control operation budget").as_bytes()),
                effect,
                RetryAdvice::Never,
                false,
            )
            .expect("non-retryable failure is valid")
        };
        if self.cancellation.is_cancelled() {
            return Err(PortError::Cancelled(failure()));
        }
        if self.started.elapsed() >= self.remaining {
            return Err(PortError::DeadlineExceeded(failure()));
        }
        Ok(())
    }
    pub async fn run<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
        effect: CommitEffect,
    ) -> Result<T, PortError> {
        self.check(effect)?;
        tokio::select! {
            biased;
            error = async {
                loop {
                    if let Err(error) = self.check(effect) { break error; }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            } => Err(error),
            result = operation => result,
        }
    }
    pub async fn configure(&self, tx: &mut Transaction) -> Result<(), PortError> {
        // PostgreSQL's server-side fallback is finite too. The local watchdog
        // owns prompt cancellation; a dead process must not leave an idle cut.
        if let Transaction::Postgres(tx) = tx {
            let millis = self
                .remaining
                .saturating_sub(self.started.elapsed())
                // Give the watchdog time to acknowledge ROLLBACK before the
                // server kills the connection as a process-failure fallback.
                .saturating_add(Duration::from_secs(1))
                .as_millis()
                .clamp(1, i32::MAX as u128);
            sqlx::query("SELECT set_config('idle_in_transaction_session_timeout',$1,true)")
                .bind(format!("{millis}ms"))
                .execute(&mut **tx)
                .await
                .map_err(database)?;
        }
        Ok(())
    }
}

pub(super) enum LeasedTransaction {
    Read(Transaction),
    Write(WriteTransaction),
}
impl LeasedTransaction {
    pub fn inner(&mut self) -> &mut Transaction {
        match self {
            Self::Read(tx) => tx,
            Self::Write(tx) => tx.inner_mut(),
        }
    }
    async fn rollback(self) -> Result<(), PortError> {
        match self {
            Self::Read(Transaction::Sqlite(tx)) => tx.rollback().await.map_err(database),
            Self::Read(Transaction::Postgres(tx)) => tx.rollback().await.map_err(database),
            Self::Write(tx) => tx.rollback().await,
        }
    }
}
type RetentionCheck = Arc<dyn Fn() -> Result<(), PortError> + Send + Sync>;
struct Shared {
    stopped: AtomicBool,
    notify: Notify,
    failure: StdMutex<Option<PortError>>,
    retention: RetentionCheck,
}
pub(super) struct TransactionLease {
    pub state: Arc<Mutex<Option<LeasedTransaction>>>,
    pub budget: OperationBudget,
    shared: Arc<Shared>,
    worker: Option<tokio::task::JoinHandle<Result<(), PortError>>>,
}
/// An active page operation owns the right to keep the cut usable. Dropping its
/// future (without signalling Cancellation) must also abort the entire cut.
pub(super) struct OperationGuard {
    shared: Arc<Shared>,
    completed: bool,
}
impl OperationGuard {
    pub fn complete(mut self) {
        self.completed = true;
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.shared.stopped.store(true, Ordering::SeqCst);
            self.shared.notify.notify_one();
        }
    }
}
impl TransactionLease {
    pub fn operation(&self) -> OperationGuard {
        OperationGuard {
            shared: self.shared.clone(),
            completed: false,
        }
    }
    pub fn new(
        value: LeasedTransaction,
        budget: OperationBudget,
        retention: RetentionCheck,
        slot: Option<OwnedSemaphorePermit>,
    ) -> Self {
        let state = Arc::new(Mutex::new(Some(value)));
        let shared = Arc::new(Shared {
            stopped: AtomicBool::new(false),
            notify: Notify::new(),
            failure: StdMutex::new(None),
            retention,
        });
        let worker_state = state.clone();
        let worker_shared = shared.clone();
        let worker_budget = budget.clone();
        let worker = tokio::spawn(async move {
            let _slot = slot;
            loop {
                if worker_shared.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let result = worker_budget
                    .check(CommitEffect::NotCommitted)
                    .and_then(|()| (worker_shared.retention)());
                if let Err(error) = result {
                    *worker_shared.failure.lock().expect("lease failure lock") = Some(error);
                    break;
                }
                tokio::select! {
                    _=worker_shared.notify.notified()=>{},
                    _=tokio::time::sleep(Duration::from_millis(1))=>{},
                }
            }
            let value = worker_state.lock().await.take();
            if let Some(value) = value {
                value.rollback().await?;
            }
            Ok(())
        });
        Self {
            state,
            budget,
            shared,
            worker: Some(worker),
        }
    }
    pub fn check(&self) -> Result<(), PortError> {
        self.budget.check(CommitEffect::NotCommitted)?;
        if let Some(error) = self
            .shared
            .failure
            .lock()
            .expect("lease failure lock")
            .as_ref()
        {
            return Err(error.clone());
        }
        if self.shared.stopped.load(Ordering::SeqCst) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        (self.shared.retention)()
    }
    pub async fn close(&mut self) -> Result<(), PortError> {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.notify.notify_one();
        if let Some(worker) = self.worker.take() {
            worker.await.map_err(|_| {
                crate::error::unavailable("control lease worker", CommitEffect::Unknown)
            })??;
        }
        Ok(())
    }
}
impl Drop for TransactionLease {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.notify.notify_one();
    }
}

//! One worker consumes bounded FIFO queues in priority order, checking the
//! interactive lane between every batch. Each job runs in a spawned task so
//! panics cannot take down the scheduler.

use super::{EmbeddingBatch, EmbeddingError};
use crate::config::MAX_QUERY_EMBEDDING_BUDGET;
use notarium_core::ports::{CallBudget, Cancellation};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{Instant, sleep_until},
};

const QUANTUM: usize = 16;
const CAPACITY: [usize; 3] = [64, 64, 8];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Priority {
    InteractiveSearchQuery,
    LiveNoteEdit,
    BulkImportBackfill,
}

impl Priority {
    fn lane(self) -> usize {
        match self {
            Self::InteractiveSearchQuery => 0,
            Self::LiveNoteEdit => 1,
            Self::BulkImportBackfill => 2,
        }
    }
}

type Output = Result<EmbeddingBatch, EmbeddingError>;
type Execute = Box<dyn FnOnce(CallBudget) -> Pin<Box<dyn Future<Output = Output> + Send>> + Send>;

struct Job {
    id: u64,
    deadline: Instant,
    budget: CallBudget,
    result: oneshot::Sender<Output>,
    execute: Execute,
}

#[derive(Default)]
struct State {
    jobs: [VecDeque<Job>; 3],
    active: Option<Cancellation>,
    closed: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    wake: Notify,
    next_id: AtomicU64,
}

impl Shared {
    fn close_and_drain(&self) {
        let (active, queued) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            (state.active.take(), std::mem::take(&mut state.jobs))
        };
        if let Some(active) = active {
            active.cancel();
        }
        for job in queued.into_iter().flatten() {
            job.budget.cancellation.cancel();
            let _ = job.result.send(Err(EmbeddingError::Cancelled));
        }
        self.wake.notify_one();
    }
}

#[derive(Clone)]
pub struct EmbeddingScheduler {
    shared: Arc<Shared>,
}

impl EmbeddingScheduler {
    pub fn start() -> (Self, JoinHandle<()>) {
        let shared = Arc::new(Shared::default());
        let worker = tokio::spawn(run(shared.clone()));
        (Self { shared }, worker)
    }

    pub(crate) fn queue_depths(&self) -> [usize; 3] {
        let state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.jobs.each_ref().map(VecDeque::len)
    }

    pub async fn submit<F, R>(
        &self,
        priority: Priority,
        budget: CallBudget,
        execute: F,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError>
    where
        F: FnOnce(CallBudget) -> R + Send + 'static,
        R: Future<Output = Result<Vec<Option<Vec<f32>>>, EmbeddingError>> + Send + 'static,
    {
        self.submit_batch(priority, budget, move |budget| async move {
            execute(budget).await.map(EmbeddingBatch::complete)
        })
        .await
        .map(|batch| batch.rows)
    }

    pub(crate) async fn submit_batch<F, R>(
        &self,
        priority: Priority,
        mut budget: CallBudget,
        execute: F,
    ) -> Output
    where
        F: FnOnce(CallBudget) -> R + Send + 'static,
        R: Future<Output = Output> + Send + 'static,
    {
        if budget.cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        if priority == Priority::InteractiveSearchQuery {
            budget.remaining = budget.remaining.min(MAX_QUERY_EMBEDDING_BUDGET);
        }
        if budget.remaining.is_zero() {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let deadline = Instant::now()
            .checked_add(budget.remaining)
            .ok_or(EmbeddingError::BudgetExceeded)?;
        let parent = std::mem::take(&mut budget.cancellation);
        let child = budget.cancellation.clone();
        let lane = priority.lane();
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (result, receive) = oneshot::channel();
        {
            let mut state = self
                .shared
                .state
                .lock()
                .map_err(|_| EmbeddingError::Cancelled)?;
            if state.closed {
                return Err(EmbeddingError::Cancelled);
            }
            if state.jobs[lane].len() >= CAPACITY[lane] {
                return Err(EmbeddingError::BudgetExceeded);
            }
            state.jobs[lane].push_back(Job {
                id,
                deadline,
                budget,
                result,
                execute: Box::new(move |budget| Box::pin(execute(budget))),
            });
        }
        self.shared.wake.notify_one();
        let _pending = Submission {
            shared: &self.shared,
            id,
            lane,
            child,
        };
        tokio::select! {
            biased;
            () = parent.cancelled() => Err(EmbeddingError::Cancelled),
            () = sleep_until(deadline) => Err(EmbeddingError::BudgetExceeded),
            result = receive => result.unwrap_or(Err(EmbeddingError::Cancelled)),
        }
    }

    /// Signal the worker and queued jobs. Await the worker before dropping the
    /// runtime so native and provider calls have acknowledged cancellation.
    pub fn shutdown(&self) {
        self.shared.close_and_drain();
    }
}

struct Submission<'a> {
    shared: &'a Shared,
    id: u64,
    lane: usize,
    child: Cancellation,
}

impl Drop for Submission<'_> {
    fn drop(&mut self) {
        self.child.cancel();
        let removed = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let lane = &mut state.jobs[self.lane];
            lane.iter()
                .position(|job| job.id == self.id)
                .and_then(|index| lane.remove(index))
        };
        drop(removed);
    }
}

struct WorkerGuard {
    shared: Arc<Shared>,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.shared.close_and_drain();
    }
}

struct ActiveGuard<'a> {
    shared: &'a Shared,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active = None;
    }
}

async fn run(shared: Arc<Shared>) {
    let _worker_guard = WorkerGuard {
        shared: shared.clone(),
    };
    loop {
        let work = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return;
            }
            let job = state.jobs.iter_mut().find_map(VecDeque::pop_front);
            state.active = job.as_ref().map(|job| job.budget.cancellation.clone());
            job
        };
        let Some(mut job) = work else {
            shared.wake.notified().await;
            continue;
        };
        let active_guard = ActiveGuard { shared: &shared };
        job.budget.remaining = job.deadline.saturating_duration_since(Instant::now());
        let result = if job.budget.cancellation.is_cancelled() {
            Err(EmbeddingError::Cancelled)
        } else if job.budget.remaining.is_zero() {
            Err(EmbeddingError::BudgetExceeded)
        } else {
            let execute = job.execute;
            let budget = job.budget;
            match tokio::spawn(async move { execute(budget).await }).await {
                Ok(output) => output,
                Err(error) => {
                    if error.is_panic() {
                        tracing::error!("embedding scheduler job panicked");
                    }
                    Err(EmbeddingError::ModelUnavailable)
                }
            }
        };
        drop(active_guard);
        let _ = job.result.send(result);
    }
}

/// Split input in order by both the provider's aggregate cap and the CPU quantum.
pub fn bounded_batches<T>(
    input: impl IntoIterator<Item = T>,
    tokens: impl Fn(&T) -> u32,
    limit: u32,
) -> Result<Vec<Vec<T>>, EmbeddingError> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut total = 0u32;
    for item in input {
        let count = tokens(&item);
        if count == 0 || count > limit {
            return Err(EmbeddingError::BudgetExceeded);
        }
        if batch.len() == QUANTUM || total > limit - count {
            batches.push(std::mem::take(&mut batch));
            total = 0;
        }
        batch.push(item);
        total += count;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

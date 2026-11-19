//! One worker consumes bounded FIFO queues in priority order, checking the
//! interactive lane between every batch.

use super::EmbeddingError;
use notarium_core::ports::{CallBudget, Cancellation};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{Instant, sleep_until},
};

const INTERACTIVE_LIMIT: Duration = Duration::from_millis(150);
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

type Output = Result<Vec<Option<Vec<f32>>>, EmbeddingError>;
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

    pub async fn submit<F, R>(
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
            budget.remaining = budget.remaining.min(INTERACTIVE_LIMIT);
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
        let (active, queued) = {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            (state.active.clone(), std::mem::take(&mut state.jobs))
        };
        if let Some(active) = active {
            active.cancel();
        }
        for job in queued.into_iter().flatten() {
            job.budget.cancellation.cancel();
            let _ = job.result.send(Err(EmbeddingError::Cancelled));
        }
        self.shared.wake.notify_one();
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

async fn run(shared: Arc<Shared>) {
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
        job.budget.remaining = job.deadline.saturating_duration_since(Instant::now());
        let result = if job.budget.cancellation.is_cancelled() {
            Err(EmbeddingError::Cancelled)
        } else if job.budget.remaining.is_zero() {
            Err(EmbeddingError::BudgetExceeded)
        } else {
            (job.execute)(job.budget).await
        };
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

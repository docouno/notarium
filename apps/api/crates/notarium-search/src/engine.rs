use crate::{
    config::SearchConfig,
    embed::EmbeddingScheduler,
    layout::FolderDictionary,
    lexical::{LexicalIndex, ReaderCache, WriterPool},
    ports::{SearchCarrierReadPort, SearchModelResolverPort},
    vector::VectorSnapshot,
};
use arc_swap::ArcSwapOption;
use notarium_canonical::CanonicalStore;
use notarium_core::{
    DomainError,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::{ContentDigest, RequestId, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::{
        CallBudget, Cancellation, ChangeBroadcast, EmbeddingProviderPort, ServiceAuthority,
        ServicePurpose, StructuralReadPort,
    },
};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant as StdInstant},
};
use tokio::{
    sync::{Notify, oneshot, watch},
    task::JoinHandle,
    time::{Instant, sleep_until},
};

pub(super) const MAX_OPEN_SPACES: usize = 256;

/// Supply the canonical, structural and provider owners at composition time.
/// The default constructor uses the canonical owner for its change and carrier ports.
pub struct SearchDependencies {
    pub canonical: Arc<CanonicalStore>,
    pub changes: Arc<dyn ChangeBroadcast>,
    pub carriers: Arc<dyn SearchCarrierReadPort>,
    pub structural: Arc<dyn StructuralReadPort>,
    pub model_resolver: Option<Arc<dyn SearchModelResolverPort>>,
    pub providers: Option<Arc<dyn EmbeddingProviderPort>>,
}

impl SearchDependencies {
    pub fn new(canonical: Arc<CanonicalStore>, structural: Arc<dyn StructuralReadPort>) -> Self {
        Self {
            changes: canonical.clone(),
            carriers: canonical.clone(),
            canonical,
            structural,
            model_resolver: None,
            providers: None,
        }
    }
}

/// Rebuildable hybrid search with an independent canonical subscriber per Space.
/// Start on a Tokio runtime and drain with `shutdown` before closing storage.
pub struct SearchEngine {
    pub(super) services: Arc<Services>,
    workers: Arc<Mutex<WorkerTable>>,
    max_open_spaces: usize,
}

pub(super) struct Services {
    pub config: SearchConfig,
    pub deps: SearchDependencies,
    pub authority: ServiceAuthority,
    pub shutdown: Cancellation,
    pub local_scheduler: EmbeddingScheduler,
    pub remote_scheduler: EmbeddingScheduler,
    pub writers: WriterPool,
    pub readers: Arc<ReaderCache>,
    pub models: crate::model::LocalModels,
    pub schedule: crate::indexer::Schedule,
}

pub(super) struct Published {
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
    pub lexical: Arc<LexicalIndex>,
    pub searcher: tantivy::Searcher,
    pub folders: Arc<FolderDictionary>,
    pub vectors: Option<Arc<VectorSnapshot>>,
    pub active_model: Option<crate::ports::ResolvedEmbeddingTarget>,
    pub embedder: Option<Arc<crate::model::Embedder>>,
    pub embeddings_pending: bool,
    pub reopening_vectors: bool,
    pub embedder_unavailable: bool,
}

#[derive(Default)]
struct PublishState {
    retired: Vec<Weak<Published>>,
}

impl PublishState {
    fn record_retired(&mut self, previous: &Arc<Published>) {
        self.retired.retain(|state| state.strong_count() != 0);
        self.retired.push(Arc::downgrade(previous));
    }
}

/// Per-Space publication state. Lock order is strictly acyclic:
/// `WorkerTable` -> `SpaceHandle::publish_state` -> `align_waiters` / `last_activity`.
/// `ReaderCache::indexes` is never held while entering `SpaceHandle`, and
/// `publish_state` is never held while dropping `Arc<Published>`.
pub(super) struct SpaceHandle {
    pub published: ArcSwapOption<Published>,
    pub epoch: watch::Sender<u64>,
    pub wake: Notify,
    pub stop: Cancellation,
    pub active_queries: AtomicUsize,
    worker_pins: AtomicUsize,
    align_waiters: Mutex<BTreeMap<SpaceSeq, Vec<oneshot::Sender<Arc<Published>>>>>,
    publish_state: Mutex<PublishState>,
    last_activity: Mutex<StdInstant>,
}

pub(super) struct WorkerPin {
    handle: Arc<SpaceHandle>,
}

impl Drop for WorkerPin {
    fn drop(&mut self) {
        self.handle.worker_pins.fetch_sub(1, Ordering::Release);
    }
}

pub(super) struct PinnedSpace {
    pub handle: Arc<SpaceHandle>,
}

impl Drop for PinnedSpace {
    fn drop(&mut self) {
        self.handle.touch();
        self.handle.active_queries.fetch_sub(1, Ordering::Release);
    }
}

impl SpaceHandle {
    pub(super) fn new() -> Self {
        Self {
            published: ArcSwapOption::empty(),
            epoch: watch::channel(0).0,
            wake: Notify::new(),
            stop: Cancellation::default(),
            active_queries: AtomicUsize::new(0),
            worker_pins: AtomicUsize::new(0),
            align_waiters: Mutex::new(BTreeMap::new()),
            publish_state: Mutex::new(PublishState::default()),
            last_activity: Mutex::new(StdInstant::now()),
        }
    }

    pub(super) fn increment_active_queries(&self) {
        let _publish_state = self
            .publish_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.active_queries.fetch_add(1, Ordering::AcqRel);
    }

    pub(super) fn pin_worker(self: &Arc<Self>) -> WorkerPin {
        {
            let _publish_state = self
                .publish_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.worker_pins.fetch_add(1, Ordering::AcqRel);
        }
        WorkerPin {
            handle: Arc::clone(self),
        }
    }

    pub(super) fn is_published(&self) -> bool {
        let _publish_state = self
            .publish_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.published.load().is_some()
    }

    pub(super) fn is_reopening_vectors(&self) -> bool {
        let _publish_state = self
            .publish_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.published
            .load()
            .as_ref()
            .is_some_and(|published| published.reopening_vectors)
    }

    #[cfg(test)]
    pub(super) fn pin_query(self: &Arc<Self>) -> PinnedSpace {
        self.touch();
        self.increment_active_queries();
        PinnedSpace {
            handle: Arc::clone(self),
        }
    }

    pub(super) fn touch(&self) {
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = StdInstant::now();
    }

    pub(super) fn idle_elapsed(&self) -> Duration {
        self.last_activity
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .elapsed()
    }

    pub(super) fn register_align_waiter(&self, seq: SpaceSeq) -> oneshot::Receiver<Arc<Published>> {
        let (tx, rx) = oneshot::channel();
        let mut waiters = self
            .align_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        waiters.retain(|_, list| {
            list.retain(|sender| !sender.is_closed());
            !list.is_empty()
        });
        waiters.entry(seq).or_default().push(tx);
        rx
    }

    pub(super) fn next_align_target(&self, after: SpaceSeq, through: SpaceSeq) -> Option<SpaceSeq> {
        let mut waiters = self
            .align_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        waiters.retain(|&seq, list| {
            list.retain(|sender| !sender.is_closed());
            seq > after && !list.is_empty()
        });
        waiters
            .keys()
            .next()
            .copied()
            .filter(|&seq| seq > after && seq <= through)
    }

    pub(super) fn has_align_waiters(&self) -> bool {
        let mut waiters = self
            .align_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        waiters.retain(|_, list| {
            list.retain(|sender| !sender.is_closed());
            !list.is_empty()
        });
        !waiters.is_empty()
    }

    fn clear_align_waiters(&self) {
        self.align_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn notify_align_waiters(&self, state: &Arc<Published>) {
        let delivered = {
            let mut waiters = self
                .align_waiters
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut remaining = waiters.split_off(&state.seq);
            let exact = remaining.remove(&state.seq).unwrap_or_default();
            // Dropping all waiters for seq < state.seq wakes them so they can
            // re-align against the newer published cut instead of timing out.
            *waiters = remaining;
            exact
        };
        for tx in delivered {
            let _ = tx.send(Arc::clone(state));
        }
    }

    pub(super) async fn drain_published(&self) {
        loop {
            let empty = {
                let mut publish_state = self
                    .publish_state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                publish_state
                    .retired
                    .retain(|state| state.strong_count() != 0);
                publish_state.retired.is_empty()
            };
            if empty {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    pub fn replace(&self, state: Option<Arc<Published>>) -> Option<Arc<Published>> {
        let notify = state.clone();
        let previous = {
            let mut publish_state = self
                .publish_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.is_none() {
                self.clear_align_waiters();
            }
            let previous = self.published.swap(state);
            if let Some(prev) = &previous {
                publish_state.record_retired(prev);
            }
            previous
        };
        self.epoch
            .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        if let Some(published) = notify {
            self.notify_align_waiters(&published);
        }
        previous
    }

    /// Atomically replace the published snapshot only while a snapshot is still
    /// live, reusing its lexical reader so background updates can never
    /// resurrect a reader evicted by `ReaderCache`.
    pub(super) fn replace_if_live(
        &self,
        build: impl FnOnce(&Arc<LexicalIndex>) -> Published,
    ) -> bool {
        let (notify, previous, current) = {
            let mut publish_state = self
                .publish_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(current) = self.published.load_full() else {
                return false;
            };
            let next = Arc::new(build(&current.lexical));
            let previous = self.published.swap(Some(Arc::clone(&next)));
            if let Some(prev) = &previous {
                publish_state.record_retired(prev);
            }
            (next, previous, current)
        };
        drop(previous);
        drop(current);
        self.epoch
            .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        self.notify_align_waiters(&notify);
        true
    }

    /// Atomically retire the published snapshot for idle timeout only when no
    /// query, worker pin, or align waiter is active.
    pub(super) fn retire_if_idle(&self) -> bool {
        let evicted = {
            let mut publish_state = self
                .publish_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.active_queries.load(Ordering::Acquire) != 0
                || self.worker_pins.load(Ordering::Acquire) != 0
                || self.has_align_waiters()
            {
                return false;
            }
            let previous = self.published.swap(None);
            if let Some(prev) = &previous {
                publish_state.record_retired(prev);
            }
            previous
        };
        if evicted.is_some() {
            drop(evicted);
            self.epoch
                .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        }
        true
    }
}

impl crate::lexical::IdleReaderOwner for SpaceHandle {
    fn idle_last_activity(&self, path: &std::path::Path) -> Option<StdInstant> {
        let _publish_state = self
            .publish_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.active_queries.load(Ordering::Acquire) != 0
            || self.worker_pins.load(Ordering::Acquire) != 0
            || self.has_align_waiters()
        {
            return None;
        }
        let current = self.published.load_full()?;
        // `load_full` adds one deterministic strong reference to `Published`
        // (1 in `self.published` + 1 in `current` == 2) without cloning
        // `current.lexical` (1 in `ReaderCache` + 1 in `Published` <= 2).
        let eligible = current.lexical.path() == path
            && Arc::strong_count(&current) == 2
            && Arc::strong_count(&current.lexical) <= 2;
        // `self.published` still holds a strong ref, so dropping `current`
        // cannot run destructors under `publish_state`.
        drop(current);
        eligible.then(|| {
            *self
                .last_activity
                .lock()
                .unwrap_or_else(|error| error.into_inner())
        })
    }

    fn evict_if_idle(&self, path: &std::path::Path) {
        let evicted = {
            let mut publish_state = self
                .publish_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.active_queries.load(Ordering::Acquire) != 0
                || self.worker_pins.load(Ordering::Acquire) != 0
                || self.has_align_waiters()
            {
                return;
            }
            let can_evict = {
                let Some(current) = self.published.load_full() else {
                    return;
                };
                current.lexical.path() == path
                    && Arc::strong_count(&current) == 2
                    && Arc::strong_count(&current.lexical) <= 2
            };
            if !can_evict {
                return;
            }
            let previous = self.published.swap(None);
            if let Some(prev) = &previous {
                publish_state.record_retired(prev);
            }
            previous
        };
        if evicted.is_some() {
            drop(evicted);
            self.epoch
                .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        }
    }
}

pub(super) struct DrainGate {
    tx: watch::Sender<bool>,
}

impl DrainGate {
    pub(super) fn new() -> Self {
        Self {
            tx: watch::channel(false).0,
        }
    }

    pub(super) fn signal(&self) {
        self.tx.send_replace(true);
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }
}

pub(super) struct Worker {
    pub(super) handle: Arc<SpaceHandle>,
    gate: Arc<DrainGate>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub(super) struct WorkerTable {
    active: HashMap<SpaceId, Worker>,
    draining: HashMap<SpaceId, Arc<DrainGate>>,
    bg_tasks: Vec<JoinHandle<()>>,
}

pub(super) fn try_evict_idle_worker(
    workers: &Weak<Mutex<WorkerTable>>,
    space_id: &SpaceId,
    handle: &Arc<SpaceHandle>,
    min_idle: Duration,
) -> bool {
    let Some(workers) = workers.upgrade() else {
        return true;
    };
    let mut table = workers.lock().unwrap_or_else(|error| error.into_inner());
    let can_evict = table
        .active
        .get(space_id)
        .is_some_and(|worker| Arc::ptr_eq(&worker.handle, handle))
        && handle.active_queries.load(Ordering::Acquire) == 0
        && !handle.has_align_waiters()
        && handle.idle_elapsed() >= min_idle;
    if can_evict && let Some(evicted) = table.active.remove(space_id) {
        table.draining.insert(space_id.clone(), evicted.gate);
        table.bg_tasks.retain(|task| !task.is_finished());
        table.bg_tasks.push(evicted.task);
        true
    } else {
        false
    }
}

pub(super) fn finish_exited_worker(
    workers: &Weak<Mutex<WorkerTable>>,
    space_id: &SpaceId,
    handle: &Arc<SpaceHandle>,
    gate: &Arc<DrainGate>,
) {
    if let Some(workers) = workers.upgrade() {
        let mut table = workers.lock().unwrap_or_else(|error| error.into_inner());
        if table
            .active
            .get(space_id)
            .is_some_and(|worker| Arc::ptr_eq(&worker.handle, handle))
        {
            table.active.remove(space_id);
        }
        if table
            .draining
            .get(space_id)
            .is_some_and(|existing| Arc::ptr_eq(existing, gate))
        {
            table.draining.remove(space_id);
        }
        table.bg_tasks.retain(|task| !task.is_finished());
    }
    gate.signal();
}

impl SearchEngine {
    /// Observe the combined scheduler queues in priority order for the release gate.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn queued_embeddings(&self) -> [usize; 3] {
        let local = self.services.local_scheduler.queue_depths();
        let remote = self.services.remote_scheduler.queue_depths();
        [
            local[0] + remote[0],
            local[1] + remote[1],
            local[2] + remote[2],
        ]
    }

    pub fn start(config: SearchConfig, deps: SearchDependencies) -> Self {
        Self::start_inner(config, deps, crate::indexer::Schedule::default())
    }

    #[cfg(test)]
    pub(super) fn start_with_schedule(
        config: SearchConfig,
        deps: SearchDependencies,
        schedule: crate::indexer::Schedule,
    ) -> Self {
        Self::start_inner(config, deps, schedule)
    }

    fn start_inner(
        config: SearchConfig,
        deps: SearchDependencies,
        schedule: crate::indexer::Schedule,
    ) -> Self {
        let (local_scheduler, local_worker) = EmbeddingScheduler::start();
        let (remote_scheduler, remote_worker) = EmbeddingScheduler::start();
        let services = Arc::new(Services {
            config,
            deps,
            authority: ServiceAuthority::admit(ServicePurpose::Search),
            shutdown: Cancellation::default(),
            local_scheduler,
            remote_scheduler,
            writers: WriterPool::default(),
            readers: Arc::new(ReaderCache::default()),
            models: crate::model::LocalModels::default(),
            schedule,
        });
        let pool = services.writers.clone();
        let cancellation = services.shutdown.clone();
        let writer_reaper = tokio::spawn(async move {
            if pool.evict_idle_until(cancellation).await.is_err() {
                tracing::error!("search writer eviction stopped");
            }
        });
        Self {
            services,
            workers: Arc::new(Mutex::new(WorkerTable {
                active: HashMap::new(),
                draining: HashMap::new(),
                bg_tasks: vec![local_worker, remote_worker, writer_reaper],
            })),
            max_open_spaces: MAX_OPEN_SPACES,
        }
    }

    #[cfg(test)]
    pub(super) fn with_max_open_spaces(mut self, max_open_spaces: usize) -> Self {
        self.max_open_spaces = max_open_spaces.max(1);
        self
    }

    #[cfg(test)]
    pub(super) fn worker_count(&self) -> usize {
        self.workers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .len()
    }

    #[cfg(test)]
    pub(super) fn hold_drain_gate(&self, space_id: SpaceId) -> Arc<DrainGate> {
        let gate = Arc::new(DrainGate::new());
        self.workers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .draining
            .insert(space_id, gate.clone());
        gate
    }

    #[cfg(test)]
    pub(super) fn release_held_drain_gate(&self, space_id: &SpaceId, gate: &Arc<DrainGate>) {
        {
            let mut table = self
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if table
                .draining
                .get(space_id)
                .is_some_and(|existing| Arc::ptr_eq(existing, gate))
            {
                table.draining.remove(space_id);
            }
        }
        gate.signal();
    }

    #[cfg(test)]
    pub(super) fn draining_and_bg_count(&self) -> (usize, usize) {
        let table = self
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (table.draining.len(), table.bg_tasks.len())
    }

    pub fn start_space(&self, scope: HistoryScope) -> Result<(), PortError> {
        self.space(scope).map(|_| ())
    }

    pub(super) fn pin_space(&self, scope: HistoryScope) -> Result<PinnedSpace, PortError> {
        let handle = self.acquire_space(scope, true)?;
        Ok(PinnedSpace { handle })
    }

    pub(super) fn space(&self, scope: HistoryScope) -> Result<Arc<SpaceHandle>, PortError> {
        self.acquire_space(scope, false)
    }

    fn acquire_space(
        &self,
        scope: HistoryScope,
        pin_query: bool,
    ) -> Result<Arc<SpaceHandle>, PortError> {
        let mut table = self.workers.lock().map_err(|_| internal("space_workers"))?;
        if self.services.shutdown.is_cancelled() {
            return Err(PortError::Cancelled(failure("engine_stopped")));
        }
        if let Some(worker) = table.active.get(&scope.space_id) {
            worker.handle.touch();
            if pin_query {
                worker.handle.increment_active_queries();
            }
            return Ok(worker.handle.clone());
        }
        if table.active.len() >= self.max_open_spaces {
            let candidate = table
                .active
                .iter()
                .filter(|(_, worker)| {
                    worker.handle.active_queries.load(Ordering::Acquire) == 0
                        && !worker.handle.has_align_waiters()
                })
                .max_by_key(|(_, worker)| worker.handle.idle_elapsed())
                .map(|(id, _)| id.clone());
            if let Some(oldest_id) = candidate
                && let Some(evicted) = table.active.remove(&oldest_id)
            {
                evicted.handle.stop.cancel();
                table.draining.insert(oldest_id, evicted.gate);
                table.bg_tasks.retain(|existing| !existing.is_finished());
                table.bg_tasks.push(evicted.task);
            }
        }
        let id = scope.space_id.clone();
        let prev_drain = table.draining.get(&id).map(|gate| gate.subscribe());
        let handle = Arc::new(SpaceHandle::new());
        if pin_query {
            handle.active_queries.fetch_add(1, Ordering::AcqRel);
        }
        let gate = Arc::new(DrainGate::new());
        let task = tokio::spawn(crate::indexer::run(
            self.services.clone(),
            handle.clone(),
            Arc::downgrade(&self.workers),
            gate.clone(),
            prev_drain,
            scope,
        ));
        table.active.insert(
            id,
            Worker {
                handle: handle.clone(),
                gate,
                task,
            },
        );
        Ok(handle)
    }

    pub async fn shutdown(&self) {
        self.stop();
        loop {
            let (workers, bg) = {
                let mut table = self
                    .workers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                (
                    std::mem::take(&mut table.active),
                    std::mem::take(&mut table.bg_tasks),
                )
            };
            if workers.is_empty() && bg.is_empty() {
                break;
            }
            for worker in workers.into_values() {
                let _ = worker.task.await;
                worker.handle.replace(None);
            }
            for task in bg {
                let _ = task.await;
            }
        }
        let writers = self.services.writers.clone();
        let readers = Arc::clone(&self.services.readers);
        let _ = tokio::task::spawn_blocking(move || {
            writers.release_all();
            readers.release_all();
        })
        .await;
    }

    fn stop(&self) {
        self.services.shutdown.cancel();
        self.services.local_scheduler.shutdown();
        self.services.remote_scheduler.shutdown();
        for worker in self
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .values()
        {
            worker.handle.stop.cancel();
        }
    }
}

impl Drop for SearchEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(super) struct Clock {
    budget: CallBudget,
    pub deadline: Instant,
}

impl Clock {
    pub fn new(budget: &CallBudget) -> Result<Self, PortError> {
        let deadline = Instant::now()
            .checked_add(budget.remaining)
            .ok_or_else(deadline_error)?;
        let clock = Self {
            budget: budget.clone(),
            deadline,
        };
        clock.remaining()?;
        Ok(clock)
    }

    pub fn remaining(&self) -> Result<CallBudget, PortError> {
        if self.budget.cancellation.is_cancelled() {
            return Err(PortError::Cancelled(failure("request_cancelled")));
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(deadline_error());
        }
        Ok(CallBudget {
            remaining,
            ..self.budget.clone()
        })
    }

    pub async fn within<T>(
        &self,
        work: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        tokio::select! {
            biased;
            () = self.budget.cancellation.cancelled() => Err(PortError::Cancelled(failure("request_cancelled"))),
            () = sleep_until(self.deadline) => Err(deadline_error()),
            result = work => result,
        }
    }
}

pub(super) fn failure(code: &str) -> OperationalFailure {
    let reference = ContentDigest::from_bytes(*blake3::hash(code.as_bytes()).as_bytes());
    OperationalFailure::new(
        reference,
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("read-only operation has no commit effect")
}

pub(super) fn deadline_error() -> PortError {
    PortError::DeadlineExceeded(failure("search_deadline"))
}

pub(super) fn internal(code: &str) -> PortError {
    PortError::Internal(failure(code))
}

pub(super) fn unavailable(code: &str) -> PortError {
    PortError::Unavailable(failure(code))
}

pub(super) fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

pub(super) const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn maintenance_budget(cancellation: &Cancellation, request: RequestId) -> CallBudget {
    CallBudget {
        request,
        cancellation: cancellation.clone(),
        remaining: MAINTENANCE_TIMEOUT,
    }
}

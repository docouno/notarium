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
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
    time::{Instant, sleep_until},
};

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
    workers: Mutex<HashMap<SpaceId, Worker>>,
    embedding_worker: Option<JoinHandle<()>>,
    writer_reaper: Option<JoinHandle<()>>,
}

pub(super) struct Services {
    pub config: SearchConfig,
    pub deps: SearchDependencies,
    pub authority: ServiceAuthority,
    pub shutdown: Cancellation,
    pub scheduler: EmbeddingScheduler,
    pub writers: WriterPool,
    pub readers: ReaderCache,
    pub models: crate::model::LocalModels,
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
}

pub(super) struct SpaceHandle {
    pub published: ArcSwapOption<Published>,
    pub epoch: watch::Sender<u64>,
    pub wake: Notify,
    pub stop: Cancellation,
    pub active_queries: AtomicUsize,
}

pub(super) struct QueryPin<'a>(&'a AtomicUsize);

impl Drop for QueryPin<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

impl SpaceHandle {
    fn new() -> Self {
        Self {
            published: ArcSwapOption::empty(),
            epoch: watch::channel(0).0,
            wake: Notify::new(),
            stop: Cancellation::default(),
            active_queries: AtomicUsize::new(0),
        }
    }

    pub fn pin_query(&self) -> QueryPin<'_> {
        self.active_queries.fetch_add(1, Ordering::AcqRel);
        QueryPin(&self.active_queries)
    }

    pub fn replace(&self, state: Option<Arc<Published>>) -> Option<Arc<Published>> {
        let previous = self.published.swap(state);
        self.epoch
            .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        previous
    }
}

struct Worker {
    handle: Arc<SpaceHandle>,
    task: JoinHandle<()>,
}

impl SearchEngine {
    /// Observe the scheduler queues in priority order for the release gate.
    #[doc(hidden)]
    pub fn queued_embeddings(&self) -> [usize; 3] {
        self.services.scheduler.queue_depths()
    }

    pub fn start(config: SearchConfig, deps: SearchDependencies) -> Self {
        let (scheduler, embedding_worker) = EmbeddingScheduler::start();
        let services = Arc::new(Services {
            config,
            deps,
            authority: ServiceAuthority::admit(ServicePurpose::Search),
            shutdown: Cancellation::default(),
            scheduler,
            writers: WriterPool::default(),
            readers: ReaderCache::default(),
            models: crate::model::LocalModels::default(),
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
            workers: Mutex::new(HashMap::new()),
            embedding_worker: Some(embedding_worker),
            writer_reaper: Some(writer_reaper),
        }
    }

    pub fn start_space(&self, scope: HistoryScope) -> Result<(), PortError> {
        self.space(scope).map(|_| ())
    }

    pub(super) fn space(&self, scope: HistoryScope) -> Result<Arc<SpaceHandle>, PortError> {
        let mut workers = self.workers.lock().map_err(|_| internal("space_workers"))?;
        if self.services.shutdown.is_cancelled() {
            return Err(PortError::Cancelled(failure("engine_stopped")));
        }
        if let Some(worker) = workers.get(&scope.space_id) {
            return Ok(worker.handle.clone());
        }
        let id = scope.space_id.clone();
        let handle = Arc::new(SpaceHandle::new());
        let task = tokio::spawn(crate::indexer::run(
            self.services.clone(),
            handle.clone(),
            scope,
        ));
        workers.insert(
            id,
            Worker {
                handle: handle.clone(),
                task,
            },
        );
        Ok(handle)
    }

    pub async fn shutdown(mut self) {
        self.stop();
        let workers = std::mem::take(
            self.workers
                .get_mut()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for worker in workers.into_values() {
            let _ = worker.task.await;
        }
        if let Some(worker) = self.writer_reaper.take() {
            let _ = worker.await;
        }
        if let Some(worker) = self.embedding_worker.take() {
            let _ = worker.await;
        }
    }

    fn stop(&self) {
        self.services.shutdown.cancel();
        self.services.scheduler.shutdown();
        for worker in self
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
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

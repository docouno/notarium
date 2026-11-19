use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use arc_swap::{ArcSwap, ArcSwapOption};
use notarium_canonical::{
    CanonicalStore, LiveSpaceHandle,
    codec::{cancelled_not_committed, deadline_not_committed, internal_not_committed},
};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::*,
    model::{HistoryScope, SnapshotCut},
    ports::{CallBudget, Cancellation, MaintenanceContext, ServicePurpose, SpaceContext},
    query::FieldSchema,
};
use tokio::{
    sync::{Notify, broadcast, watch},
    task::JoinHandle,
};

use crate::{
    derived::{
        DerivedStore, GenerationControl, GenerationDescriptor, GenerationFiles, PostgresCacheOwner,
        ProjectionWatermark,
    },
    index::{IndexView, L0Delta},
    mmap::{BaseIndexHandle, MmapPool},
};

mod apply;
mod backlinks;
#[cfg(any(test, feature = "test-support"))]
mod benchmark;
mod board_events;
#[cfg(test)]
mod checkpoint_tests;
mod erasure;
mod events;
mod folder_move;
mod graph_read;
mod graph_settle;
mod link_apply;
mod maintenance;
mod read;
pub(crate) mod records;
mod replay;
mod rotation;
mod worker;

pub use backlinks::{BacklinkOwnerEndpoint, BacklinkOwnerResolver};
#[cfg(feature = "test-support")]
pub use benchmark::{BenchmarkCheckpoint, BenchmarkMappedCheckpoint, ProjectionPause};
pub use events::SpaceEventBus;
pub use read::ProjectedNoteReadPort;

#[derive(Clone, Debug)]
pub struct ProjectionConfig {
    pub max_open_spaces: NonZeroUsize,
    pub max_retained_reads: NonZeroUsize,
    pub retained_read_lifetime: Duration,
}

impl ProjectionConfig {
    pub fn desktop() -> Self {
        Self {
            max_open_spaces: NonZeroUsize::new(64).unwrap(),
            ..Self::default()
        }
    }
}

impl Default for ProjectionConfig {
    fn default() -> Self {
        Self {
            max_open_spaces: NonZeroUsize::new(256).unwrap(),
            max_retained_reads: NonZeroUsize::new(128).unwrap(),
            retained_read_lifetime: Duration::from_secs(60),
        }
    }
}

/// Owns the workers for a single installation. Readers use the engine facade.
pub struct ProjectorRuntime {
    engine: Arc<ProjectionEngine>,
    shutdown: Cancellation,
    worker: Option<JoinHandle<Result<(), PortError>>>,
    descriptor: GenerationDescriptor,
    control: GenerationControl,
    maintenance: Option<(Cancellation, JoinHandle<()>)>,
    local_owner: Option<Arc<std::fs::File>>,
    local_rotation: Option<rotation::LocalRotation>,
    _board_provider: crate::board::BoardProviderRegistration,
}

impl ProjectorRuntime {
    /// Opens the reactor against an already opened derived generation. Reads stay
    /// closed while the initial canonical scope has no admitted published cut.
    pub async fn start(
        canonical: CanonicalStore,
        projection_context: MaintenanceContext,
        derived: DerivedStore,
        cache_root: DataRoot,
        config: ProjectionConfig,
    ) -> Result<Self, PortError> {
        let initial = derived.generation();
        Self::start_with(
            canonical,
            projection_context,
            cache_root,
            maintenance::Source::Open(derived),
            initial,
            config,
        )
        .await
    }

    /// Opens the durable SQLite generation, or rebuilds an obsolete supported
    /// metadata format from canonical state before admitting readers.
    pub async fn start_sqlite(
        canonical: CanonicalStore,
        projection_context: MaintenanceContext,
        cache_root: DataRoot,
        initial: ProjectionGeneration,
        config: ProjectionConfig,
    ) -> Result<Self, PortError> {
        Self::start_with(
            canonical,
            projection_context,
            cache_root,
            maintenance::Source::Sqlite,
            initial,
            config,
        )
        .await
    }

    /// Opens the durable PostgreSQL generation. Obsolete-format recovery needs
    /// the canonical owner vector and no participants using the old format.
    pub async fn start_postgres(
        canonical: CanonicalStore,
        projection_context: MaintenanceContext,
        pool: sqlx::PgPool,
        schema_prefix: &str,
        cache_root: DataRoot,
        initial: ProjectionGeneration,
        config: ProjectionConfig,
    ) -> Result<Self, PortError> {
        let source = maintenance::Source::Postgres {
            pool,
            schema_prefix: schema_prefix.to_owned(),
        };
        Self::start_with(
            canonical,
            projection_context,
            cache_root,
            source,
            initial,
            config,
        )
        .await
    }

    async fn start_with(
        canonical: CanonicalStore,
        projection_context: MaintenanceContext,
        cache_root: DataRoot,
        source: maintenance::Source,
        initial: ProjectionGeneration,
        config: ProjectionConfig,
    ) -> Result<Self, PortError> {
        let started = Instant::now();
        projection_context
            .authority
            .require(ServicePurpose::Projection)?;
        let shutdown = Cancellation::default();
        let catalog = canonical.subscribe_projection_catalog(&projection_context)?;
        let spaces = canonical.list_spaces(&projection_context).await?;
        let control = source.control(&cache_root).await?;
        let local_owner = if control.is_postgres() {
            None
        } else {
            Some(GenerationFiles::owner(&cache_root).await?)
        };
        let (cache_root, postgres_cache_owner) = if control.is_postgres() {
            let owner = PostgresCacheOwner::acquire(cache_root).await?;
            (owner.root().clone(), Some(owner))
        } else {
            (cache_root, None)
        };
        let identity_root = cache_root.clone();
        let cache_identity = tokio::task::spawn_blocking(move || cache_identity(&identity_root))
            .await
            .map_err(checkpoint_error)??;
        let generation_cleanup = cache_cleanup(&cache_root);
        control.clear_interrupted_rotation().await?;
        let maintenance::Selection {
            old: descriptor,
            store: derived,
            recovery,
        } = maintenance::select(&source, &cache_root, &control, initial, &spaces).await?;
        drop(source);
        for (_, scope, _, _) in &spaces {
            let previous = match derived.watermarks(&scope.space_id).await {
                Ok(previous) => previous,
                Err(error) => {
                    if let Some(candidate) = &recovery {
                        let _ = control.cancel_candidate(candidate).await;
                    }
                    return Err(error);
                }
            };
            if previous.as_ref().is_none_or(|row| row.scope == *scope)
                && let Err(error) = derived.register_scope(scope).await
                && !(previous.is_none() && apply::is_history_mismatch(&error))
            {
                if let Some(candidate) = &recovery {
                    let _ = control.cancel_candidate(candidate).await;
                }
                return Err(error);
            }
        }
        let generation = Arc::new(Generation::new(derived));
        let engine = Arc::new(ProjectionEngine {
            canonical,
            projection_context,
            cache_root,
            cache_identity,
            postgres_cache_owner,
            control: control.clone(),
            pool: MmapPool::new(config.max_open_spaces),
            generation: ArcSwap::new(Arc::clone(&generation)),
            known_generations: RwLock::new(BTreeMap::from([(
                generation.store.generation(),
                Arc::clone(&generation),
            )])),
            generation_cleanup,
            publication: Arc::new(tokio::sync::RwLock::new(())),
            publication_closed: AtomicBool::new(recovery.is_some()),
            activation: watch::channel(0).0,
            discovery: Notify::new(),
            backlink_owners: OnceLock::new(),
            space_events: RwLock::new(BTreeMap::new()),
            reads: read::RetainedReads::new(
                config.max_retained_reads,
                config.retained_read_lifetime,
            ),
        });
        let board_provider = match crate::board::register_board_provider(&engine) {
            Ok(provider) => provider,
            Err(error) => {
                if let Some(candidate) = &recovery {
                    let _ = control.cancel_candidate(candidate).await;
                }
                return Err(error);
            }
        };
        let eraser = match erasure::Eraser::new(&engine) {
            Ok(eraser) => eraser,
            Err(error) => {
                if let Some(candidate) = &recovery {
                    let _ = control.cancel_candidate(candidate).await;
                }
                return Err(error);
            }
        };
        if let Err(error) = engine
            .canonical
            .set_projection_visibility_cleanup(&engine.projection_context, Arc::new(eraser))
        {
            if let Some(candidate) = &recovery {
                let _ = control.cancel_candidate(candidate).await;
            }
            return Err(error);
        }
        let worker_engine = Arc::clone(&engine);
        let worker_stop = shutdown.clone();
        let worker_owner = local_owner.clone();
        let worker = tokio::spawn(async move {
            let _owner = worker_owner;
            worker::supervise(worker_engine, generation, spaces, catalog, worker_stop).await
        });
        let mut runtime = Self {
            engine,
            shutdown,
            worker: Some(worker),
            descriptor,
            control,
            maintenance: None,
            local_owner,
            local_rotation: None,
            _board_provider: board_provider,
        };
        if let Some(candidate) = recovery {
            let mut budget = runtime.engine.projection_context.budget.clone();
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            let recovered = match maintenance::recover_generation(
                &runtime.engine,
                &runtime.descriptor,
                &candidate,
                &budget,
                &runtime.shutdown,
            )
            .await
            {
                Ok(recovered) => recovered,
                Err(error) => {
                    let recovery_control = runtime.control.clone();
                    let _ = runtime.shutdown().await;
                    let _ = recovery_control.cancel_candidate(&candidate).await;
                    return Err(error);
                }
            };
            runtime.descriptor = recovered;
            runtime
                .engine
                .publication_closed
                .store(false, Ordering::Release);
            runtime
                .engine
                .activation
                .send_modify(|value| *value = value.wrapping_add(1));
        }
        let stop = Cancellation::default();
        let engine = Arc::clone(&runtime.engine);
        let maintenance_stop = stop.clone();
        let maintenance_owner = runtime.local_owner.clone();
        let task = tokio::spawn(async move {
            let _owner = maintenance_owner;
            maintenance::supervise(engine, maintenance_stop).await;
        });
        runtime.maintenance = Some((stop, task));
        Ok(runtime)
    }

    pub fn engine(&self) -> Arc<ProjectionEngine> {
        Arc::clone(&self.engine)
    }

    pub async fn shutdown(mut self) -> Result<(), PortError> {
        self.engine.close_admissions();
        self.shutdown.cancel();
        if let Some((stop, _)) = &self.maintenance {
            stop.cancel();
        }
        let rotation = self.finish_local_shutdown().await;
        if let Some(worker) = self.worker.take() {
            worker
                .await
                .map_err(|e| internal_not_committed("projection_supervisor", e.to_string()))??;
        }
        if let Some((_, maintenance)) = self.maintenance.take() {
            maintenance
                .await
                .map_err(|e| internal_not_committed("projection_maintenance", e.to_string()))?;
        }
        rotation
    }
}

impl Drop for ProjectorRuntime {
    fn drop(&mut self) {
        self.engine.close_admissions();
        self.shutdown.cancel();
        if let Some(rotation) = &self.local_rotation {
            rotation.cancel();
        }
        if let Some((stop, _)) = &self.maintenance {
            stop.cancel();
        }
    }
}

/// Structural, note listing, graph and board reads over the published cut.
pub struct ProjectionEngine {
    canonical: CanonicalStore,
    projection_context: MaintenanceContext,
    cache_root: DataRoot,
    cache_identity: String,
    postgres_cache_owner: Option<Arc<PostgresCacheOwner>>,
    control: GenerationControl,
    pool: MmapPool,
    generation: ArcSwap<Generation>,
    known_generations: RwLock<BTreeMap<ProjectionGeneration, Arc<Generation>>>,
    generation_cleanup: Arc<GenerationCleanup>,
    publication: Arc<tokio::sync::RwLock<()>>,
    publication_closed: AtomicBool,
    activation: watch::Sender<u64>,
    discovery: Notify,
    backlink_owners: OnceLock<Arc<dyn BacklinkOwnerResolver>>,
    space_events: RwLock<BTreeMap<SpaceId, SpaceEventChannel>>,
    reads: read::RetainedReads,
}

struct Generation {
    store: DerivedStore,
    spaces: RwLock<BTreeMap<SpaceId, Arc<SpaceSlot>>>,
}

impl Generation {
    fn new(store: DerivedStore) -> Self {
        Self {
            store,
            spaces: RwLock::new(BTreeMap::new()),
        }
    }

    fn slot(&self, space: &SpaceId) -> Option<Arc<SpaceSlot>> {
        self.spaces
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(space)
            .cloned()
    }

    fn detach_slot(&self, space: &SpaceId) -> Option<Arc<SpaceSlot>> {
        let slot = self
            .spaces
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(space)?;
        slot.history_ended.cancel();
        Some(slot)
    }

    fn ensure_slot(&self, space: &SpaceId) -> Arc<SpaceSlot> {
        if let Some(slot) = self.slot(space) {
            return slot;
        }
        self.spaces
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .entry(space.clone())
            .or_default()
            .clone()
    }
}

#[derive(Default)]
struct SpaceSlot {
    cut: ArcSwapOption<PublishedCut>,
    history_ended: Cancellation,
    lookup_bound: AtomicBool,
    ever_published: AtomicBool,
    progress: watch::Sender<u64>,
    checkpoint: Notify,
    repair: Notify,
    #[cfg(any(test, feature = "test-support"))]
    benchmark_pause: benchmark::PauseSlot,
}

impl SpaceSlot {
    fn is_detached(&self) -> bool {
        self.history_ended.is_cancelled()
    }

    fn check_attached(&self) -> Result<(), PortError> {
        if self.is_detached() {
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        Ok(())
    }

    fn admitted_cut(&self) -> Option<Arc<PublishedCut>> {
        if self.lookup_bound.load(Ordering::Acquire) && !self.is_detached() {
            self.cut.load_full()
        } else {
            None
        }
    }

    fn replace(&self, cut: Option<Arc<PublishedCut>>) {
        if cut.is_some() {
            self.ever_published.store(true, Ordering::Release);
        }
        self.cut.store(cut);
        self.progress
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    fn request_repair(&self, base: &BaseIndexHandle) -> bool {
        let current = self.cut.load();
        if !current
            .as_ref()
            .is_some_and(|cut| cut.base.shares_lease(base))
            || !base.request_repair()
        {
            return false;
        }
        self.repair.notify_one();
        true
    }

    fn clear_if_current(&self, cut: &Arc<PublishedCut>) -> bool {
        let expected = Some(Arc::clone(cut));
        let previous = self.cut.compare_and_swap(&expected, None);
        if !previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, cut))
        {
            return false;
        }
        self.progress
            .send_modify(|revision| *revision = revision.wrapping_add(1));
        true
    }
}

pub(crate) struct PublishedCut {
    slot: Weak<SpaceSlot>,
    pub(crate) cut: SnapshotCut,
    pub(crate) watermark: ProjectionWatermark,
    pub(crate) root_folder_id: FolderId,
    pub(crate) store: DerivedStore,
    pub(crate) fields: Arc<BTreeMap<String, FieldSchema>>,
    pub(crate) live: LiveSpaceHandle,
    pub(crate) base: BaseIndexHandle,
    pub(crate) delta: Arc<L0Delta>,
}

type BoardDeltaSlot = Mutex<Option<notarium_core::ports::BoardDelta>>;
type BoardDeltaRegistry = Arc<Mutex<Vec<Weak<BoardDeltaSlot>>>>;

struct SpaceEventChannel {
    sender: broadcast::Sender<events::QueuedEvent>,
    board_deltas: BoardDeltaRegistry,
}

impl SpaceEventChannel {
    fn new() -> Self {
        Self {
            sender: broadcast::channel(256).0,
            board_deltas: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl ProjectionEngine {
    fn close_admissions(&self) {
        self.publication_closed.store(true, Ordering::Release);
        self.reads.clear();
    }

    fn subscribe_space_events(&self, space: &SpaceId) -> broadcast::Receiver<events::QueuedEvent> {
        if let Some(channel) = self
            .space_events
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(space)
        {
            return channel.sender.subscribe();
        }
        let mut channels = self
            .space_events
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        channels
            .entry(space.clone())
            .or_insert_with(SpaceEventChannel::new)
            .sender
            .subscribe()
    }

    fn has_event_subscribers(&self, space: &SpaceId) -> bool {
        self.space_events
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(space)
            .is_some_and(|channel| channel.sender.receiver_count() > 0)
    }

    fn send_space_event(&self, space: &SpaceId, event: events::QueuedEvent) {
        let channel = {
            let channels = self
                .space_events
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            channels
                .get(space)
                .filter(|channel| channel.sender.receiver_count() > 0)
                .map(|channel| (channel.sender.clone(), Arc::clone(&channel.board_deltas)))
        };
        if let Some((sender, board_deltas)) = channel {
            if let events::QueuedEvent::Board(notice) = &event
                && let Some(delta) = &notice.delta
            {
                let mut entries = board_deltas
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                entries.retain(|weak| weak.strong_count() > 0);
                entries.push(delta.downgrade());
            }
            let _ = sender.send(event);
        }
    }

    pub(super) fn scrub_space_events(&self, space: &SpaceId) {
        let board_deltas = self
            .space_events
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(space)
            .map(|channel| Arc::clone(&channel.board_deltas));
        if let Some(board_deltas) = board_deltas {
            let mut entries = board_deltas
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for weak in entries.drain(..) {
                if let Some(slot) = weak.upgrade() {
                    *slot
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                }
            }
        }
    }

    fn prune_event_channels(&self) {
        let active = self.generation.load();
        let mut channels = self
            .space_events
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        channels.retain(|space, channel| {
            channel.sender.receiver_count() > 0 || active.slot(space).is_some()
        });
    }

    pub(crate) fn canonical(&self) -> &CanonicalStore {
        &self.canonical
    }

    pub(crate) fn projection_context(&self) -> MaintenanceContext {
        self.projection_context.clone()
    }

    pub(crate) fn projection_context_for(&self, ctx: &SpaceContext) -> MaintenanceContext {
        MaintenanceContext {
            authority: self.projection_context.authority.clone(),
            budget: ctx.budget.clone(),
        }
    }

    pub(crate) fn live_handle(&self, scope: &HistoryScope) -> Result<LiveSpaceHandle, PortError> {
        if !self
            .generation
            .load()
            .slot(&scope.space_id)
            .is_some_and(|slot| slot.lookup_bound.load(Ordering::Acquire))
        {
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        self.canonical.live_visibility_fence().space(scope)
    }

    pub(crate) fn published_cut(
        &self,
        scope: &HistoryScope,
    ) -> Result<Arc<PublishedCut>, PortError> {
        let _admission = self
            .publication
            .try_read()
            .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
        if self.publication_closed.load(Ordering::Acquire) {
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        let generation = self.generation.load();
        let cut = generation
            .slot(&scope.space_id)
            .and_then(|slot| slot.admitted_cut())
            .ok_or_else(|| {
                self.discovery.notify_one();
                DomainError::validation(ValidationReason::NotReady)
            })?;
        scope.check(&cut.cut.scope)?;
        Ok(cut)
    }

    pub(crate) fn open_index(&self, cut: &PublishedCut) -> Result<IndexView, PortError> {
        let base = cut
            .base
            .open(&self.pool)
            .map_err(|error| self.handle_open_index_error(cut, error))?;
        Ok(IndexView::new(base, Arc::clone(&cut.delta)))
    }

    pub(crate) async fn open_index_async(
        &self,
        cut: &PublishedCut,
    ) -> Result<IndexView, PortError> {
        match cut.base.try_open_resident(&self.pool) {
            Ok(Some(base)) => return Ok(IndexView::new(base, Arc::clone(&cut.delta))),
            Ok(None) => {}
            Err(error) => return Err(self.handle_open_index_error(cut, error)),
        }
        let base = cut.base.clone();
        let pool = self.pool.clone();
        let opened = tokio::task::spawn_blocking(move || base.open(&pool))
            .await
            .map_err(checkpoint_error)?;
        let base = opened.map_err(|error| self.handle_open_index_error(cut, error))?;
        Ok(IndexView::new(base, Arc::clone(&cut.delta)))
    }

    fn handle_open_index_error(
        &self,
        cut: &PublishedCut,
        error: crate::index::IndexError,
    ) -> PortError {
        if cut
            .slot
            .upgrade()
            .is_some_and(|slot| !slot.is_detached() && slot.request_repair(&cut.base))
        {
            tracing::debug!(error = %error, "projection checkpoint repair requested");
            DomainError::validation(ValidationReason::NotReady).into()
        } else {
            DomainError::validation(ValidationReason::CursorStale).into()
        }
    }

    fn generation_slot(
        &self,
        generation: ProjectionGeneration,
        space: &SpaceId,
    ) -> Option<Arc<SpaceSlot>> {
        let generation = self
            .known_generations
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&generation)
            .cloned()?;
        generation.slot(space)
    }

    fn current_admission(
        &self,
        generation: ProjectionGeneration,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, PortError> {
        let admission = self
            .publication
            .try_read()
            .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
        if self.publication_closed.load(Ordering::Acquire)
            || self.generation.load().store.generation() != generation
        {
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        Ok(admission)
    }

    pub fn event_bus(self: &Arc<Self>) -> SpaceEventBus {
        SpaceEventBus::new(self)
    }

    pub fn note_reads(self: &Arc<Self>) -> ProjectedNoteReadPort {
        ProjectedNoteReadPort::new(Arc::clone(self))
    }

    pub async fn wait_for_projected(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
        budget: &CallBudget,
    ) -> Result<SnapshotCut, PortError> {
        Ok(self
            .wait_for_cut(scope, seq, budget, budget.remaining)
            .await?
            .cut
            .clone())
    }

    async fn wait_for_cut(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
        budget: &CallBudget,
        maximum: Duration,
    ) -> Result<Arc<PublishedCut>, PortError> {
        let started = Instant::now();
        let mut activation = self.activation.subscribe();
        loop {
            if budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "projection_wait",
                    "caller cancelled",
                ));
            }
            let generation = self.generation.load();
            let slot = match generation.slot(&scope.space_id) {
                Some(slot) => slot,
                None => {
                    self.discovery.notify_one();
                    generation.ensure_slot(&scope.space_id)
                }
            };
            let mut progress = slot.progress.subscribe();
            if slot.is_detached() {
                continue;
            }
            if let Ok(_admission) = self.publication.try_read()
                && !self.publication_closed.load(Ordering::Acquire)
            {
                if generation.store.generation() != self.generation.load().store.generation() {
                    continue;
                }
                if let Some(cut) = slot.admitted_cut() {
                    scope.check(&cut.cut.scope)?;
                    if cut.cut.projected_seq >= seq && !cut.base.repair_pending() {
                        return Ok(cut);
                    }
                }
            }
            let remaining = maximum
                .min(budget.remaining)
                .saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(deadline_not_committed(
                    "projection_wait",
                    "projected cut unavailable",
                ));
            }
            tokio::select! {
                _ = budget.cancellation.cancelled() => {
                    return Err(cancelled_not_committed("projection_wait", "caller cancelled"));
                }
                _ = tokio::time::sleep(remaining) => {
                    return Err(deadline_not_committed("projection_wait", "projected cut unavailable"));
                }
                result = progress.changed() => {
                    result.map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
                }
                _ = activation.changed() => {}
            }
        }
    }

    pub(crate) async fn wait_for_board_cut(
        &self,
        ctx: &SpaceContext,
        seq: Option<SpaceSeq>,
    ) -> Result<Option<Arc<PublishedCut>>, PortError> {
        let Some(target) = seq else {
            return self.published_cut(ctx.scope()).map(Some);
        };
        match self
            .wait_for_cut(ctx.scope(), target, &ctx.budget, Duration::from_millis(25))
            .await
        {
            Ok(cut) if cut.cut.projected_seq == target => Ok(Some(cut)),
            Ok(_) | Err(PortError::DeadlineExceeded(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn checkpoint_error(error: impl std::fmt::Display) -> PortError {
    internal_not_committed("projection_checkpoint", error.to_string())
}

type GenerationCleanup = tokio::sync::Mutex<()>;

fn cache_cleanup(cache_root: &DataRoot) -> Arc<GenerationCleanup> {
    // An abandoned blocking publication can outlive its runtime. A restart
    // of the same cache must still serialize cleanup with that operation.
    static CLEANUP: Mutex<BTreeMap<PathBuf, Weak<GenerationCleanup>>> = Mutex::new(BTreeMap::new());
    let mut caches = CLEANUP
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(guard) = caches.get(cache_root.root()).and_then(Weak::upgrade) {
        return guard;
    }
    caches.retain(|_, value| value.strong_count() != 0);
    let guard = Arc::new(GenerationCleanup::new(()));
    caches.insert(cache_root.root().to_owned(), Arc::downgrade(&guard));
    guard
}

// The shared PostgreSQL checkpoint registry distinguishes each cache directory.
// Publish the identity once so a restart can attest its own immutable files.
fn cache_identity(root: &DataRoot) -> Result<String, PortError> {
    use std::{fs, io::Write};
    let directory = root.root().join("v1");
    fs::create_dir_all(&directory).map_err(checkpoint_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let path = directory.join("projection_cache_id");
    let read = || -> Result<String, PortError> {
        #[cfg(unix)]
        let file = {
            use rustix::fs::{Mode, OFlags, open};
            use std::os::unix::fs::MetadataExt;
            let file = fs::File::from(
                open(
                    &path,
                    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                    Mode::empty(),
                )
                .map_err(std::io::Error::from)
                .map_err(checkpoint_error)?,
            );
            let meta = file.metadata().map_err(checkpoint_error)?;
            if !meta.is_file() || meta.uid() != rustix::process::geteuid().as_raw() {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            file
        };
        #[cfg(not(unix))]
        let file = fs::File::open(&path).map_err(checkpoint_error)?;
        let mut value = String::new();
        use std::io::Read;
        file.take(33)
            .read_to_string(&mut value)
            .map_err(checkpoint_error)?;
        if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        Ok(value)
    };
    if path.try_exists().map_err(checkpoint_error)? {
        return read();
    }
    let value = hex::encode(notarium_canonical::codec::csprng_16()?);
    let staging = directory.join(format!(".projection-cache-{value}"));
    #[cfg(unix)]
    let mut file = {
        use rustix::fs::{Mode, OFlags, open};
        fs::File::from(
            open(
                &staging,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(std::io::Error::from)
            .map_err(checkpoint_error)?,
        )
    };
    #[cfg(not(unix))]
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(checkpoint_error)?;
    let result = (|| -> Result<(), std::io::Error> {
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&staging, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        #[cfg(unix)]
        fs::File::open(&directory)?.sync_all()?;
        Ok(())
    })();
    drop(file);
    let _ = fs::remove_file(staging);
    result.map_err(checkpoint_error)?;
    read()
}

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
#[cfg(feature = "test-support")]
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
mod peer_rotation;
mod read;
pub(crate) mod records;
mod replay;
mod rotation;
mod worker;

pub use backlinks::{
    BacklinkOwnerEndpoint, BacklinkOwnerResolver, ChatBacklink, ChatBacklinkCursor,
    ChatBacklinkPage,
};
#[cfg(feature = "test-support")]
pub use benchmark::{BenchmarkCheckpoint, BenchmarkMappedCheckpoint, ProjectionPause};
pub use events::SpaceEventBus;
pub use graph_read::{NoteLink, NoteLinkCursor, NoteLinkDirection, NoteLinkPage};
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
    peer_observer: Option<(Cancellation, JoinHandle<()>)>,
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
        let local_owner = if control.is_distributed() {
            None
        } else {
            Some(GenerationFiles::owner(&cache_root).await?)
        };
        let (cache_root, postgres_cache_owner) = if control.is_distributed() {
            let owner = PostgresCacheOwner::acquire(cache_root).await?;
            (owner.root().clone(), Some(owner))
        } else {
            (cache_root, None)
        };
        let cache_identity = cache_identity(&cache_root)?;
        let generation_cleanup = cache_cleanup(&cache_root);
        control.clear_interrupted_local_rotation().await?;
        let maintenance::Selection {
            old: descriptor,
            store: derived,
            recovery,
        } = maintenance::select(&source, &cache_root, &control, initial, &spaces).await?;
        drop(source);
        let worker_lease = if control.is_distributed() {
            Some(
                control
                    .admit_generation_worker(derived.generation(), &cache_identity)
                    .await?,
            )
        } else {
            None
        };
        for (_, scope, _, _) in &spaces {
            let previous = derived.watermarks(&scope.space_id).await?;
            if previous.as_ref().is_none_or(|row| row.scope == *scope)
                && let Err(error) = derived.register_scope(scope).await
                && !(previous.is_none() && apply::is_history_mismatch(&error))
            {
                return Err(error);
            }
        }
        let generation = Arc::new(Generation::new(derived));
        let (events, _) = broadcast::channel(256);
        let engine = Arc::new(ProjectionEngine {
            canonical,
            projection_context,
            cache_root,
            cache_identity,
            postgres_cache_owner,
            control: control.clone(),
            generation_read: RwLock::new(None),
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
            peer_handoff: Notify::new(),
            backlink_owners: OnceLock::new(),
            events,
            reads: read::RetainedReads::new(
                config.max_retained_reads,
                config.retained_read_lifetime,
            ),
        });
        let board_provider = crate::board::register_board_provider(&engine)?;
        engine.canonical.set_projection_visibility_cleanup(
            &engine.projection_context,
            Arc::new(erasure::Eraser::new(&engine)?),
        )?;
        let worker_engine = Arc::clone(&engine);
        let worker_stop = shutdown.clone();
        let worker_owner = local_owner.clone();
        let worker = tokio::spawn(async move {
            let _owner = worker_owner;
            let result =
                worker::supervise(worker_engine, generation, spaces, catalog, worker_stop).await;
            if let Some(lease) = worker_lease {
                let released = lease.release_when_last().await;
                result.and(released)
            } else {
                result
            }
        });
        let mut runtime = Self {
            engine,
            shutdown,
            worker: Some(worker),
            descriptor,
            control,
            peer_observer: None,
            maintenance: None,
            local_owner,
            local_rotation: None,
            _board_provider: board_provider,
        };
        if let Some(candidate) = recovery {
            let mut budget = runtime.engine.projection_context.budget.clone();
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            let recovered = match candidate {
                maintenance::Recovery::Local(candidate) => {
                    maintenance::recover_local(
                        &runtime.engine,
                        &runtime.descriptor,
                        &candidate,
                        &budget,
                        &runtime.shutdown,
                    )
                    .await?
                }
                maintenance::Recovery::Postgres(attempt) => {
                    let (startup, receive) = peer_rotation::RecoveryBoot::new(
                        runtime.descriptor.clone(),
                        attempt,
                        budget.clone(),
                    );
                    runtime.start_peer_observer(Some(startup));
                    peer_rotation::RecoveryBoot::wait(receive, &budget).await?
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
        if runtime.control.is_distributed() && runtime.peer_observer.is_none() {
            runtime.start_peer_observer(None);
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

    fn start_peer_observer(&mut self, recovery: Option<peer_rotation::RecoveryBoot>) {
        let stop = Cancellation::default();
        let task = tokio::spawn(peer_rotation::supervise(
            Arc::clone(&self.engine),
            self.shutdown.clone(),
            stop.clone(),
            recovery,
        ));
        self.peer_observer = Some((stop, task));
    }

    pub fn engine(&self) -> Arc<ProjectionEngine> {
        Arc::clone(&self.engine)
    }

    pub async fn shutdown(mut self) -> Result<(), PortError> {
        let read_lease = self.engine.close_admissions();
        self.shutdown.cancel();
        if let Some((stop, _)) = &self.maintenance {
            stop.cancel();
        }
        let rotation = self.finish_local_shutdown().await;
        if let Some((stop, observer)) = self.peer_observer.take() {
            stop.cancel();
            observer
                .await
                .map_err(|e| internal_not_committed("projection_peer_observer", e.to_string()))?;
        }
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
        if let Some(lease) = read_lease {
            lease.release_when_last().await?;
        }
        rotation
    }
}

impl Drop for ProjectorRuntime {
    fn drop(&mut self) {
        drop(self.engine.close_admissions());
        self.shutdown.cancel();
        if let Some(rotation) = &self.local_rotation {
            rotation.cancel();
        }
        if let Some((stop, _)) = &self.peer_observer {
            stop.cancel();
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
    generation_read: RwLock<Option<(ProjectionGeneration, crate::derived::GenerationLease)>>,
    pool: MmapPool,
    generation: ArcSwap<Generation>,
    known_generations: RwLock<BTreeMap<ProjectionGeneration, Arc<Generation>>>,
    generation_cleanup: Arc<GenerationCleanup>,
    publication: Arc<tokio::sync::RwLock<()>>,
    publication_closed: AtomicBool,
    activation: watch::Sender<u64>,
    discovery: Notify,
    peer_handoff: Notify,
    backlink_owners: OnceLock<Arc<dyn BacklinkOwnerResolver>>,
    events: broadcast::Sender<events::QueuedEvent>,
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
    #[cfg(feature = "test-support")]
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

impl ProjectionEngine {
    fn close_admissions(&self) -> Option<crate::derived::GenerationLease> {
        self.publication_closed.store(true, Ordering::Release);
        let active = self
            .generation_read
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.reads.clear();
        active.map(|(_, lease)| lease)
    }

    pub(crate) async fn admit_generation_read(
        &self,
        scope: &HistoryScope,
        generation: ProjectionGeneration,
    ) -> Result<Option<crate::derived::GenerationLease>, PortError> {
        if !self.control.is_distributed() {
            return Ok(None);
        }
        let participant = {
            let owner = self.live_handle(scope)?.try_read()?;
            owner.owner_witness().process().to_owned()
        };
        self.admit_generation_read_for_participant(generation, &participant)
            .await
    }

    async fn admit_generation_read_for_participant(
        &self,
        generation: ProjectionGeneration,
        participant: &str,
    ) -> Result<Option<crate::derived::GenerationLease>, PortError> {
        if !self.control.is_distributed() {
            return Ok(None);
        }
        let existing = {
            let current = self
                .generation_read
                .read()
                .unwrap_or_else(|error| error.into_inner());
            current
                .as_ref()
                .filter(|(active, _)| *active == generation)
                .map(|(_, lease)| lease.clone())
        };
        if let Some(lease) = existing {
            self.control.check_active_generation(generation).await?;
            return Ok(Some(lease));
        }
        let lease = self
            .control
            .admit_generation_read(generation, participant)
            .await?;
        let mut process = self
            .generation_read
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if !self.publication_closed.load(Ordering::Acquire)
            && self.generation.load().store.generation() == generation
        {
            *process = Some((generation, lease.clone()));
        }
        Ok(Some(lease))
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
        let base = cut.base.open(&self.pool).map_err(|error| {
            if cut
                .slot
                .upgrade()
                .is_some_and(|slot| !slot.is_detached() && slot.request_repair(&cut.base))
            {
                tracing::debug!(error = %error, "projection checkpoint repair requested");
                DomainError::validation(ValidationReason::NotReady)
            } else {
                DomainError::validation(ValidationReason::CursorStale)
            }
        })?;
        Ok(IndexView::new(base, Arc::clone(&cut.delta)))
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
    let path = directory.join("projection_cache_id");
    let read = || -> Result<String, PortError> {
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

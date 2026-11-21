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
        PostgresRuntimeGuard, ProjectionWatermark,
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

/// A node's configured PostgreSQL projection cache. Persist `expected_id`
/// outside the cache volume and supply it on every start, including after restart.
#[derive(Clone, Debug)]
pub struct PostgresProjectionCache {
    pub root: DataRoot,
    pub expected_id: String,
}

impl PostgresProjectionCache {
    /// Creates the identity of a new node cache. Provision once before starting
    /// a projector. An existing marker or generation requires its original ID.
    pub async fn provision(root: DataRoot) -> Result<Self, PortError> {
        let owner = PostgresCacheOwner::acquire(root.clone()).await?;
        let guard = owner.claim_runtime()?;
        if owner.cache_identity.get().is_some()
            || !GenerationFiles::inventory(owner.root()).await?.is_empty()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let expected_id = tokio::task::spawn_blocking(move || {
            let _guard = guard;
            initialize_cache_identity(owner.root(), true)
        })
        .await
        .map_err(checkpoint_error)??;
        Ok(Self { root, expected_id })
    }
}

#[derive(Clone)]
pub struct ProjectionConfig {
    pub max_open_spaces: NonZeroUsize,
    pub max_retained_reads: NonZeroUsize,
    pub retained_read_lifetime: Duration,
    pub backlink_owner_resolver: Option<Arc<dyn BacklinkOwnerResolver>>,
}

impl std::fmt::Debug for ProjectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectionConfig")
            .field("max_open_spaces", &self.max_open_spaces)
            .field("max_retained_reads", &self.max_retained_reads)
            .field("retained_read_lifetime", &self.retained_read_lifetime)
            .field(
                "backlink_owner_resolver",
                &self.backlink_owner_resolver.is_some(),
            )
            .finish()
    }
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
            backlink_owner_resolver: None,
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
    postgres_runtime_guard: Option<Arc<PostgresRuntimeGuard>>,
    local_rotation: Option<rotation::LocalRotation>,
    _board_provider: crate::board::BoardProviderRegistration,
}

impl ProjectorRuntime {
    /// Opens the reactor against an already opened derived generation. Reads stay
    /// closed while the initial canonical scope has no admitted published cut.
    #[cfg(any(test, feature = "test-support"))]
    #[doc(hidden)]
    pub async fn start_for_test(
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

    /// Opens the durable PostgreSQL generation with an explicitly provisioned
    /// persistent local mmap cache volume.
    pub async fn start_postgres(
        canonical: CanonicalStore,
        projection_context: MaintenanceContext,
        pool: sqlx::PgPool,
        schema_prefix: &str,
        cache: PostgresProjectionCache,
        initial: ProjectionGeneration,
        config: ProjectionConfig,
    ) -> Result<Self, PortError> {
        let source = maintenance::Source::Postgres {
            pool,
            schema_prefix: schema_prefix.to_owned(),
            expected_cache_id: Some(cache.expected_id),
        };
        Self::start_with(
            canonical,
            projection_context,
            cache.root,
            source,
            initial,
            config,
        )
        .await
    }

    /// Opens the durable PostgreSQL generation using an ephemeral local mmap
    /// cache directory (such as a stateless pod's `emptyDir`). Clears any
    /// leftover local cache files under the exclusive directory lock on boot
    /// and binds cleanup to the shared PostgreSQL control schema identity.
    pub async fn start_postgres_ephemeral(
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
            expected_cache_id: None,
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
        let (expected_cache_id, ephemeral_pg_cache) = match &source {
            maintenance::Source::Postgres {
                expected_cache_id, ..
            } => (expected_cache_id.clone(), expected_cache_id.is_none()),
            _ => (None, false),
        };
        if let Some(expected) = &expected_cache_id {
            // Reject a missing or foreign mount before opening locks or creating directories.
            let root = cache_root.clone();
            let observed = tokio::task::spawn_blocking(move || read_cache_identity(&root))
                .await
                .map_err(checkpoint_error)??;
            if &observed != expected {
                return Err(DomainError::validation(ValidationReason::NotReady).into());
            }
        }
        let shutdown = Cancellation::default();
        let catalog = canonical.subscribe_projection_catalog(&projection_context)?;
        let spaces = canonical.list_spaces(&projection_context).await?;
        let control = source.control(&cache_root).await?;
        let local_owner = if control.is_postgres() {
            None
        } else {
            Some(GenerationFiles::owner(&cache_root).await?)
        };
        let (cache_root, postgres_cache_owner, postgres_runtime_guard) = if control.is_postgres() {
            let owner = PostgresCacheOwner::acquire(cache_root).await?;
            let guard = Arc::new(owner.claim_runtime()?);
            (owner.root().clone(), Some(owner), Some(guard))
        } else {
            let path = tokio::fs::canonicalize(cache_root.root())
                .await
                .map_err(checkpoint_error)?;
            (DataRoot::new(path), None, None)
        };
        if ephemeral_pg_cache
            && postgres_cache_owner
                .as_ref()
                .is_some_and(|o| o.cache_identity.get().is_none())
        {
            let clean_root = cache_root.clone();
            let clean_owner = postgres_cache_owner.clone();
            let clean_guard = postgres_runtime_guard.clone();
            tokio::task::spawn_blocking(move || {
                let _owner = clean_owner;
                let _guard = clean_guard;
                reset_ephemeral_cache_dir(&clean_root)
            })
            .await
            .map_err(checkpoint_error)??;
        }
        {
            let scratch_root = cache_root.clone();
            let scratch_local = local_owner.clone();
            let scratch_pg_owner = postgres_cache_owner.clone();
            let scratch_pg_guard = postgres_runtime_guard.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _local = scratch_local;
                let _pg_owner = scratch_pg_owner;
                let _pg_guard = scratch_pg_guard;
                link_apply::sweep_scratch_dir(&scratch_root)
            })
            .await;
        }
        let identity_root = cache_root.clone();
        let identity_local = local_owner.clone();
        let identity_owner = postgres_cache_owner.clone();
        let identity_pg_guard = postgres_runtime_guard.clone();
        let cache_identity = tokio::task::spawn_blocking(move || {
            let _local = identity_local;
            let _pg_guard = identity_pg_guard;
            cache_identity(
                &identity_root,
                identity_owner.as_deref(),
                expected_cache_id.as_deref(),
            )
        })
        .await
        .map_err(checkpoint_error)??;
        let generation_cleanup = cache_cleanup(&cache_root);
        let coordinator = control.acquire_coordinator().await?;
        coordinator.clear_interrupted_rotation().await?;
        let maintenance::Selection {
            old: descriptor,
            store: derived,
            recovery,
        } = maintenance::select(&source, &cache_root, &coordinator, initial, &spaces).await?;
        drop(source);
        // Cancel any reserved startup recovery candidate if setup errors or
        // the opening future is dropped before activation completes.
        let mut candidate_guard = CandidateDropGuard {
            control: coordinator.clone(),
            candidate: recovery.clone(),
            local_owner: local_owner.clone(),
            postgres_runtime_guard: postgres_runtime_guard.clone(),
        };
        let setup = async {
            // Persist canonical cleanup registration only after generation selection
            // succeeds so failed startups leave no dangling cleanup obligation.
            let cleanup_registration = canonical
                .prepare_projection_visibility_cleanup(
                    &projection_context,
                    control.cleanup_identity(&cache_identity),
                )
                .await?;
            let startup_scopes: Vec<HistoryScope> = spaces
                .iter()
                .map(|(_, scope, _, _)| scope.clone())
                .collect();
            derived.register_startup_scopes(&startup_scopes).await?;
            let generation = Arc::new(Generation::new(derived));
            let backlink_owners = OnceLock::new();
            if let Some(resolver) = config.backlink_owner_resolver {
                let _ = backlink_owners.set(resolver);
            }
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
                startup_recovery: AtomicBool::new(recovery.is_some()),
                stopped: Cancellation::default(),
                activation: watch::channel(0).0,
                discovery: Notify::new(),
                backlink_owners,
                space_events: RwLock::new(BTreeMap::new()),
                reads: read::RetainedReads::new(
                    config.max_retained_reads,
                    config.retained_read_lifetime,
                ),
            });
            let board_provider = crate::board::register_board_provider(&engine)?;
            let eraser = erasure::Eraser::new(&engine)?;
            cleanup_registration.attach(Arc::new(eraser));
            Ok::<_, PortError>((engine, generation, board_provider))
        }
        .await;
        let (engine, generation, board_provider) = match setup {
            Ok(ready) => ready,
            Err(error) => {
                candidate_guard.disarm();
                if let Some(candidate) = &recovery {
                    let _ = coordinator.cancel_candidate(candidate).await;
                }
                return Err(error);
            }
        };
        let worker_engine = Arc::clone(&engine);
        let worker_stop = shutdown.clone();
        let worker_owner = local_owner.clone();
        let worker_pg_guard = postgres_runtime_guard.clone();
        let worker = tokio::spawn(async move {
            let _owner = worker_owner;
            let _pg_guard = worker_pg_guard;
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
            postgres_runtime_guard,
            local_rotation: None,
            _board_provider: board_provider,
        };
        if let Some(candidate) = recovery {
            let mut budget = runtime.engine.projection_context.budget.clone();
            budget.remaining = budget.remaining.saturating_sub(started.elapsed());
            let recovered = match maintenance::recover_generation(
                &runtime.engine,
                &coordinator,
                &runtime.descriptor,
                &candidate,
                &budget,
                &runtime.shutdown,
            )
            .await
            {
                Ok(recovered) => recovered,
                Err(error) => {
                    // Retain ownership locks across shutdown until the reserved
                    // candidate has been cancelled so a competing startup cannot
                    // reuse the cache root and have its reservation cancelled.
                    let _local_owner_hold = runtime.local_owner.clone();
                    let _pg_guard_hold = runtime.postgres_runtime_guard.clone();
                    let _ = runtime.shutdown().await;
                    candidate_guard.disarm();
                    let _ = coordinator.cancel_candidate(&candidate).await;
                    return Err(error);
                }
            };
            candidate_guard.disarm();
            runtime.descriptor = recovered;
            runtime
                .engine
                .startup_recovery
                .store(false, Ordering::Release);
            runtime
                .engine
                .publication_closed
                .store(false, Ordering::Release);
            runtime
                .engine
                .activation
                .send_modify(|value| *value = value.wrapping_add(1));
        } else {
            candidate_guard.disarm();
        }
        let stop = Cancellation::default();
        let engine = Arc::clone(&runtime.engine);
        let maintenance_stop = stop.clone();
        let maintenance_owner = runtime.local_owner.clone();
        let maintenance_pg_guard = runtime.postgres_runtime_guard.clone();
        let task = tokio::spawn(async move {
            let _owner = maintenance_owner;
            let _pg_guard = maintenance_pg_guard;
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
        let worker_result = if let Some(worker) = self.worker.take() {
            match worker.await {
                Ok(result) => result,
                Err(e) => Err(internal_not_committed(
                    "projection_supervisor",
                    e.to_string(),
                )),
            }
        } else {
            Ok(())
        };
        let maintenance_result = if let Some((_, maintenance)) = self.maintenance.take() {
            maintenance
                .await
                .map_err(|e| internal_not_committed("projection_maintenance", e.to_string()))
        } else {
            Ok(())
        };
        worker_result?;
        maintenance_result?;
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
    startup_recovery: AtomicBool,
    stopped: Cancellation,
    activation: watch::Sender<u64>,
    discovery: Notify,
    backlink_owners: OnceLock<Arc<dyn BacklinkOwnerResolver>>,
    space_events: RwLock<BTreeMap<SpaceId, SpaceEventChannel>>,
    reads: read::RetainedReads,
}

struct Generation {
    store: DerivedStore,
    spaces: RwLock<BTreeMap<SpaceId, Arc<SpaceSlot>>>,
    slot_added: Notify,
}

impl Generation {
    fn new(store: DerivedStore) -> Self {
        Self {
            store,
            spaces: RwLock::new(BTreeMap::new()),
            slot_added: Notify::new(),
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
        let slot = self
            .spaces
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .entry(space.clone())
            .or_default()
            .clone();
        self.slot_added.notify_waiters();
        slot
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
    align_graph: Notify,
    repair: Notify,
    #[cfg(any(test, feature = "test-support"))]
    benchmark_pause: benchmark::PauseSlot,
    #[cfg(any(test, feature = "test-support"))]
    bucketed_list_for_test: Mutex<Option<String>>,
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

/// Schema declarations shared by publications until a schema edit or recovery.
pub(crate) struct PublishedFields {
    declarations: BTreeMap<String, FieldSchema>,
    retained_bytes: usize,
}

impl PublishedFields {
    fn new(declarations: BTreeMap<String, FieldSchema>) -> Self {
        // Include a conservative allowance for the map's partially occupied
        // nodes and their child pointers, as well as each owned field name.
        let retained_bytes = 512
            + declarations
                .keys()
                .map(|key| 128 + key.capacity())
                .sum::<usize>();
        Self {
            declarations,
            retained_bytes,
        }
    }
}

impl std::ops::Deref for PublishedFields {
    type Target = BTreeMap<String, FieldSchema>;

    fn deref(&self) -> &Self::Target {
        &self.declarations
    }
}

#[derive(Clone)]
pub(crate) struct PublishedCut {
    /// Serving cut whose complete graph partition this private cut has adopted.
    handoff_graph_source: Weak<PublishedCut>,
    slot: Weak<SpaceSlot>,
    pub(crate) cut: SnapshotCut,
    pub(crate) watermark: ProjectionWatermark,
    pub(crate) root_folder_id: FolderId,
    pub(crate) store: DerivedStore,
    pub(crate) fields: Arc<PublishedFields>,
    pub(crate) live: LiveSpaceHandle,
    pub(crate) base: BaseIndexHandle,
    pub(crate) delta: Arc<L0Delta>,
}

type BoardDeltaSlot = Mutex<Option<notarium_core::ports::BoardDelta>>;
type SpaceEventSlot = Mutex<Option<notarium_core::ports::SpaceEvent>>;

#[derive(Default)]
struct EventScrubState {
    board_deltas: Vec<(HistoryIncarnation, SpaceSeq, Weak<BoardDeltaSlot>)>,
    space_events: Vec<(HistoryIncarnation, SpaceSeq, Weak<SpaceEventSlot>)>,
    scrub_floors: BTreeMap<HistoryIncarnation, SpaceSeq>,
}

type EventScrubRegistry = Arc<Mutex<EventScrubState>>;

struct SpaceEventChannel {
    sender: broadcast::Sender<events::QueuedEvent>,
    scrub: EventScrubRegistry,
}

impl SpaceEventChannel {
    fn new() -> Self {
        Self {
            sender: broadcast::channel(256).0,
            scrub: Arc::new(Mutex::new(EventScrubState::default())),
        }
    }

    fn track_board_delta(
        scrub: &EventScrubRegistry,
        scope: &HistoryScope,
        seq: SpaceSeq,
        delta: &board_events::ScrubbableBoardDelta,
    ) {
        let mut state = scrub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .scrub_floors
            .get(&scope.incarnation)
            .is_some_and(|&floor| seq <= floor)
        {
            delta.clear();
        } else {
            state
                .board_deltas
                .retain(|(_, _, weak)| weak.strong_count() > 0);
            state
                .board_deltas
                .push((scope.incarnation, seq, delta.downgrade()));
        }
    }

    fn track_space_event(
        scrub: &EventScrubRegistry,
        scope: &HistoryScope,
        seq: SpaceSeq,
        event: &events::ScrubbableSpaceEvent,
    ) {
        let mut state = scrub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .scrub_floors
            .get(&scope.incarnation)
            .is_some_and(|&floor| seq <= floor)
        {
            event.clear();
        } else {
            state
                .space_events
                .retain(|(_, _, weak)| weak.strong_count() > 0);
            state
                .space_events
                .push((scope.incarnation, seq, event.downgrade()));
        }
    }

    fn scrub_through(scrub: &EventScrubRegistry, scope: &HistoryScope, through: SpaceSeq) {
        let mut state = scrub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .scrub_floors
            .entry(scope.incarnation)
            .and_modify(|floor| *floor = (*floor).max(through))
            .or_insert(through);
        state.board_deltas.retain(|(inc, seq, weak)| {
            let Some(slot) = weak.upgrade() else {
                return false;
            };
            if *inc == scope.incarnation && *seq <= through {
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                false
            } else {
                true
            }
        });
        state.space_events.retain(|(inc, seq, weak)| {
            let Some(slot) = weak.upgrade() else {
                return false;
            };
            if *inc == scope.incarnation && *seq <= through {
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                false
            } else {
                true
            }
        });
    }
}

impl ProjectionEngine {
    fn close_admissions(&self) {
        self.publication_closed.store(true, Ordering::Release);
        self.startup_recovery.store(false, Ordering::Release);
        self.stopped.cancel();
        self.reads.clear();
    }

    pub(super) fn checkpoint_path(
        &self,
        generation: ProjectionGeneration,
        space: &SpaceId,
        seq: SpaceSeq,
        file_nonce: &str,
    ) -> PathBuf {
        if file_nonce.is_empty() {
            self.cache_root.space_fast_index(generation, space, seq)
        } else {
            self.cache_root
                .space_fast_index_with_nonce(generation, space, seq, file_nonce)
        }
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

    pub(super) fn erasure_floor(&self, scope: &HistoryScope) -> SpaceSeq {
        let scrub = {
            let channels = self
                .space_events
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            channels
                .get(&scope.space_id)
                .map(|channel| Arc::clone(&channel.scrub))
        };
        let Some(scrub) = scrub else {
            return SpaceSeq::ZERO;
        };
        let state = scrub
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .scrub_floors
            .get(&scope.incarnation)
            .copied()
            .unwrap_or(SpaceSeq::ZERO)
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
                .map(|channel| (channel.sender.clone(), Arc::clone(&channel.scrub)))
        };
        if let Some((sender, scrub)) = channel {
            match &event {
                events::QueuedEvent::Board(notice) => {
                    if let board_events::BoardNoticePayload::Published(delta) = &notice.payload {
                        SpaceEventChannel::track_board_delta(
                            &scrub,
                            &notice.scope,
                            notice.seq,
                            delta,
                        );
                    }
                }
                events::QueuedEvent::Space {
                    scope,
                    seq,
                    scrubbable,
                    event: slot,
                    ..
                } if *scrubbable => {
                    SpaceEventChannel::track_space_event(&scrub, scope, *seq, slot);
                }
                _ => {}
            }
            let _ = sender.send(event);
        }
    }

    pub(super) fn scrub_space_events(&self, scope: &HistoryScope, through: SpaceSeq) {
        let scrub = {
            let channels = self
                .space_events
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            channels
                .get(&scope.space_id)
                .map(|channel| Arc::clone(&channel.scrub))
        }
        .unwrap_or_else(|| {
            let mut channels = self
                .space_events
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Arc::clone(
                &channels
                    .entry(scope.space_id.clone())
                    .or_insert_with(SpaceEventChannel::new)
                    .scrub,
            )
        });
        SpaceEventChannel::scrub_through(&scrub, scope, through);
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

    #[cfg(any(test, feature = "test-support"))]
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
        let base = cut
            .base
            .open_async(&self.pool)
            .await
            .map_err(|error| self.handle_open_index_error(cut, error))?;
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

    pub(crate) fn active_generation(&self) -> ProjectionGeneration {
        self.generation.load().store.generation()
    }

    pub(crate) fn current_admission(
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
            let generation = self.generation.load_full();
            let Some(slot) = generation.slot(&scope.space_id) else {
                // Do not materialize phantom `SpaceSlot` entries for arbitrary or
                // unauthorized Space IDs; wait for catalog discovery instead.
                let slot_added = generation.slot_added.notified();
                self.discovery.notify_one();
                if let Some(slot) = generation.slot(&scope.space_id) {
                    if !slot.is_detached()
                        && self.publication.try_read().is_ok()
                        && !self.publication_closed.load(Ordering::Acquire)
                        && let Some(cut) = slot.admitted_cut()
                    {
                        scope.check(&cut.cut.scope)?;
                        if cut.cut.projected_seq >= seq && !cut.base.repair_pending() {
                            return Ok(cut);
                        }
                    }
                    continue;
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
                    _ = slot_added => {}
                    _ = activation.changed() => {}
                }
                continue;
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

struct CandidateDropGuard {
    control: GenerationControl,
    candidate: Option<GenerationDescriptor>,
    local_owner: Option<Arc<std::fs::File>>,
    postgres_runtime_guard: Option<Arc<PostgresRuntimeGuard>>,
}

impl CandidateDropGuard {
    fn disarm(&mut self) {
        self.candidate = None;
    }
}

impl Drop for CandidateDropGuard {
    fn drop(&mut self) {
        if let Some(candidate) = self.candidate.take() {
            let control = self.control.clone();
            let local_owner = self.local_owner.take();
            let postgres_runtime_guard = self.postgres_runtime_guard.take();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _local_owner = local_owner;
                    let _pg_guard = postgres_runtime_guard;
                    let _ = control.cancel_candidate(&candidate).await;
                });
            }
        }
    }
}

/// Clears leftover local cache state under an exclusively locked ephemeral
/// PostgreSQL cache root while preserving the live owner lock file.
fn reset_ephemeral_cache_dir(root: &DataRoot) -> Result<(), PortError> {
    use std::fs;
    let v1 = root.root().join("v1");
    let entries = match fs::read_dir(&v1) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(checkpoint_error(err)),
    };
    for entry in entries {
        let entry = entry.map_err(checkpoint_error)?;
        let name = entry.file_name();
        if name.to_str() == Some("projection_checkpoint.lock") {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(checkpoint_error)?;
        if meta.is_dir() {
            fs::remove_dir_all(&path).map_err(checkpoint_error)?;
        } else {
            fs::remove_file(&path).map_err(checkpoint_error)?;
        }
    }
    Ok(())
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
fn cache_identity(
    root: &DataRoot,
    owner: Option<&PostgresCacheOwner>,
    expected: Option<&str>,
) -> Result<String, PortError> {
    let id =
        if expected.is_some() || owner.is_some_and(|owner| owner.cache_identity.get().is_some()) {
            read_cache_identity(root)?
        } else {
            initialize_cache_identity(root, false)?
        };
    if expected.is_some_and(|expected| expected != id) {
        return Err(DomainError::validation(ValidationReason::NotReady).into());
    }
    if let Some(owner) = owner
        && owner.cache_identity.get_or_init(|| id.clone()) != &id
    {
        return Err(DomainError::validation(ValidationReason::NotReady).into());
    }
    Ok(id)
}

fn initialize_cache_identity(root: &DataRoot, create_new: bool) -> Result<String, PortError> {
    use std::{fs, io::Write};
    let directory = root.root().join("v1");
    fs::create_dir_all(&directory).map_err(checkpoint_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let path = directory.join("projection_cache_id");
    if path.try_exists().map_err(checkpoint_error)? {
        if create_new {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        return read_cache_identity(root);
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
            Err(error) if !create_new && error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        #[cfg(unix)]
        {
            fs::File::open(&directory)?.sync_all()?;
            if create_new {
                // Provisioning may have just created v1 on the selected volume.
                fs::File::open(root.root())?.sync_all()?;
            }
        }
        Ok(())
    })();
    drop(file);
    let _ = fs::remove_file(staging);
    result.map_err(checkpoint_error)?;
    if create_new {
        Ok(value)
    } else {
        read_cache_identity(root)
    }
}

// Erasure must inspect the mounted cache without creating a new identity.
fn read_cache_identity(root: &DataRoot) -> Result<String, PortError> {
    use std::{fs, io::Read};

    let path = root.root().join("v1/projection_cache_id");
    #[cfg(unix)]
    let file = {
        use rustix::fs::{Mode, OFlags, open};
        fs::File::from(
            open(
                &path,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(std::io::Error::from)
            .map_err(checkpoint_error)?,
        )
    };
    #[cfg(not(unix))]
    let file = {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options.custom_flags(OPEN_REPARSE_POINT);
        }
        options.open(&path).map_err(checkpoint_error)?
    };
    let meta = file.metadata().map_err(checkpoint_error)?;
    let invalid = || DomainError::validation(ValidationReason::InvalidState);
    if !meta.is_file() || meta.len() != 32 {
        return Err(invalid().into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(invalid().into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & REPARSE_POINT != 0 {
            return Err(invalid().into());
        }
    }
    let mut value = String::new();
    file.take(33)
        .read_to_string(&mut value)
        .map_err(checkpoint_error)?;
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid().into());
    }
    Ok(value)
}

#[cfg(test)]
mod event_scrub_tests {
    use super::*;
    use notarium_core::ports::{BoardDelta, GroupCount, GroupKey, ViewRef};
    use notarium_core::value::ScalarValue;

    #[test]
    fn scrub_space_events_clears_queued_and_late_board_deltas_in_ram() {
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([7; 16]),
            incarnation: HistoryIncarnation::from_bytes([8; 16]),
        };
        let channel = SpaceEventChannel::new();
        let make_delta = |seq: u64| {
            board_events::ScrubbableBoardDelta::new(BoardDelta {
                scope: scope.clone(),
                seq: SpaceSeq::new(seq).unwrap(),
                view: ViewRef {
                    note: NoteId::from_bytes([1; 16]),
                    key: ViewKey::from_bytes([2; 16]),
                },
                groups: vec![GroupCount {
                    group: GroupKey::Value(ScalarValue::String("todo".into())),
                    count: 1,
                }],
                ranks: vec![(NoteId::from_bytes([3; 16]), "000001".into())],
            })
        };

        let queued_delta = make_delta(5);
        SpaceEventChannel::track_board_delta(
            &channel.scrub,
            &scope,
            SpaceSeq::new(5).unwrap(),
            &queued_delta,
        );
        assert!(queued_delta.clone_payload().is_some());

        let queued_space = events::ScrubbableSpaceEvent::new(notarium_core::ports::SpaceEvent {
            scope: scope.clone(),
            seq: SpaceSeq::new(5).unwrap(),
            kind: notarium_core::ports::SpaceEventKind::Job(notarium_core::ports::ContentJob {
                id: notarium_core::ids::JobId::from_bytes([7; 16]),
                kind: notarium_core::ports::ContentJobKind::Backup,
                state: notarium_core::ports::JobState::Running,
                completed_units: 0,
                total_units: None,
                lease: notarium_core::ids::LeaseEpoch::new(1).unwrap(),
                artifacts: Vec::new(),
            }),
        });
        SpaceEventChannel::track_space_event(
            &channel.scrub,
            &scope,
            SpaceSeq::new(5).unwrap(),
            &queued_space,
        );
        assert!(queued_space.clone_event().is_some());

        // Purge/redaction at seq 10 must immediately clear queued payloads in RAM
        // before any subscriber polls, and record scrub_floor = 10 for late notices.
        SpaceEventChannel::scrub_through(&channel.scrub, &scope, SpaceSeq::new(10).unwrap());
        assert!(
            queued_delta.clone_payload().is_none(),
            "queued BoardDelta payload must be scrubbed in RAM immediately on erasure"
        );
        assert!(
            queued_space.clone_event().is_none(),
            "queued SpaceEvent payload must be scrubbed in RAM immediately on erasure"
        );

        // Late notice at seq 9 <= floor 10 must be cleared on enqueue; newer seq 11 must survive.
        let late_delta = make_delta(9);
        SpaceEventChannel::track_board_delta(
            &channel.scrub,
            &scope,
            SpaceSeq::new(9).unwrap(),
            &late_delta,
        );
        let newer_delta = make_delta(11);
        SpaceEventChannel::track_board_delta(
            &channel.scrub,
            &scope,
            SpaceSeq::new(11).unwrap(),
            &newer_delta,
        );
        assert!(late_delta.clone_payload().is_none());
        assert!(newer_delta.clone_payload().is_some());
    }
}

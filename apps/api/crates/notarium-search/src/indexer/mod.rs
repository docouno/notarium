mod build;
#[cfg(test)]
mod tests;
mod update;

use crate::{
    config::VectorMode,
    embed::EmbeddingError,
    engine::{
        DrainGate, Published, Services, SpaceHandle, WorkerTable, finish_exited_worker,
        maintenance_budget, try_evict_idle_worker,
    },
    layout::{FolderDictionary, LayoutError, SearchLayout, SearchManifest},
    lexical::{LexicalError, LexicalIndex, TOKENIZER_VERSION},
    ports::ResolvedEmbeddingTarget,
    vector::{
        CompactionPlan, FlushL0Plan, MmapSegment, MutableOperation, QuantizedVector, VectorEpoch,
        VectorError,
    },
};
use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId, RequestId, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::{
        CallBudget, Cancellation, ChangeNotice, ChangeRead, ChangeReadResult, ChangeSubscription,
        MaintenanceContext, PageLimit,
    },
    receipt::ChangeCursor,
};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::watch,
    task::JoinHandle,
    time::{MissedTickBehavior, interval, sleep},
};

const REMOTE_ADMISSION_CHECK: Duration = Duration::from_secs(5);
const MAINTENANCE_TICK: Duration = Duration::from_secs(1);
const LEXICAL_IDLE: Duration = Duration::from_secs(30);
const EMBEDDER_IDLE: Duration = Duration::from_secs(60);
const WORKER_IDLE: Duration = Duration::from_secs(300);
const ARCHIVED_IDLE: Duration = Duration::from_secs(30);
const MAX_CACHED_VECTORS: usize = 4096;

#[derive(Clone, Copy)]
pub(crate) struct Schedule {
    pub(crate) tick: Duration,
    pub(crate) lexical_idle: Duration,
    pub(crate) embedder_idle: Duration,
    pub(crate) worker_idle: Duration,
    pub(crate) archived_idle: Duration,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            tick: MAINTENANCE_TICK,
            lexical_idle: LEXICAL_IDLE,
            embedder_idle: EMBEDDER_IDLE,
            worker_idle: WORKER_IDLE,
            archived_idle: ARCHIVED_IDLE,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum IndexError {
    #[error("canonical read failed")]
    Port(#[from] PortError),
    #[error("canonical data is invalid")]
    Domain(#[from] DomainError),
    #[error("search layout failed")]
    Layout(#[from] LayoutError),
    #[error("lexical update failed")]
    Lexical(#[from] LexicalError),
    #[error("vector update failed")]
    Vector(#[from] VectorError),
    #[error("index checkpoints disagree")]
    Inconsistent,
}

impl IndexError {
    /// Only discard rebuildable files when the checkpoint is demonstrably invalid.
    fn invalid_checkpoint(&self) -> bool {
        use std::io::ErrorKind;
        use tantivy::{
            TantivyError,
            directory::error::{OpenDirectoryError, OpenReadError},
        };
        let invalid_file = |error: &std::io::Error| {
            matches!(
                error.kind(),
                ErrorKind::NotFound
                    | ErrorKind::NotADirectory
                    | ErrorKind::InvalidData
                    | ErrorKind::UnexpectedEof
            )
        };
        match self {
            Self::Inconsistent
            | Self::Layout(LayoutError::Corrupt | LayoutError::WrongHistory)
            | Self::Vector(
                VectorError::CorruptIndex
                | VectorError::InvalidChunk
                | VectorError::InvalidDimension
                | VectorError::InvalidVector
                | VectorError::Layout(LayoutError::Corrupt | LayoutError::WrongHistory),
            )
            | Self::Lexical(
                LexicalError::CorruptIndex
                | LexicalError::Tantivy(
                    TantivyError::DataCorruption(_)
                    | TantivyError::IncompatibleIndex(_)
                    | TantivyError::DeserializeError(_)
                    | TantivyError::SchemaError(_)
                    | TantivyError::OpenDirectoryError(
                        OpenDirectoryError::DoesNotExist(_) | OpenDirectoryError::NotADirectory(_),
                    )
                    | TantivyError::OpenReadError(
                        OpenReadError::FileDoesNotExist(_) | OpenReadError::IncompatibleIndex(_),
                    ),
                ),
            ) => true,
            Self::Layout(LayoutError::Io(error))
            | Self::Lexical(LexicalError::Io(error))
            | Self::Vector(VectorError::Io(error) | VectorError::Layout(LayoutError::Io(error))) => {
                invalid_file(error)
            }
            Self::Lexical(LexicalError::Tantivy(
                TantivyError::IoError(error)
                | TantivyError::OpenDirectoryError(OpenDirectoryError::IoError {
                    io_error: error,
                    ..
                })
                | TantivyError::OpenReadError(OpenReadError::IoError {
                    io_error: error, ..
                }),
            )) => invalid_file(error),
            _ => false,
        }
    }

    fn requires_reseed(&self) -> bool {
        match self {
            Self::Port(PortError::Domain(error)) | Self::Domain(error) => error.requires_resync(),
            _ => false,
        }
    }

    fn vector_replay_error(self) -> Self {
        match self {
            Self::Port(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if matches!(
                    diagnostic.reason,
                    ValidationReason::InvalidCutoff | ValidationReason::InvalidRange
                ) =>
            {
                DomainError::validation(ValidationReason::PurgeResync).into()
            }
            other => other,
        }
    }

    fn requires_scrub(&self) -> bool {
        matches!(
            self,
            Self::Port(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                | Self::Domain(DomainError::ValidationFailed { diagnostic })
                if matches!(
                    diagnostic.reason,
                    ValidationReason::CursorStale | ValidationReason::PurgeResync
                )
        )
    }
}

#[derive(Debug, thiserror::Error)]
enum ModelError {
    #[error("embedding model unavailable")]
    Embedding(#[from] EmbeddingError),
    #[error("model indexing step failed")]
    Index(#[from] IndexError),
}

impl From<PortError> for ModelError {
    fn from(error: PortError) -> Self {
        Self::Index(IndexError::Port(error))
    }
}

impl From<DomainError> for ModelError {
    fn from(error: DomainError) -> Self {
        Self::Index(IndexError::Domain(error))
    }
}

impl From<LayoutError> for ModelError {
    fn from(error: LayoutError) -> Self {
        Self::Index(IndexError::Layout(error))
    }
}

impl From<VectorError> for ModelError {
    fn from(error: VectorError) -> Self {
        match error {
            VectorError::Cancelled => Self::Embedding(EmbeddingError::Cancelled),
            other => Self::Index(IndexError::Vector(other)),
        }
    }
}

struct Context<'a> {
    services: &'a Arc<Services>,
    handle: &'a Arc<SpaceHandle>,
}

impl Context<'_> {
    fn reader_owner(&self) -> Weak<dyn crate::lexical::IdleReaderOwner> {
        Arc::downgrade(self.handle) as Weak<dyn crate::lexical::IdleReaderOwner>
    }

    fn budget(&self) -> CallBudget {
        new_budget(&self.handle.stop)
    }

    fn maintenance(&self) -> MaintenanceContext {
        MaintenanceContext {
            authority: self.services.authority.clone(),
            budget: self.budget(),
        }
    }

    async fn latest(&self, scope: &HistoryScope) -> Result<ChangeCursor, IndexError> {
        let rec = self
            .services
            .deps
            .canonical
            .read_space(&scope.space_id)
            .await?;
        Ok(ChangeCursor {
            scope: rec.scope,
            after: rec.last_seq,
        })
    }

    async fn requires_scrub(&self, cut: ChangeCursor) -> Result<bool, IndexError> {
        let result = self
            .services
            .deps
            .canonical
            .validate_search_index_cut(&self.services.authority, self.budget(), cut)
            .await
            .map_err(IndexError::from);
        match result {
            Ok(()) => Ok(false),
            Err(error) if error.requires_scrub() => Ok(true),
            Err(error) => Err(error),
        }
    }

    async fn has_pending_redaction(&self, cutoff: ChangeCursor) -> Result<bool, IndexError> {
        self.services
            .deps
            .canonical
            .has_search_redaction_after(&self.services.authority, self.budget(), cutoff)
            .await
            .map_err(IndexError::from)
    }

    async fn cut_needs_scrub(
        &self,
        cursor: &ChangeCursor,
        check_redaction: bool,
    ) -> Result<bool, IndexError> {
        if self.requires_scrub(cursor.clone()).await? {
            return Ok(true);
        }
        if check_redaction {
            return self.has_pending_redaction(cursor.clone()).await;
        }
        Ok(false)
    }
}

pub(super) fn new_budget(cancellation: &Cancellation) -> CallBudget {
    static REQUEST: AtomicU64 = AtomicU64::new(0);
    let mut id = [0; 16];
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    id[..8].copy_from_slice(&(now as u64).to_le_bytes());
    id[8..].copy_from_slice(&REQUEST.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    maintenance_budget(cancellation, RequestId::from_bytes(id))
}

/// The current pass always reaches its tail. Invalidations of an already
/// visited prefix coalesce into one subsequent pass from the beginning.
#[derive(Debug, Eq, PartialEq)]
enum FullSweep {
    Idle,
    Requested,
    Scanning { after: NoteId, repeat: bool },
}

impl FullSweep {
    fn from_pending(pending: bool) -> Self {
        if pending { Self::Requested } else { Self::Idle }
    }

    fn request(&mut self) {
        match self {
            Self::Idle | Self::Requested => *self = Self::Requested,
            Self::Scanning { repeat, .. } => *repeat = true,
        }
    }

    fn after(&self) -> Option<NoteId> {
        match self {
            Self::Scanning { after, .. } => Some(after.clone()),
            Self::Idle | Self::Requested => None,
        }
    }

    fn finish_page(&mut self, next: Option<NoteId>) {
        let repeat = matches!(self, Self::Scanning { repeat: true, .. });
        *self = match next {
            Some(after) => Self::Scanning { after, repeat },
            None => Self::from_pending(repeat),
        };
    }
}

/// Fresh revisions and unattempted carriers stay ready. Only notes that failed
/// share a retry deadline. Both kinds of work rotate alongside the Space sweep.
#[derive(Default)]
struct RepairTurns {
    ready: BTreeSet<NoteId>,
    retry: Arc<BTreeSet<NoteId>>,
    dirty_after: Option<NoteId>,
    retry_at: Option<Instant>,
    retry_delay: Duration,
    prefer_sweep: bool,
}

impl RepairTurns {
    fn forget(&mut self, id: &NoteId) {
        self.ready.remove(id);
        if self.retry.contains(id) {
            Arc::make_mut(&mut self.retry).remove(id);
            if self.retry.is_empty() {
                self.retry_at = None;
                self.retry_delay = Duration::ZERO;
            }
        }
    }

    fn edit(&mut self, id: NoteId) {
        self.forget(&id);
        self.ready.insert(id);
    }

    fn next_batch(&mut self, sweep: &FullSweep, now: Instant) -> Option<update::EmbedBatchMode> {
        if self.retry_at.is_some_and(|at| now >= at) {
            self.ready.append(Arc::make_mut(&mut self.retry));
            self.retry_at = None;
        }
        if *sweep != FullSweep::Idle && (self.prefer_sweep || self.ready.is_empty()) {
            self.prefer_sweep = false;
            return Some(update::EmbedBatchMode::FullSweep {
                after: sweep.after(),
            });
        }
        if self.ready.is_empty() {
            return None;
        }
        let mut after = self
            .dirty_after
            .as_ref()
            .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        if self
            .ready
            .range((after, std::ops::Bound::Unbounded))
            .next()
            .is_none()
        {
            after = std::ops::Bound::Unbounded;
        }
        let ids: Vec<_> = self
            .ready
            .range((after, std::ops::Bound::Unbounded))
            .take(update::REPAIR_CARRIER_PAGE)
            .cloned()
            .collect();
        // Keep selected IDs pending until the result arrives. A concurrent edit
        // or deletion can supersede the selected revision in the meantime.
        self.prefer_sweep = true;
        Some(update::EmbedBatchMode::DirtyNotes(ids))
    }

    fn finish_targeted(
        &mut self,
        selected: Vec<NoteId>,
        changed: &HashSet<NoteId>,
        last: Option<NoteId>,
    ) {
        for id in selected {
            if !changed.contains(&id) {
                self.ready.remove(&id);
            }
        }
        self.dirty_after = last;
    }

    fn defer(&mut self, ids: impl Iterator<Item = NoteId>, now: Instant) {
        for id in ids {
            self.ready.remove(&id);
            Arc::make_mut(&mut self.retry).insert(id);
        }
        if !self.retry.is_empty() && self.retry_at.is_none() {
            self.retry_delay =
                (self.retry_delay * 2).clamp(Duration::from_secs(1), Duration::from_secs(300));
            self.retry_at = Some(now + self.retry_delay);
        }
    }

    fn next_at(&self, sweep: &FullSweep, at: Instant) -> Instant {
        if self.ready.is_empty() && *sweep == FullSweep::Idle {
            return self.retry_at.map_or(at, |retry| at.max(retry));
        }
        at
    }
}

struct Disk {
    layout: Arc<SearchLayout>,
    manifest: SearchManifest,
    folders: Arc<FolderDictionary>,
    lexical_path: PathBuf,
    lexical_idle_retired: bool,
    epoch: Option<VectorEpoch>,
    embedder: Option<Arc<crate::model::Embedder>>,
    repairs: RepairTurns,
    cached_vectors: HashMap<ContentDigest, Arc<QuantizedVector>>,
    sweep: FullSweep,
    last_activity: Instant,
    embedder_last_use: Instant,
    embedder_unavailable: bool,
}

impl Disk {
    fn cursor(&self) -> ChangeCursor {
        ChangeCursor {
            scope: self.manifest.scope.clone(),
            after: self.manifest.tantivy_seq,
        }
    }

    fn cache_note_vectors(&mut self, note: &NoteId) {
        let Some(chunks) = self
            .epoch
            .as_ref()
            .map(|epoch| epoch.mutable_note_chunks(note))
        else {
            return;
        };
        if chunks.is_empty() {
            return;
        }
        if self.cached_vectors.len() >= MAX_CACHED_VECTORS {
            self.cached_vectors.clear();
        }
        for chunk in chunks {
            if self.cached_vectors.len() >= MAX_CACHED_VECTORS {
                break;
            }
            self.cached_vectors
                .entry(chunk.metadata.key)
                .or_insert_with(|| Arc::new(chunk.vector.clone()));
        }
    }

    fn request_full_sweep(&mut self) {
        self.sweep.request();
        self.manifest.embeddings_pending = true;
        if let Some(replay) = &mut self.manifest.vector_replay_after {
            replay.needs_sweep = true;
        }
    }

    fn has_pending_embeddings(&self) -> bool {
        !self.repairs.ready.is_empty()
            || !self.repairs.retry.is_empty()
            || self.sweep != FullSweep::Idle
    }

    fn needs_embedding_work(&self) -> bool {
        self.epoch.is_some() && self.embedder.is_some() && self.has_pending_embeddings()
    }

    async fn resume_reader(
        &mut self,
        cx: &Context<'_>,
    ) -> Result<(Arc<LexicalIndex>, bool), IndexError> {
        let owner = cx.reader_owner();
        if let Some(existing) = cx
            .services
            .readers
            .get_owned(&self.lexical_path, owner.clone())?
        {
            self.lexical_idle_retired = false;
            self.last_activity = Instant::now();
            let needs_publish = !cx.handle.is_published();
            return Ok((existing, needs_publish));
        }
        let readers = cx.services.readers.clone();
        let layout = self.layout.clone();
        let manifest = self.manifest.clone();
        let (dir, reader) = tokio::task::spawn_blocking(move || {
            let dir = layout.index_dir(&manifest)?;
            let reader = readers.open_owned(&dir, owner)?;
            if reader.commit_id()? != manifest.tantivy_commit {
                return Err(IndexError::Inconsistent);
            }
            Ok::<_, IndexError>((dir, reader))
        })
        .await
        .map_err(|_| IndexError::Inconsistent)??;
        self.lexical_path = dir;
        self.lexical_idle_retired = false;
        self.last_activity = Instant::now();
        Ok((reader, true))
    }

    fn release_idle_embedder(&mut self, now: Instant, idle: Duration) -> bool {
        if self.embedder.is_some() && now.saturating_duration_since(self.embedder_last_use) >= idle
        {
            self.embedder.take();
            self.embedder_unavailable = false;
            true
        } else {
            false
        }
    }

    async fn publish_manifest(&self) -> Result<(), IndexError> {
        let layout = self.layout.clone();
        let manifest = self.manifest.clone();
        tokio::task::spawn_blocking(move || layout.publish_search(&manifest))
            .await
            .map_err(|_| IndexError::Inconsistent)??;
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct BgDirty {
    pub notes: HashSet<NoteId>,
    pub folders: BTreeSet<FolderId>,
}

impl BgDirty {
    fn take_remote_folders(
        &mut self,
        target: Option<&ResolvedEmbeddingTarget>,
    ) -> BTreeSet<FolderId> {
        let folders = std::mem::take(&mut self.folders);
        if let Some(crate::ports::EmbeddingBackendTarget::Remote { .. }) =
            target.map(|target| &target.backend)
        {
            folders
        } else {
            BTreeSet::new()
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum BgKind {
    ReopenVectors,
    LoadEmbedder,
    ModelRefresh,
    EmbedBatch,
    FlushL0,
    CompactStep,
}

enum BgOutcome {
    ReopenVectors(Result<(VectorEpoch, BTreeSet<NoteId>), IndexError>),
    LoadEmbedder(Option<Arc<crate::model::Embedder>>),
    ModelRefresh(Result<build::ModelRefreshOutcome, ModelError>),
    EmbedBatch(Result<update::EmbedBatchOutcome, IndexError>),
    FlushL0(Result<(FlushL0Plan, Option<MmapSegment>), VectorError>),
    CompactStep(Result<(CompactionPlan, Option<MmapSegment>), VectorError>),
}

struct BgTask {
    kind: BgKind,
    cancel: Cancellation,
    dirty: BgDirty,
    handle: JoinHandle<BgOutcome>,
}

impl BgTask {
    fn is_reopening(&self) -> bool {
        matches!(self.kind, BgKind::ReopenVectors | BgKind::LoadEmbedder)
    }
}

async fn cancel_bg(bg: &mut Option<BgTask>) {
    if let Some(task) = bg.take() {
        task.cancel.cancel();
        let _ = task.handle.await;
    }
}

enum LoopEvent {
    Stop,
    Resync(HistoryScope),
    Advance {
        target: ChangeCursor,
        force_seed: bool,
        scrub: bool,
        rebind: bool,
        purge_resync: bool,
    },
    Lagged {
        resume: ChangeCursor,
    },
    Wake,
    BgDone(Box<Result<BgOutcome, tokio::task::JoinError>>),
    Tick,
}

enum AdvanceOutcome {
    Resync(HistoryScope),
    Done { scrubbed: bool },
}

struct Publisher<'a> {
    handle: &'a SpaceHandle,
}

impl Publisher<'_> {
    fn snapshot(disk: &Disk, lexical: &Arc<LexicalIndex>, reopening: bool) -> Published {
        Published {
            scope: disk.manifest.scope.clone(),
            seq: disk.manifest.tantivy_seq,
            lexical: lexical.clone(),
            searcher: lexical.searcher(),
            folders: disk.folders.clone(),
            vectors: disk.epoch.as_ref().map(|epoch| Arc::new(epoch.snapshot())),
            active_model: disk.manifest.active_model.clone(),
            embedder: disk.embedder.clone(),
            embeddings_pending: disk.manifest.embeddings_pending,
            reopening_vectors: reopening && disk.manifest.vector_replay_after.is_none(),
            embedder_unavailable: disk.embedder_unavailable
                || disk.manifest.vector_replay_after.is_some(),
        }
    }

    fn replace(&mut self, next: Option<Arc<Published>>) {
        let _ = self.handle.replace(next);
    }

    fn publish_with(&mut self, disk: &Disk, lexical: &Arc<LexicalIndex>, reopening: bool) {
        self.replace(Some(Arc::new(Self::snapshot(disk, lexical, reopening))));
    }

    fn publish_if_live(&mut self, disk: &Disk, reopening: bool) {
        self.handle
            .replace_if_live(|lexical| Self::snapshot(disk, lexical, reopening));
    }

    fn retire_if_idle(&mut self) -> bool {
        self.handle.retire_if_idle()
    }

    async fn drain(&mut self) {
        self.handle.drain_published().await;
    }
}

struct WorkerExitGuard {
    workers: Weak<Mutex<WorkerTable>>,
    space_id: SpaceId,
    handle: Arc<SpaceHandle>,
    gate: Arc<DrainGate>,
}

impl Drop for WorkerExitGuard {
    fn drop(&mut self) {
        finish_exited_worker(&self.workers, &self.space_id, &self.handle, &self.gate);
    }
}

pub(super) async fn run(
    services: Arc<Services>,
    handle: Arc<SpaceHandle>,
    workers: Weak<Mutex<WorkerTable>>,
    gate: Arc<DrainGate>,
    mut prev_drain: Option<watch::Receiver<bool>>,
    mut scope: HistoryScope,
) {
    let _exit_guard = WorkerExitGuard {
        workers: workers.clone(),
        space_id: scope.space_id.clone(),
        handle: handle.clone(),
        gate,
    };
    // Serialize per-Space disk ownership against any evicted worker still
    // finishing in-flight I/O or draining published snapshots.
    if let Some(rx) = prev_drain.as_mut() {
        let _ = rx.wait_for(|done| *done).await;
    }
    if handle.stop.is_cancelled() {
        return;
    }
    let cx = Context {
        services: &services,
        handle: &handle,
    };
    let mut publisher = Publisher { handle: &handle };
    loop {
        if handle.stop.is_cancelled() {
            break;
        }
        match consume(
            &cx,
            &mut publisher,
            &workers,
            scope.clone(),
            services.schedule,
        )
        .await
        {
            Ok(Some(next_scope)) => scope = next_scope,
            Ok(None) => break,
            Err(error) if error.requires_reseed() => {
                tracing::debug!("search subscriber invalidated; reopening");
            }
            Err(error) => {
                tracing::warn!(kind = %error, "search subscriber retrying after an index failure");
                tokio::select! {
                    () = handle.stop.cancelled() => break,
                    () = sleep(Duration::from_millis(250)) => {},
                }
            }
        }
        publisher.replace(None);
        publisher.drain().await;
    }
    publisher.replace(None);
    publisher.drain().await;
}

async fn consume(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    workers: &Weak<Mutex<WorkerTable>>,
    starting_scope: HistoryScope,
    schedule: Schedule,
) -> Result<Option<HistoryScope>, IndexError> {
    let record = match cx
        .services
        .deps
        .canonical
        .read_space(&starting_scope.space_id)
        .await
    {
        Ok(record) => record,
        Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let scope = record.scope;
    let data_root = cx.services.config.data_root.clone();
    let layout_scope = scope.clone();
    let layout = Arc::new(
        tokio::task::spawn_blocking(move || SearchLayout::open(&data_root, layout_scope))
            .await
            .map_err(|_| IndexError::Inconsistent)??,
    );
    if record.space.lifecycle != SpaceLifecycle::Active {
        // Retire every derived copy and release directory handles before
        // waiting with backoff; evict the worker after archived_idle so
        // archived Spaces hold zero FDs, tasks, or change_log polls.
        build::scrub(cx, publisher, &layout).await?;
        drop(layout);
        let mut archived_since = Instant::now();
        let mut delay = Duration::from_millis(250);
        loop {
            tokio::select! {
                biased;
                () = cx.handle.stop.cancelled() => return Ok(None),
                () = cx.handle.wake.notified() => {
                    archived_since = Instant::now();
                    delay = Duration::from_millis(250);
                }
                () = sleep(delay) => {
                    delay = (delay * 2).min(Duration::from_secs(5));
                }
            }
            let current = cx
                .services
                .deps
                .canonical
                .read_space(&scope.space_id)
                .await?;
            if current.scope != scope || current.space.lifecycle == SpaceLifecycle::Active {
                return Ok(Some(current.scope));
            }
            if archived_since.elapsed() >= schedule.archived_idle
                && try_evict_idle_worker(
                    workers,
                    &scope.space_id,
                    cx.handle,
                    schedule.archived_idle,
                )
            {
                return Ok(None);
            }
        }
    }

    let (disk, initial_lexical) =
        match open_disk(cx, publisher, layout.clone(), record.last_seq).await? {
            Some((disk, lexical)) => (Some(disk), Some(lexical)),
            None => (None, None),
        };
    let start = disk
        .as_ref()
        .map(Disk::cursor)
        .unwrap_or_else(|| ChangeCursor {
            scope: scope.clone(),
            after: SpaceSeq::ZERO,
        });
    let subscription = cx
        .services
        .deps
        .changes
        .subscribe(cx.maintenance(), start)
        .await?;
    let delivered = subscription.processed().after;
    let mut bg: Option<BgTask> = None;
    let outcome = run_active_loop(
        cx,
        publisher,
        workers,
        &layout,
        &scope,
        schedule,
        disk,
        initial_lexical,
        subscription,
        delivered,
        &mut bg,
    )
    .await;
    cancel_bg(&mut bg).await;
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn run_active_loop(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    workers: &Weak<Mutex<WorkerTable>>,
    layout: &Arc<SearchLayout>,
    scope: &HistoryScope,
    schedule: Schedule,
    mut disk: Option<Disk>,
    mut initial_lexical: Option<Arc<LexicalIndex>>,
    mut subscription: Box<dyn ChangeSubscription>,
    mut delivered: SpaceSeq,
    bg: &mut Option<BgTask>,
) -> Result<Option<HistoryScope>, IndexError> {
    let mut model_check_due = true;
    let mut admission_check_at = Instant::now() + REMOTE_ADMISSION_CHECK;
    let mut retry_model = false;
    let mut model_retry_at = Instant::now();
    let mut model_retry_delay = Duration::from_secs(1);
    let mut embedder_retry_at = Instant::now();
    let mut repair_at = Instant::now();
    let mut repair_delay = Duration::from_secs(1);
    let mut needs_ack = false;
    let mut pending_rebind = false;
    let mut ack_after_embed = false;

    if let Some(current) = &mut disk {
        spawn_bg_if_ready(
            cx,
            current,
            bg,
            &mut model_check_due,
            model_retry_at,
            embedder_retry_at,
            repair_at,
            schedule.embedder_idle,
            false,
        )?;
        if let Some(lexical) = initial_lexical.take() {
            publisher.publish_with(
                current,
                &lexical,
                bg.as_ref().is_some_and(BgTask::is_reopening),
            );
        }
    }

    let mut ticker = interval(schedule.tick);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        let now = Instant::now();
        let vectors_enabled = !matches!(cx.services.config.vector_mode, VectorMode::Disabled);
        let next_timer = next_maintenance_wake(
            disk.as_ref(),
            bg.is_some(),
            vectors_enabled,
            retry_model,
            model_retry_at,
            embedder_retry_at,
            repair_at,
        );
        let timer_sleep = next_timer
            .map(|at| tokio::time::sleep_until(tokio::time::Instant::from_std(at.max(now))));

        let event = next_event(
            cx,
            &mut subscription,
            &mut delivered,
            bg,
            &disk,
            &mut ticker,
            timer_sleep,
        )
        .await?;

        match event {
            LoopEvent::Stop => return Ok(None),
            LoopEvent::Resync(next_scope) => return Ok(Some(next_scope)),
            LoopEvent::BgDone(joined) => {
                let task = bg.take().expect("bg task completed");
                let was_kind = task.kind;
                let outcome = (*joined).map_err(|_| IndexError::Inconsistent)?;
                let dirty = task.dirty;
                let built_with_dirty = handle_bg_done(
                    cx,
                    publisher,
                    &mut disk,
                    layout,
                    outcome,
                    dirty,
                    &mut model_check_due,
                    &mut retry_model,
                    &mut model_retry_at,
                    &mut model_retry_delay,
                    &mut embedder_retry_at,
                    &mut repair_at,
                    &mut repair_delay,
                )
                .await?;
                if was_kind == BgKind::ModelRefresh {
                    ack_after_embed = built_with_dirty;
                } else if was_kind == BgKind::EmbedBatch && ack_after_embed {
                    ack_after_embed = false;
                    if needs_ack && let Some(current) = &disk {
                        let force_rebind = std::mem::take(&mut pending_rebind);
                        sync_subscription(
                            cx,
                            &mut subscription,
                            &mut delivered,
                            current.cursor(),
                            force_rebind,
                        )
                        .await?;
                        needs_ack = false;
                    }
                }
            }
            LoopEvent::Advance {
                target,
                mut force_seed,
                mut scrub,
                rebind,
                purge_resync,
            } => {
                if *scope != target.scope {
                    return Ok(Some(target.scope));
                }
                if purge_resync
                    && let Some(current) = disk.as_ref()
                    && current.epoch.is_none()
                    && current.manifest.vector_seq.is_none()
                    && !cx.cut_needs_scrub(&current.cursor(), true).await?
                {
                    // Already scrubbed and reseeded past every prior purge;
                    // a lagged re-scan from an unacked pre-purge cursor must
                    // not cancel an in-flight ModelRefresh.
                    force_seed = false;
                    scrub = false;
                }
                match advance_to(
                    cx,
                    publisher,
                    layout,
                    scope,
                    &mut disk,
                    bg,
                    target,
                    force_seed,
                    scrub,
                    &mut model_check_due,
                    embedder_retry_at,
                    schedule.embedder_idle,
                    &mut repair_at,
                    &mut repair_delay,
                    &mut ack_after_embed,
                )
                .await?
                {
                    AdvanceOutcome::Resync(next_scope) => return Ok(Some(next_scope)),
                    AdvanceOutcome::Done { scrubbed } => {
                        needs_ack = true;
                        pending_rebind |= rebind;
                        if (purge_resync || scrubbed)
                            && let Some(current) = &disk
                            && current.epoch.is_none()
                        {
                            // Acknowledge past the scrubbed purge before spawning a
                            // long ModelRefresh so BroadcastHub lag cannot re-emit
                            // PurgeResync in an endless scrub/reseed loop.
                            let force_rebind = std::mem::take(&mut pending_rebind);
                            sync_subscription(
                                cx,
                                &mut subscription,
                                &mut delivered,
                                current.cursor(),
                                force_rebind,
                            )
                            .await?;
                            needs_ack = false;
                        }
                    }
                }
                if bg.is_none() && Instant::now() >= model_retry_at {
                    model_check_due = true;
                }
            }
            LoopEvent::Lagged { resume } => {
                let target = cx.latest(&resume.scope).await?;
                if *scope != target.scope {
                    return Ok(Some(target.scope));
                }
                match advance_to(
                    cx,
                    publisher,
                    layout,
                    scope,
                    &mut disk,
                    bg,
                    target,
                    false,
                    false,
                    &mut model_check_due,
                    embedder_retry_at,
                    schedule.embedder_idle,
                    &mut repair_at,
                    &mut repair_delay,
                    &mut ack_after_embed,
                )
                .await?
                {
                    AdvanceOutcome::Resync(next_scope) => return Ok(Some(next_scope)),
                    AdvanceOutcome::Done { scrubbed } => {
                        needs_ack = true;
                        pending_rebind = true;
                        if scrubbed
                            && let Some(current) = &disk
                            && current.epoch.is_none()
                        {
                            let force_rebind = std::mem::take(&mut pending_rebind);
                            sync_subscription(
                                cx,
                                &mut subscription,
                                &mut delivered,
                                current.cursor(),
                                force_rebind,
                            )
                            .await?;
                            needs_ack = false;
                        }
                    }
                }
            }
            LoopEvent::Wake => {
                let now = Instant::now();
                cx.handle.touch();
                if let Some(current) = &mut disk {
                    current.last_activity = now;
                    current.embedder_last_use = now;
                    if now >= embedder_retry_at {
                        current.embedder_unavailable = false;
                    }
                }
                let latest = cx.latest(scope).await?;
                if latest.scope != *scope {
                    cancel_bg(bg).await;
                    let layout_clear = layout.clone();
                    tokio::task::spawn_blocking(move || layout_clear.clear_lexical_manifests())
                        .await
                        .map_err(|_| IndexError::Inconsistent)??;
                    return Ok(Some(latest.scope));
                }
                let needs_advance = disk.as_ref().is_none_or(|d| {
                    d.lexical_idle_retired
                        || !cx.handle.is_published()
                        || d.manifest.tantivy_seq < latest.after
                });
                if needs_advance {
                    match advance_to(
                        cx,
                        publisher,
                        layout,
                        scope,
                        &mut disk,
                        bg,
                        latest,
                        false,
                        false,
                        &mut model_check_due,
                        embedder_retry_at,
                        schedule.embedder_idle,
                        &mut repair_at,
                        &mut repair_delay,
                        &mut ack_after_embed,
                    )
                    .await?
                    {
                        AdvanceOutcome::Resync(next_scope) => return Ok(Some(next_scope)),
                        AdvanceOutcome::Done { scrubbed } => {
                            needs_ack = true;
                            if scrubbed
                                && let Some(current) = &disk
                                && current.epoch.is_none()
                            {
                                let force_rebind = std::mem::take(&mut pending_rebind);
                                sync_subscription(
                                    cx,
                                    &mut subscription,
                                    &mut delivered,
                                    current.cursor(),
                                    force_rebind,
                                )
                                .await?;
                                needs_ack = false;
                            }
                        }
                    }
                }
                // Allow immediate model check on wake ONLY when replacement backoff is inactive.
                if !retry_model || Instant::now() >= model_retry_at {
                    model_check_due = true;
                }
            }
            LoopEvent::Tick => {
                let now = Instant::now();
                if let Some(current) = &mut disk {
                    // Healthy repair pauses briefly between pages. Its reader and
                    // embedder must stay usable until the next page can start.
                    let active_repair = !current.lexical_idle_retired
                        && current.needs_embedding_work()
                        && repair_delay < Duration::from_secs(30)
                        && (current.repairs.retry_delay < Duration::from_secs(30)
                            || !current.repairs.ready.is_empty()
                            || current.sweep != FullSweep::Idle);
                    if cx.handle.active_queries.load(Ordering::Acquire) > 0
                        || cx.handle.has_align_waiters()
                        || active_repair
                    {
                        current.last_activity = now;
                        current.embedder_last_use = now;
                    } else if bg.is_none() {
                        let mut active_now = false;
                        if !current.lexical_idle_retired
                            && now.saturating_duration_since(current.last_activity)
                                >= schedule.lexical_idle
                        {
                            if publisher.retire_if_idle() {
                                current.lexical_idle_retired = true;
                            } else {
                                current.last_activity = now;
                                current.embedder_last_use = now;
                                active_now = true;
                            }
                        }
                        if !active_now {
                            if current.release_idle_embedder(now, schedule.embedder_idle)
                                && !current.lexical_idle_retired
                            {
                                publisher.publish_if_live(current, false);
                            }
                            if cx.handle.idle_elapsed() >= schedule.worker_idle
                                && try_evict_idle_worker(
                                    workers,
                                    &scope.space_id,
                                    cx.handle,
                                    schedule.worker_idle,
                                )
                            {
                                drop(disk.take());
                                return Ok(None);
                            }
                        }
                    }
                    if now >= admission_check_at {
                        admission_check_at = now + REMOTE_ADMISSION_CHECK;
                        if now >= model_retry_at && current.manifest.remote_admission.is_some() {
                            model_check_due = true;
                        }
                    }
                    if now >= model_retry_at
                        && (retry_model
                            || (current.manifest.embeddings_pending
                                && current.manifest.vector_seq.is_none()))
                    {
                        model_check_due = true;
                    }
                }
            }
        }

        if let Some(current) = &mut disk
            && !current.lexical_idle_retired
            && bg.is_none()
        {
            let spawned = spawn_bg_if_ready(
                cx,
                current,
                bg,
                &mut model_check_due,
                model_retry_at,
                embedder_retry_at,
                repair_at,
                schedule.embedder_idle,
                ack_after_embed,
            )?;
            reconcile_reopening(publisher, current, bg, spawned);
        }
        if ack_after_embed
            && !bg
                .as_ref()
                .is_some_and(|task| task.kind == BgKind::EmbedBatch)
        {
            ack_after_embed = false;
        }
        let defer_ack = bg
            .as_ref()
            .is_some_and(|task| task.kind == BgKind::ModelRefresh)
            || ack_after_embed;
        if needs_ack
            && !defer_ack
            && let Some(current) = &disk
        {
            let force_rebind = std::mem::take(&mut pending_rebind);
            sync_subscription(
                cx,
                &mut subscription,
                &mut delivered,
                current.cursor(),
                force_rebind,
            )
            .await?;
            needs_ack = false;
        }
    }
}

async fn next_event(
    cx: &Context<'_>,
    subscription: &mut Box<dyn ChangeSubscription>,
    delivered: &mut SpaceSeq,
    bg: &mut Option<BgTask>,
    disk: &Option<Disk>,
    ticker: &mut tokio::time::Interval,
    timer_sleep: Option<tokio::time::Sleep>,
) -> Result<LoopEvent, IndexError> {
    let has_bg = bg.is_some();
    let has_timer = timer_sleep.is_some();
    let timer = async {
        if let Some(sleep) = timer_sleep {
            sleep.await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    let bg_fut = async {
        if let Some(task) = bg.as_mut() {
            (&mut task.handle).await
        } else {
            std::future::pending().await
        }
    };
    tokio::select! {
        biased;
        () = cx.handle.stop.cancelled() => Ok(LoopEvent::Stop),
        joined = bg_fut, if has_bg => Ok(LoopEvent::BgDone(Box::new(joined))),
        notice = subscription.next() => {
            let notice = notice?.ok_or(IndexError::Inconsistent)?;
            Ok(match notice {
                ChangeNotice::Resync { scope } => LoopEvent::Resync(scope),
                ChangeNotice::SeedRequired { cutoff } => {
                    *delivered = (*delivered).max(cutoff.after);
                    if cutoff.after == SpaceSeq::ZERO
                        && disk.as_ref().is_some_and(|current| current.cursor() == cutoff)
                    {
                        LoopEvent::Advance {
                            target: cutoff,
                            force_seed: false,
                            scrub: false,
                            rebind: false,
                            purge_resync: false,
                        }
                    } else {
                        LoopEvent::Advance {
                            target: cutoff,
                            force_seed: true,
                            scrub: true,
                            rebind: false,
                            purge_resync: false,
                        }
                    }
                }
                ChangeNotice::PurgeResync { cutoff } => {
                    *delivered = (*delivered).max(cutoff.after);
                    LoopEvent::Advance {
                        target: cutoff,
                        force_seed: true,
                        scrub: true,
                        rebind: false,
                        purge_resync: true,
                    }
                }
                ChangeNotice::Advanced(target) => {
                    *delivered = (*delivered).max(target.after);
                    LoopEvent::Advance {
                        target,
                        force_seed: false,
                        scrub: false,
                        rebind: false,
                        purge_resync: false,
                    }
                }
                ChangeNotice::Lagged { resume } => LoopEvent::Lagged { resume },
            })
        }
        () = cx.handle.wake.notified() => Ok(LoopEvent::Wake),
        () = timer, if has_timer => Ok(LoopEvent::Tick),
        _ = ticker.tick() => Ok(LoopEvent::Tick),
    }
}

async fn sync_subscription(
    cx: &Context<'_>,
    subscription: &mut Box<dyn ChangeSubscription>,
    delivered: &mut SpaceSeq,
    committed: ChangeCursor,
    force_rebind: bool,
) -> Result<(), IndexError> {
    if force_rebind || committed.after > *delivered {
        *subscription = cx
            .services
            .deps
            .changes
            .subscribe(cx.maintenance(), committed.clone())
            .await?;
        *delivered = subscription.processed().after.max(committed.after);
    } else if committed.after >= subscription.processed().after {
        subscription.acknowledge(committed).await?;
    }
    Ok(())
}

fn reconcile_reopening(
    publisher: &mut Publisher<'_>,
    current: &Disk,
    bg: &Option<BgTask>,
    spawned: bool,
) {
    if spawned && bg.as_ref().is_some_and(BgTask::is_reopening) {
        publisher.publish_if_live(current, true);
    } else if publisher.handle.is_reopening_vectors() {
        publisher.publish_if_live(current, false);
    }
}

#[allow(clippy::too_many_arguments)]
fn next_maintenance_wake(
    disk: Option<&Disk>,
    bg_active: bool,
    vectors_enabled: bool,
    retry_model: bool,
    model_retry_at: Instant,
    embedder_retry_at: Instant,
    repair_at: Instant,
) -> Option<Instant> {
    if bg_active || !vectors_enabled {
        return None;
    }
    let disk = disk.filter(|d| !d.lexical_idle_retired)?;
    let repair_at = disk.repairs.next_at(&disk.sweep, repair_at);
    let repair_wake_at = (disk.epoch.is_some() && disk.has_pending_embeddings())
        .then(|| {
            if disk.embedder.is_some() {
                Some(repair_at)
            } else if disk.manifest.active_model.is_some() {
                Some(repair_at.max(embedder_retry_at))
            } else {
                None
            }
        })
        .flatten();
    let model_wake_at = (retry_model
        || (disk.manifest.embeddings_pending && disk.manifest.vector_seq.is_none()))
    .then_some(model_retry_at);
    let reopen_at =
        (disk.epoch.is_none() && disk.manifest.vector_seq.is_some()).then_some(embedder_retry_at);
    [repair_wake_at, model_wake_at, reopen_at]
        .into_iter()
        .flatten()
        .min()
}

fn next_vector_open(
    disk: &Disk,
    now: Instant,
    embedder_retry_at: Instant,
    repair_at: Instant,
    embedder_idle: Duration,
) -> Option<BgKind> {
    let repair_at = disk.repairs.next_at(&disk.sweep, repair_at);
    if disk.lexical_idle_retired || now < embedder_retry_at {
        return None;
    }
    if disk.epoch.is_none() {
        return disk.manifest.vector_seq.map(|_| BgKind::ReopenVectors);
    }
    (disk.embedder.is_none()
        && disk.manifest.active_model.is_some()
        && ((disk.has_pending_embeddings() && now >= repair_at)
            || now.saturating_duration_since(disk.embedder_last_use) < embedder_idle))
        .then_some(BgKind::LoadEmbedder)
}

#[allow(clippy::too_many_arguments)]
async fn advance_to(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: &Arc<SearchLayout>,
    scope: &HistoryScope,
    disk: &mut Option<Disk>,
    bg: &mut Option<BgTask>,
    target: ChangeCursor,
    force_seed: bool,
    mut scrub: bool,
    model_check_due: &mut bool,
    embedder_retry_at: Instant,
    embedder_idle: Duration,
    repair_at: &mut Instant,
    repair_delay: &mut Duration,
    ack_after_embed: &mut bool,
) -> Result<AdvanceOutcome, IndexError> {
    let had_disk = disk.is_some();
    let mut scrubbed = false;
    let mut seed_at = (force_seed || disk.is_none()).then(|| target.clone());
    cx.handle.touch();
    if let Some(current) = disk.as_mut() {
        current.last_activity = Instant::now();
    }

    if !force_seed
        && let Some(current) = disk.as_ref()
        && !cx.handle.is_published()
        && current.manifest.tantivy_seq < target.after
        && cx.cut_needs_scrub(&current.cursor(), true).await?
    {
        cancel_bg(bg).await;
        drop(disk.take());
        build::scrub(cx, publisher, layout).await?;
        scrubbed = true;
        seed_at = Some(target.clone());
        scrub = false;
    }

    if !force_seed && let Some(current) = disk.as_mut() {
        let mut worker_pin = Some(cx.handle.pin_worker());
        let resumed = match current.resume_reader(cx).await {
            Ok(reader) => Some(reader),
            Err(IndexError::Lexical(LexicalError::ReaderUnavailable))
                if current.manifest.tantivy_seq < target.after
                    && cx.cut_needs_scrub(&current.cursor(), true).await? =>
            {
                worker_pin.take();
                cancel_bg(bg).await;
                drop(disk.take());
                build::scrub(cx, publisher, layout).await?;
                scrubbed = true;
                seed_at = Some(target.clone());
                scrub = false;
                None
            }
            Err(error) => return Err(error),
        };
        if let Some((lexical, reopened)) = resumed
            && let Some(current) = disk.as_mut()
        {
            let reopening = bg.as_ref().map_or_else(
                || {
                    next_vector_open(
                        current,
                        Instant::now(),
                        embedder_retry_at,
                        *repair_at,
                        embedder_idle,
                    )
                    .is_some()
                },
                BgTask::is_reopening,
            );
            if reopened {
                publisher.publish_with(current, &lexical, reopening);
            }
            let dirty = bg.as_mut().map(|task| &mut task.dirty);
            let catch_up_result = if current.manifest.tantivy_seq < target.after {
                catch_up(
                    cx,
                    current,
                    &lexical,
                    publisher,
                    target.clone(),
                    dirty,
                    reopening,
                )
                .await
            } else {
                Ok(false)
            };
            drop(lexical);
            worker_pin.take();
            match catch_up_result {
                Ok(false) => {}
                Ok(true) => {
                    seed_at = Some(target.clone());
                    scrub = true;
                }
                Err(IndexError::Lexical(LexicalError::IncompleteCleanup)) => {
                    seed_at = Some(target.clone());
                    scrub = true;
                }
                Err(error) if error.requires_reseed() => {
                    let retired = error.requires_scrub();
                    if retired {
                        cancel_bg(bg).await;
                        drop(disk.take());
                        build::scrub(cx, publisher, layout).await?;
                        scrubbed = true;
                    }
                    let latest = cx.latest(scope).await?;
                    if latest.scope != *scope {
                        cancel_bg(bg).await;
                        let layout_clear = layout.clone();
                        tokio::task::spawn_blocking(move || layout_clear.clear_lexical_manifests())
                            .await
                            .map_err(|_| IndexError::Inconsistent)??;
                        return Ok(AdvanceOutcome::Resync(latest.scope));
                    }
                    seed_at = Some(latest);
                    scrub = !retired;
                }
                Err(error) => return Err(error),
            }
        }
    }

    if let Some(cutoff) = seed_at {
        cancel_bg(bg).await;
        *ack_after_embed = false;
        if scrub {
            drop(disk.take());
            build::scrub(cx, publisher, layout).await?;
            if had_disk {
                scrubbed = true;
            }
        }
        let (seeded, lexical) = build::seed_lexical(cx, layout.clone(), &cutoff).await?;
        seeded.publish_manifest().await?;
        *disk = Some(seeded);
        build::publish_seed(
            cx,
            publisher,
            disk.as_ref().expect("lexical seed"),
            Some(&lexical),
        )
        .await?;
        drop(lexical);
        *model_check_due = true;
        *repair_at = Instant::now();
        *repair_delay = Duration::from_secs(1);
    }

    Ok(AdvanceOutcome::Done { scrubbed })
}

#[allow(clippy::too_many_arguments)]
fn spawn_bg_if_ready(
    cx: &Context<'_>,
    disk: &mut Disk,
    bg: &mut Option<BgTask>,
    model_check_due: &mut bool,
    model_retry_at: Instant,
    embedder_retry_at: Instant,
    repair_at: Instant,
    embedder_idle: Duration,
    prioritize_embed: bool,
) -> Result<bool, IndexError> {
    if bg.is_some() || disk.lexical_idle_retired {
        return Ok(false);
    }
    let now = Instant::now();
    let next_open = next_vector_open(disk, now, embedder_retry_at, repair_at, embedder_idle);
    // 1. Reopen checkpointed VectorEpoch off-thread (never blocked by replacement backoff).
    if next_open == Some(BgKind::ReopenVectors) {
        let cancel = Cancellation::default();
        let layout = disk.layout.clone();
        let manifest = disk.manifest.clone();
        let services = cx.services.clone();
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            BgOutcome::ReopenVectors(
                recover_vector_epoch(&services, &task_cancel, layout, manifest).await,
            )
        });
        *bg = Some(BgTask {
            kind: BgKind::ReopenVectors,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    // 2. Load active embedder only when embeddings are due or a recent query/wake
    // requested it, avoiding an unload/reload loop on EMBEDDER_IDLE.
    if next_open == Some(BgKind::LoadEmbedder)
        && let Some(active) = disk.manifest.active_model.clone()
    {
        let cancel = Cancellation::default();
        let task_cancel = cancel.clone();
        let services = Arc::clone(cx.services);
        let handle = tokio::spawn(async move {
            let embedder = tokio::select! {
                biased;
                () = task_cancel.cancelled() => None,
                result = services.embedder(active) => result.ok().map(Arc::new),
            };
            BgOutcome::LoadEmbedder(embedder)
        });
        *bg = Some(BgTask {
            kind: BgKind::LoadEmbedder,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    // 3. Check for model switch or initial backfill when due and outside backoff.
    if !prioritize_embed
        && *model_check_due
        && now >= model_retry_at
        && !matches!(cx.services.config.vector_mode, VectorMode::Disabled)
    {
        *model_check_due = false;
        let cancel = Cancellation::default();
        let input = build::ModelRefreshInput {
            services: Arc::clone(cx.services),
            layout: disk.layout.clone(),
            base: disk.cursor(),
            folders: disk.folders.clone(),
            active: disk.manifest.active_model.clone(),
            remote_admission: disk.manifest.remote_admission,
            have_epoch: disk.manifest.vector_seq.is_some(),
            pending: disk.manifest.embeddings_pending,
            cancel: cancel.clone(),
        };
        let handle = tokio::spawn(async move {
            BgOutcome::ModelRefresh(build::prepare_model_refresh(input).await)
        });
        *bg = Some(BgTask {
            kind: BgKind::ModelRefresh,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    // 4. Flush L0 before compaction / further backfill when threshold reached.
    if !prioritize_embed
        && let Some(epoch) = disk.epoch.as_mut()
        && epoch.should_flush(now)
        && let Some(plan) = epoch.plan_flush_l0()?
    {
        let cancel = Cancellation::default();
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                let replacement = plan.execute(&task_cancel)?;
                Ok((plan, replacement))
            })
            .await
            .map_err(|_| VectorError::CorruptIndex)
            .and_then(|inner| inner);
            BgOutcome::FlushL0(result)
        });
        *bg = Some(BgTask {
            kind: BgKind::FlushL0,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    // 5. Run one bounded compaction step off-owner while live updates continue.
    if !prioritize_embed
        && let Some(epoch) = disk.epoch.as_mut()
        && epoch.should_compact()
        && let Some(plan) = epoch.plan_compact()
    {
        let cancel = Cancellation::default();
        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                let replacement = plan.execute(&task_cancel)?;
                Ok((plan, replacement))
            })
            .await
            .map_err(|_| VectorError::CorruptIndex)
            .and_then(|inner| inner);
            BgOutcome::CompactStep(result)
        });
        *bg = Some(BgTask {
            kind: BgKind::CompactStep,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    // 6. Targeted dirty-note embedding batch or bounded full-sweep repair page.
    if disk.needs_embedding_work() && now >= disk.repairs.next_at(&disk.sweep, repair_at) {
        let Some(embedder) = disk.embedder.clone() else {
            return Ok(false);
        };
        let Some(epoch) = disk.epoch.as_ref() else {
            return Ok(false);
        };
        disk.embedder_last_use = now;
        let cancel = Cancellation::default();
        let Some(mode) = disk.repairs.next_batch(&disk.sweep, now) else {
            return Ok(false);
        };
        let input = update::EmbedBatchInput {
            layout: disk.layout.clone(),
            services: Arc::clone(cx.services),
            cutoff: disk.cursor(),
            folders: disk.folders.clone(),
            embedder,
            snapshot: epoch.snapshot(),
            cached_vectors: disk.cached_vectors.clone(),
            deferred: disk.repairs.retry.clone(),
            mode,
            cancel: cancel.clone(),
        };
        let handle =
            tokio::spawn(
                async move { BgOutcome::EmbedBatch(update::run_embed_batch(input).await) },
            );
        *bg = Some(BgTask {
            kind: BgKind::EmbedBatch,
            cancel,
            dirty: BgDirty::default(),
            handle,
        });
        return Ok(true);
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
async fn handle_bg_done(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    disk: &mut Option<Disk>,
    layout: &Arc<SearchLayout>,
    outcome: BgOutcome,
    mut dirty: BgDirty,
    model_check_due: &mut bool,
    retry_model: &mut bool,
    model_retry_at: &mut Instant,
    model_retry_delay: &mut Duration,
    embedder_retry_at: &mut Instant,
    repair_at: &mut Instant,
    repair_delay: &mut Duration,
) -> Result<bool, IndexError> {
    let Some(current) = disk.as_mut() else {
        return Ok(false);
    };
    match outcome {
        BgOutcome::ReopenVectors(result) => {
            match result {
                Ok((mut epoch, replayed)) => {
                    if !dirty.notes.is_empty() || current.manifest.vector_replay_after.is_some() {
                        let seq = current.manifest.tantivy_seq;
                        let ops: Vec<MutableOperation> = dirty
                            .notes
                            .iter()
                            .cloned()
                            .map(MutableOperation::Delete)
                            .collect();
                        epoch = tokio::task::spawn_blocking(move || {
                            epoch.apply_batch(seq, ops)?;
                            epoch.checkpoint(seq)?;
                            Ok::<_, VectorError>(epoch)
                        })
                        .await
                        .map_err(|_| IndexError::Inconsistent)??;
                        for id in replayed.into_iter().chain(dirty.notes) {
                            current.repairs.edit(id);
                        }
                        current.manifest.vector_seq = Some(seq);
                        current.manifest.vector_replay_after = None;
                        current.manifest.embeddings_pending = true;
                        current.publish_manifest().await?;
                    }
                    current.epoch = Some(epoch);
                    current.embedder_last_use = Instant::now();
                    current.embedder_unavailable = false;
                }
                Err(error) if error.requires_reseed() => {
                    drop(disk.take());
                    build::scrub(cx, publisher, layout).await?;
                    return Err(error);
                }
                Err(error) if error.invalid_checkpoint() => {
                    tracing::warn!(kind = %error, "search vector checkpoint needs rebuilding");
                    current.manifest.vector_seq = None;
                    current.manifest.vector_replay_after = None;
                    current.manifest.embeddings_pending = true;
                    current.embedder = None;
                    current.embedder_unavailable = false;
                    current.publish_manifest().await?;
                    *model_check_due = true;
                }
                Err(error) => {
                    tracing::warn!(kind = %error, "search vector checkpoint could not be opened");
                    current.embedder_unavailable = current.manifest.vector_seq.is_some();
                    *embedder_retry_at = Instant::now() + Duration::from_secs(5);
                }
            }
            let will_load_embedder = current.epoch.is_some()
                && current.embedder.is_none()
                && current.manifest.active_model.is_some();
            publisher.publish_if_live(current, will_load_embedder);
        }
        BgOutcome::LoadEmbedder(embedder) => {
            current.embedder = embedder;
            if current.embedder.is_some() {
                current.embedder_last_use = Instant::now();
                current.embedder_unavailable = false;
            } else {
                current.embedder_unavailable = true;
                *embedder_retry_at = Instant::now() + Duration::from_secs(5);
            }
            publisher.publish_if_live(current, false);
        }
        BgOutcome::ModelRefresh(result) => match result {
            Ok(build::ModelRefreshOutcome::Unchanged) => {
                *retry_model = false;
                *model_retry_delay = Duration::from_secs(1);
            }
            Ok(build::ModelRefreshOutcome::AdmissionChanged(revision)) => {
                current.request_full_sweep();
                current.manifest.remote_admission = Some(revision);
                // Publish both together: reopening pending work restarts a full sweep.
                current.publish_manifest().await?;
                publisher.publish_if_live(current, false);
                *repair_at = Instant::now();
                *repair_delay = Duration::from_secs(1);
                *retry_model = false;
                *model_retry_delay = Duration::from_secs(1);
            }
            Ok(build::ModelRefreshOutcome::Cleared) => {
                let mut manifest = current.manifest.clone();
                manifest.active_model = None;
                manifest.remote_admission = None;
                manifest.vector_seq = None;
                manifest.vector_replay_after = None;
                manifest.embeddings_pending = false;
                current.manifest = manifest;
                current.epoch = None;
                current.embedder = None;
                current.embedder_unavailable = false;
                current.repairs = RepairTurns::default();
                current.cached_vectors.clear();
                current.sweep = FullSweep::Idle;
                current.publish_manifest().await?;
                build::publish_seed(cx, publisher, current, None).await?;
                *retry_model = false;
                *model_retry_delay = Duration::from_secs(1);
            }
            Ok(build::ModelRefreshOutcome::PendingModel(target)) => {
                let mut manifest = current.manifest.clone();
                manifest.active_model = Some(target);
                manifest.remote_admission = None;
                manifest.vector_seq = None;
                manifest.vector_replay_after = None;
                manifest.embeddings_pending = true;
                current.manifest = manifest;
                current.epoch = None;
                current.embedder = None;
                current.embedder_unavailable = false;
                current.publish_manifest().await?;
                publisher.publish_if_live(current, false);
                *retry_model = true;
                *model_retry_at = Instant::now() + *model_retry_delay;
                *model_retry_delay = (*model_retry_delay * 2).min(Duration::from_secs(300));
            }
            Ok(build::ModelRefreshOutcome::Built(built)) => {
                let build::BuiltModelEpoch {
                    target,
                    remote_admission,
                    embedder,
                    mut epoch,
                    failed_notes,
                    missing_folders,
                } = *built;
                if !missing_folders.is_empty() {
                    let folders = Arc::make_mut(&mut current.folders);
                    let before = folders.len();
                    for folder in missing_folders {
                        folders.insert(folder)?;
                    }
                    let layout_ref = current.layout.clone();
                    let snapshot_folders = current.folders.clone();
                    tokio::task::spawn_blocking(move || {
                        build::save_new_folders(&layout_ref, &snapshot_folders, before)
                    })
                    .await
                    .map_err(|_| IndexError::Inconsistent)??;
                }
                let seq = current.manifest.tantivy_seq;
                let had_bg_dirty_notes = !dirty.notes.is_empty();
                let remote_folder_dirty = !dirty.take_remote_folders(Some(&target)).is_empty();
                if had_bg_dirty_notes {
                    let ops: Vec<MutableOperation> = dirty
                        .notes
                        .iter()
                        .cloned()
                        .map(MutableOperation::Delete)
                        .collect();
                    epoch = tokio::task::spawn_blocking(move || {
                        epoch.apply_batch(seq, ops)?;
                        epoch.checkpoint(seq)?;
                        Ok::<_, VectorError>(epoch)
                    })
                    .await
                    .map_err(|_| IndexError::Inconsistent)??;
                } else if !epoch.is_checkpointed(seq) {
                    epoch = tokio::task::spawn_blocking(move || {
                        epoch.checkpoint(seq)?;
                        Ok::<_, VectorError>(epoch)
                    })
                    .await
                    .map_err(|_| IndexError::Inconsistent)??;
                }
                current.repairs = RepairTurns::default();
                current.cached_vectors.clear();
                current.repairs.ready.extend(dirty.notes);
                current.repairs.ready.extend(failed_notes);
                current.sweep = FullSweep::from_pending(remote_folder_dirty);
                let pending = current.has_pending_embeddings();
                let was_cold_seed = current.manifest.vector_seq.is_none();
                let mut manifest = current.manifest.clone();
                manifest.vector_seq = Some(seq);
                manifest.vector_replay_after = None;
                manifest.active_model = Some(target);
                manifest.remote_admission = remote_admission;
                manifest.embeddings_pending = pending;
                current.manifest = manifest;
                current.epoch = Some(epoch);
                current.embedder = Some(embedder);
                current.embedder_last_use = Instant::now();
                current.embedder_unavailable = false;
                current.publish_manifest().await?;
                build::publish_seed(cx, publisher, current, None).await?;
                *retry_model = false;
                *model_retry_delay = Duration::from_secs(1);
                *repair_delay = Duration::from_secs(1);
                if was_cold_seed && had_bg_dirty_notes && current.needs_embedding_work() {
                    *repair_at = Instant::now();
                    return Ok(true);
                }
                *repair_at = Instant::now() + Duration::from_secs(1);
                return Ok(false);
            }
            Err(ModelError::Index(error)) if error.requires_reseed() => {
                if error.requires_scrub() {
                    drop(disk.take());
                    build::scrub(cx, publisher, layout).await?;
                }
                return Err(error);
            }
            Err(ModelError::Index(error @ IndexError::Layout(_))) => return Err(error),
            Err(error) => {
                tracing::warn!(kind = %error, "search model refresh will retry");
                *retry_model = true;
                let delay = match error {
                    ModelError::Embedding(EmbeddingError::IndexingThrottled(delay)) => {
                        delay.max(*model_retry_delay)
                    }
                    _ => *model_retry_delay,
                };
                *model_retry_at = Instant::now() + delay;
                *model_retry_delay = (*model_retry_delay * 2).min(Duration::from_secs(300));
            }
        },
        BgOutcome::EmbedBatch(result) => match result {
            Ok(update::EmbedBatchOutcome::ModelChanged) => {
                current.embedder_last_use = Instant::now();
                *model_check_due = true;
                *repair_at = Instant::now() + *repair_delay;
                *repair_delay = (*repair_delay * 2).min(Duration::from_secs(300));
            }
            Ok(update::EmbedBatchOutcome::Backoff) => {
                current.embedder_last_use = Instant::now();
                *repair_at = Instant::now() + *repair_delay;
                *repair_delay = (*repair_delay * 2).min(Duration::from_secs(300));
            }
            Ok(update::EmbedBatchOutcome::Applied {
                rows,
                requeue,
                missing_folders,
                next_sweep_after,
                was_full_sweep,
                last_attempted,
                selected,
                retry_notes,
                provider_backoff,
            }) => {
                if !was_full_sweep {
                    current
                        .repairs
                        .finish_targeted(selected, &dirty.notes, last_attempted);
                }
                current.embedder_last_use = Instant::now();
                if !missing_folders.is_empty() {
                    let folders = Arc::make_mut(&mut current.folders);
                    let before = folders.len();
                    for folder in missing_folders {
                        folders.insert(folder)?;
                    }
                    let layout_ref = current.layout.clone();
                    let snapshot_folders = current.folders.clone();
                    tokio::task::spawn_blocking(move || {
                        build::save_new_folders(&layout_ref, &snapshot_folders, before)
                    })
                    .await
                    .map_err(|_| IndexError::Inconsistent)??;
                }
                let changed_folders =
                    dirty.take_remote_folders(current.manifest.active_model.as_ref());
                let seq = current.manifest.tantivy_seq;
                let mut epoch = current.epoch.take().ok_or(IndexError::Inconsistent)?;
                let mut ops = Vec::new();
                let mut staged_note = None;
                for row in rows {
                    let id = row.note_id;
                    if dirty.notes.contains(&id) {
                        continue;
                    }
                    if row
                        .ancestor_folders
                        .iter()
                        .any(|id| changed_folders.contains(id))
                    {
                        current.repairs.edit(id);
                        continue;
                    }
                    current.repairs.forget(&id);
                    match row.chunks {
                        update::EmbeddedChunks::Staged(staged) => staged_note = Some((id, staged)),
                        update::EmbeddedChunks::Inline(chunks)
                            if !epoch.matches_note_chunks(&id, &chunks) =>
                        {
                            if chunks.is_empty() {
                                ops.push(MutableOperation::Delete(id));
                            } else {
                                ops.push(MutableOperation::Upsert { note: id, chunks });
                            }
                        }
                        update::EmbeddedChunks::Inline(_) => {}
                    }
                }
                let vectors_changed = !ops.is_empty() || staged_note.is_some();
                let commit_result = if vectors_changed {
                    tokio::task::spawn_blocking(move || {
                        epoch.apply_batch(seq, ops)?;
                        if let Some((id, staged)) = staged_note {
                            epoch.replace_staged_note(seq, id, staged)?;
                        }
                        epoch.checkpoint(seq)?;
                        Ok::<_, VectorError>(epoch)
                    })
                    .await
                    .map_err(|_| IndexError::Inconsistent)?
                } else {
                    Ok(epoch)
                };
                match commit_result {
                    Ok(epoch) => current.epoch = Some(epoch),
                    Err(error) => return Err(IndexError::Vector(error)),
                }
                current.repairs.ready.extend(
                    requeue.into_iter().filter(|id| {
                        !dirty.notes.contains(id) && !current.repairs.retry.contains(id)
                    }),
                );
                let previous_pending = current.manifest.embeddings_pending;
                if was_full_sweep {
                    current.sweep.finish_page(next_sweep_after);
                }
                if !changed_folders.is_empty() {
                    current.request_full_sweep();
                }
                let now = Instant::now();
                current.repairs.defer(
                    retry_notes
                        .into_iter()
                        .filter(|id| !dirty.notes.contains(id)),
                    now,
                );
                if current.repairs.ready.is_empty() && current.repairs.retry.is_empty() {
                    current.cached_vectors.clear();
                    current.repairs.retry_delay = Duration::ZERO;
                }
                let pending = current.has_pending_embeddings();
                current.manifest.embeddings_pending = pending;
                if vectors_changed {
                    current.manifest.vector_seq = Some(seq);
                }
                if vectors_changed || previous_pending != pending {
                    current.publish_manifest().await?;
                    publisher.publish_if_live(current, false);
                }
                if let Some(minimum) = provider_backoff {
                    *repair_at = now + (*repair_delay).max(minimum);
                    *repair_delay = (*repair_delay * 2).min(Duration::from_secs(300));
                } else if pending {
                    *repair_at = now + Duration::from_millis(25);
                    *repair_delay = Duration::from_secs(1);
                } else {
                    current.repairs = RepairTurns::default();
                    *repair_delay = Duration::from_secs(1);
                    *repair_at = now;
                }
            }
            Err(error) if error.requires_scrub() => {
                drop(disk.take());
                build::scrub(cx, publisher, layout).await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        },
        BgOutcome::FlushL0(result) => match result {
            Ok((plan, replacement)) => {
                let mut epoch = current.epoch.take().ok_or(IndexError::Inconsistent)?;
                let dirty_notes = dirty.notes;
                let committed = tokio::task::spawn_blocking(move || {
                    epoch.commit_flush_l0(plan, replacement, &dirty_notes)?;
                    Ok::<_, VectorError>(epoch)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
                current.epoch = Some(committed);
                publisher.publish_if_live(current, false);
            }
            Err(VectorError::Cancelled) => {}
            Err(error) => return Err(IndexError::Vector(error)),
        },
        BgOutcome::CompactStep(result) => match result {
            Ok((plan, replacement)) => {
                let mut epoch = current.epoch.take().ok_or(IndexError::Inconsistent)?;
                let dirty_notes = dirty.notes;
                let committed = tokio::task::spawn_blocking(move || {
                    epoch.commit_compaction(plan, replacement, &dirty_notes)?;
                    Ok::<_, VectorError>(epoch)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
                current.epoch = Some(committed);
                publisher.publish_if_live(current, false);
                publisher.drain().await;
                let epoch = current.epoch.take().ok_or(IndexError::Inconsistent)?;
                let collected = tokio::task::spawn_blocking(move || {
                    epoch.collect_obsolete()?;
                    Ok::<_, VectorError>(epoch)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
                current.epoch = Some(collected);
            }
            Err(VectorError::Cancelled) => {}
            Err(error) => return Err(IndexError::Vector(error)),
        },
    }
    Ok(false)
}

/// Returns true when any event requires a physical replacement generation.
async fn catch_up(
    cx: &Context<'_>,
    disk: &mut Disk,
    lexical: &Arc<LexicalIndex>,
    publisher: &mut Publisher<'_>,
    target: ChangeCursor,
    mut dirty: Option<&mut BgDirty>,
    reopening: bool,
) -> Result<bool, IndexError> {
    while disk.manifest.tantivy_seq < target.after {
        let stop_at = cx
            .handle
            .next_align_target(disk.manifest.tantivy_seq, target.after)
            .unwrap_or(target.after);
        let step_target = ChangeCursor {
            scope: target.scope.clone(),
            after: stop_at,
        };
        if catch_up_to(
            cx,
            disk,
            lexical,
            publisher,
            step_target,
            dirty.as_deref_mut(),
            reopening,
        )
        .await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn catch_up_to(
    cx: &Context<'_>,
    disk: &mut Disk,
    lexical: &Arc<LexicalIndex>,
    publisher: &mut Publisher<'_>,
    target: ChangeCursor,
    mut dirty: Option<&mut BgDirty>,
    reopening: bool,
) -> Result<bool, IndexError> {
    let mut after = disk.cursor();
    let mut tail = Vec::new();
    loop {
        let request = ChangeRead::Log {
            after: after.clone(),
            through: target.after,
            limit: PageLimit::new(100)?,
        };
        let ChangeReadResult::Log(page) = cx
            .services
            .deps
            .changes
            .catch_up(cx.maintenance(), request)
            .await?
        else {
            return Err(IndexError::Inconsistent);
        };
        if page.cutoff != target.after
            || page.next.scope != target.scope
            || page.next.after <= after.after
            || page.safe_ack_end < disk.manifest.tantivy_seq
            || page.safe_ack_end > page.next.after
        {
            return Err(IndexError::Inconsistent);
        }
        if update::requires_scrub(lexical, &page.changes).await? {
            return Ok(true);
        }
        tail.extend(page.changes);
        let boundary =
            tail.partition_point(|change| change.command_range.last_seq <= page.safe_ack_end);
        if boundary != 0 {
            let pending = tail.split_off(boundary);
            let complete = std::mem::replace(&mut tail, pending);
            if update::requires_scrub(lexical, &complete).await? {
                return Ok(true);
            }
            if let Some(bg_dirty) = dirty.as_deref_mut() {
                use notarium_core::ports::{ChangeKind, EntityId};
                for change in &complete {
                    match &change.entity {
                        EntityId::Note(id) => {
                            bg_dirty.notes.insert(id.clone());
                        }
                        EntityId::Folder(id)
                            if matches!(
                                change.kind,
                                ChangeKind::Move | ChangeKind::Trash | ChangeKind::Restore
                            ) =>
                        {
                            bg_dirty.folders.insert(id.clone());
                        }
                        _ => {}
                    }
                }
            }
            let committed = disk.cursor();
            let updated = update::apply(
                cx,
                disk,
                lexical,
                publisher,
                ChangeCursor {
                    scope: target.scope.clone(),
                    after: page.safe_ack_end,
                },
                complete,
                reopening,
            )
            .await;
            if matches!(
                updated,
                Err(IndexError::Lexical(LexicalError::WriterUnavailable))
            ) && cx.cut_needs_scrub(&committed, true).await?
            {
                return Ok(true);
            }
            updated?;
        }
        after = page.next;
        if page.complete {
            if !tail.is_empty() || disk.manifest.tantivy_seq != target.after {
                return Err(IndexError::Inconsistent);
            }
            return Ok(false);
        }
    }
}

async fn open_disk(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: Arc<SearchLayout>,
    latest: SpaceSeq,
) -> Result<Option<(Disk, Arc<LexicalIndex>)>, IndexError> {
    let layout_read = layout.clone();
    let manifest_res = tokio::task::spawn_blocking(move || layout_read.search_manifest())
        .await
        .map_err(|_| IndexError::Inconsistent)?;
    let unapplied = manifest_res.as_ref().ok().and_then(|manifest| {
        let manifest = manifest.as_ref()?;
        let after = manifest
            .vector_replay_after
            .map_or(manifest.tantivy_seq, |replay| replay.after);
        (after < latest).then(|| ChangeCursor {
            scope: manifest.scope.clone(),
            after,
        })
    });
    let deferred = manifest_res
        .as_ref()
        .ok()
        .and_then(|value| value.as_ref())
        .is_some_and(|manifest| manifest.vector_replay_after.is_some());
    if let Some(cursor) = &unapplied
        && match cx.cut_needs_scrub(cursor, true).await {
            Err(error) if deferred => {
                let error = error.vector_replay_error();
                if !error.requires_reseed() {
                    return Err(error);
                }
                true
            }
            result => result?,
        }
    {
        build::scrub(cx, publisher, &layout).await?;
        return Ok(None);
    }

    let layout_open = layout.clone();
    let readers = cx.services.readers.clone();
    let writers = cx.services.writers.clone();
    let data_root = cx.services.config.data_root.clone();
    let owner = cx.reader_owner();
    let opened = tokio::task::spawn_blocking(
        move || -> Result<Option<(Disk, Arc<LexicalIndex>)>, IndexError> {
            let opened = (|| -> Result<Option<(Disk, Arc<LexicalIndex>)>, IndexError> {
                let Some(mut manifest) = manifest_res? else {
                    return Ok(None);
                };
                if manifest.tokenizer_version != TOKENIZER_VERSION || manifest.tantivy_seq > latest
                {
                    return Err(IndexError::Inconsistent);
                }
                let folders = Arc::new(
                    layout_open
                        .folder_dictionary()?
                        .ok_or(IndexError::Inconsistent)?,
                );
                let dir = layout_open.index_dir(&manifest)?;
                let lexical = readers.open_owned(&dir, owner)?;
                if lexical.commit_id()? != manifest.tantivy_commit {
                    return Err(IndexError::Inconsistent);
                }
                if manifest.active_model.is_some()
                    && manifest.vector_seq.is_none()
                    && !manifest.embeddings_pending
                {
                    manifest.embeddings_pending = true;
                    layout_open.publish_search(&manifest)?;
                }
                let full_sweep_needed = manifest.vector_seq.is_some()
                    && manifest.embeddings_pending
                    && manifest
                        .vector_replay_after
                        .is_none_or(|replay| replay.needs_sweep);
                let now = Instant::now();
                Ok(Some((
                    Disk {
                        layout: layout_open.clone(),
                        manifest,
                        folders,
                        lexical_path: dir,
                        lexical_idle_retired: false,
                        epoch: None,
                        embedder: None,
                        repairs: RepairTurns::default(),
                        cached_vectors: HashMap::new(),
                        sweep: FullSweep::from_pending(full_sweep_needed),
                        last_activity: now,
                        embedder_last_use: now,
                        embedder_unavailable: false,
                    },
                    lexical,
                )))
            })();
            let disk = match opened {
                Ok(disk) => disk,
                Err(IndexError::Layout(LayoutError::WrongHistory)) => {
                    layout_open.clear_lexical_manifests()?;
                    None
                }
                Err(error) if error.invalid_checkpoint() => None,
                Err(error) => return Err(error),
            };
            if disk.is_none()
                && let Err(error) = layout_open.folder_dictionary()
            {
                let error = IndexError::Layout(error);
                if !error.invalid_checkpoint() {
                    return Err(error);
                }
                layout_open.clear_lexical_manifests()?;
            }
            let preserve = disk
                .as_ref()
                .map(|(disk, _)| disk.manifest.generation())
                .transpose()?;
            for generation in layout_open.index_generations()? {
                if Some(generation) != preserve {
                    build::remove_generation_parts(
                        &data_root,
                        &writers,
                        &readers,
                        &layout_open,
                        generation,
                    )?;
                }
            }
            let vector_model = disk
                .as_ref()
                .and_then(|(disk, _)| {
                    disk.manifest
                        .vector_seq
                        .and(disk.manifest.active_model.as_ref())
                })
                .map(ResolvedEmbeddingTarget::vector_model);
            layout_open.remove_vector_epochs(vector_model.as_ref())?;
            Ok(disk)
        },
    )
    .await
    .map_err(|_| IndexError::Inconsistent)?;

    match opened {
        Ok(disk) => Ok(disk),
        Err(error @ IndexError::Lexical(LexicalError::ReaderUnavailable)) => {
            if let Some(cursor) = unapplied
                && cx.cut_needs_scrub(&cursor, true).await?
            {
                build::scrub(cx, publisher, &layout).await?;
                return Ok(None);
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

fn open_vector_epoch(
    layout: Arc<SearchLayout>,
    manifest: &SearchManifest,
) -> Result<VectorEpoch, IndexError> {
    let (Some(model), Some(seq)) = (&manifest.active_model, manifest.vector_seq) else {
        return Err(IndexError::Inconsistent);
    };
    let model = model.vector_model();
    let epoch = layout
        .epoch_manifest(&model)?
        .ok_or(IndexError::Inconsistent)?;
    if seq > manifest.tantivy_seq || !epoch.complete_backfill {
        return Err(IndexError::Inconsistent);
    }
    let opened = VectorEpoch::open_model(layout, model)?;
    let valid = match manifest.vector_replay_after {
        None => opened.is_checkpointed(seq),
        Some(replay) => {
            seq <= replay.after
                && replay.after < manifest.tantivy_seq
                && opened.can_replay_checkpoint(seq, manifest.tantivy_seq)
        }
    };
    if !valid {
        return Err(IndexError::Inconsistent);
    }
    opened.collect_obsolete()?;
    Ok(opened)
}

/// A deferred mask is durable in the search manifest until the epoch and all
/// intervening live edits have been checkpointed together by the worker.
async fn recover_vector_epoch(
    services: &Services,
    cancel: &Cancellation,
    layout: Arc<SearchLayout>,
    manifest: SearchManifest,
) -> Result<(VectorEpoch, BTreeSet<NoteId>), IndexError> {
    use notarium_core::{
        classes::DocClass,
        model::Lifecycle,
        ports::{ChangeKind, EntityId},
    };
    let replay = manifest.vector_replay_after;
    let through = manifest.tantivy_seq;
    let scope = manifest.scope.clone();
    let mut epoch = tokio::task::spawn_blocking(move || open_vector_epoch(layout, &manifest))
        .await
        .map_err(|_| IndexError::Inconsistent)??;
    let mut dirty = BTreeSet::new();
    let Some(replay) = replay else {
        return Ok((epoch, dirty));
    };
    let mut after = ChangeCursor {
        scope,
        after: replay.after,
    };
    let resync = || DomainError::validation(ValidationReason::PurgeResync);
    while after.after < through {
        let request = ChangeRead::Log {
            after: after.clone(),
            through,
            limit: PageLimit::new(100)?,
        };
        let context = MaintenanceContext {
            authority: services.authority.clone(),
            budget: new_budget(cancel),
        };
        let ChangeReadResult::Log(page) = services.deps.changes.catch_up(context, request).await?
        else {
            return Err(resync().into());
        };
        if page.cutoff != through
            || page.next.scope != after.scope
            || page.next.after <= after.after
            || page.next.after > through
            || page.complete != (page.next.after == through)
            || (page.complete && page.safe_ack_end != through)
        {
            return Err(resync().into());
        }
        let mut ops = Vec::new();
        for change in page.changes {
            if change.cursor.scope != after.scope
                || after.after.get().checked_add(1) != Some(change.cursor.after.get())
                || matches!(change.kind, ChangeKind::Purge | ChangeKind::Redact)
                || change.lifecycle == Lifecycle::Purged
                || change.class == Some(DocClass::EncryptedNote)
            {
                return Err(resync().into());
            }
            after = change.cursor;
            if let EntityId::Note(note) = change.entity {
                ops.push(MutableOperation::Delete(note.clone()));
                dirty.insert(note);
            }
        }
        if after != page.next {
            return Err(resync().into());
        }
        if !ops.is_empty() {
            // Replaying at the same target is idempotent even after a prior WAL
            // write or L0 flush reached the target before its search manifest.
            epoch = tokio::task::spawn_blocking(move || {
                epoch.apply_batch(through, ops)?;
                Ok::<_, VectorError>(epoch)
            })
            .await
            .map_err(|_| IndexError::Inconsistent)??;
        }
    }
    Ok((epoch, dirty))
}

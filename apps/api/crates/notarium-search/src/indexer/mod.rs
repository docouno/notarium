mod build;
#[cfg(test)]
mod tests;
mod update;

use crate::{
    engine::{Published, Services, SpaceHandle, maintenance_budget},
    layout::{FolderDictionary, LayoutError, SearchLayout, SearchManifest},
    lexical::{LexicalError, LexicalIndex, TOKENIZER_VERSION},
    vector::{VectorEpoch, VectorError},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, RequestId, SpaceSeq},
    model::HistoryScope,
    ports::{
        CallBudget, ChangeNotice, ChangeRead, ChangeReadResult, MaintenanceContext, PageLimit,
    },
    receipt::ChangeCursor,
};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::{MissedTickBehavior, interval, sleep};

const MAINTENANCE_TICK: Duration = Duration::from_secs(1);
const VECTOR_IDLE: Duration = Duration::from_secs(60);

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
    #[error("embedding model unavailable")]
    Embedding(#[from] crate::embed::EmbeddingError),
    #[error("the staged cut requires retirement")]
    Retire,
    #[error("index checkpoints disagree")]
    Inconsistent,
}

impl IndexError {
    fn requires_reseed(&self) -> bool {
        match self {
            Self::Retire => true,
            Self::Port(PortError::Domain(error)) | Self::Domain(error) => error.requires_resync(),
            _ => false,
        }
    }

    fn requires_scrub(&self) -> bool {
        matches!(self, Self::Retire)
            || matches!(self, Self::Port(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            | Self::Domain(DomainError::ValidationFailed { diagnostic })
            if matches!(diagnostic.reason, ValidationReason::CursorStale | ValidationReason::PurgeResync))
    }
}

struct Context<'a> {
    services: &'a Services,
    handle: &'a SpaceHandle,
}

impl Context<'_> {
    /// Let a slow embedding pass yield to newer canonical work. The second
    /// subscription is only opened when the computation actually stalls.
    async fn while_current<T>(
        &self,
        cutoff: &ChangeCursor,
        work: impl Future<Output = T>,
    ) -> Result<Option<T>, IndexError> {
        let advanced = async {
            sleep(Duration::from_millis(50)).await;
            let mut changes = self
                .services
                .deps
                .changes
                .subscribe(self.maintenance(), cutoff.clone())
                .await?;
            loop {
                match changes.next().await? {
                    Some(ChangeNotice::SeedRequired { cutoff: initial }) if initial == *cutoff => {}
                    _ => return Ok(None),
                }
            }
        };
        tokio::select! {
            biased;
            () = self.handle.stop.cancelled() => Ok(None),
            result = work => Ok(Some(result)),
            changed = advanced => changed,
        }
    }

    fn budget(&self) -> CallBudget {
        static REQUEST: AtomicU64 = AtomicU64::new(0);
        let mut id = [0; 16];
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        id[..8].copy_from_slice(&(now as u64).to_le_bytes());
        id[8..].copy_from_slice(&REQUEST.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        maintenance_budget(&self.handle.stop, RequestId::from_bytes(id))
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
}

struct Disk {
    layout: Arc<SearchLayout>,
    manifest: SearchManifest,
    folders: Arc<FolderDictionary>,
    lexical: Option<Arc<LexicalIndex>>,
    epoch: Option<VectorEpoch>,
    embedder: Option<Arc<crate::model::Embedder>>,
    embedding_failures: u64,
    vector_last_use: Instant,
}

impl Disk {
    fn cursor(&self) -> ChangeCursor {
        ChangeCursor {
            scope: self.manifest.scope.clone(),
            after: self.manifest.tantivy_seq,
        }
    }

    fn needs_embedding_repair(&self) -> bool {
        self.manifest.vector_seq.is_some() && self.manifest.embeddings_pending
    }

    fn resume_reader(&mut self, cx: &Context<'_>) -> Result<bool, IndexError> {
        if self.lexical.is_some() {
            return Ok(false);
        }
        let reader = cx
            .services
            .readers
            .open(&self.layout.index_dir(&self.manifest)?)?;
        if reader.commit_id()? != self.manifest.tantivy_commit {
            return Err(IndexError::Inconsistent);
        }
        self.lexical = Some(reader);
        Ok(true)
    }

    async fn ensure_embedder(&mut self, cx: &Context<'_>) -> bool {
        if self.epoch.is_some()
            && self.embedder.is_none()
            && let Some(active) = self.manifest.active_model.clone()
        {
            self.embedder = cx.services.embedder(active).await.ok().map(Arc::new);
            return self.embedder.is_some();
        }
        false
    }

    fn start_epoch_reopen(&self) -> tokio::task::JoinHandle<Result<VectorEpoch, IndexError>> {
        let layout = self.layout.clone();
        let manifest = self.manifest.clone();
        tokio::task::spawn_blocking(move || open_vector_epoch(layout, &manifest))
    }

    async fn resume_vectors(
        &mut self,
        cx: &Context<'_>,
        publisher: &mut Publisher<'_>,
    ) -> Result<bool, IndexError> {
        self.vector_last_use = Instant::now();
        let result = self.reopen_vectors(cx, publisher).await;
        if result.as_ref().is_err_and(IndexError::requires_scrub) {
            self.lexical.take();
            self.epoch.take();
            self.embedder.take();
            build::scrub(cx, publisher, &self.layout).await?;
        }
        result
    }

    async fn reopen_vectors(
        &mut self,
        cx: &Context<'_>,
        publisher: &mut Publisher<'_>,
    ) -> Result<bool, IndexError> {
        let mut changed = false;
        if self.epoch.is_none() && self.manifest.vector_seq.is_some() {
            let mut loader = self.start_epoch_reopen();
            let mut dirty = ChangedNotes::default();
            let result = during_model_work(cx, self, publisher, &mut dirty, async {
                Ok((&mut loader).await)
            })
            .await;
            let opened = match result {
                Ok(joined) => joined.map_err(|_| IndexError::Inconsistent)?,
                Err(error) => {
                    if error.requires_scrub() {
                        publisher.replace(None);
                    }
                    // Validation can reclaim obsolete files. Finish its disk
                    // access before the owner retires or reopens the epoch.
                    let _ = loader.await;
                    return Err(error);
                }
            };
            match opened {
                Ok(mut epoch) => {
                    if !dirty.notes.is_empty() {
                        let seq = self.manifest.tantivy_seq;
                        for id in dirty.notes {
                            epoch.apply(seq, crate::vector::MutableOperation::Delete(id))?;
                        }
                        epoch.checkpoint(seq)?;
                        self.manifest.vector_seq = Some(seq);
                        self.manifest.embeddings_pending = true;
                        self.layout.publish_search(&self.manifest)?;
                    }
                    self.epoch = Some(epoch);
                }
                Err(error) => {
                    tracing::warn!(kind = %error, "search vector checkpoint needs rebuilding");
                    self.manifest.vector_seq = None;
                    self.manifest.embeddings_pending = true;
                    self.layout.publish_search(&self.manifest)?;
                    self.embedder = None;
                }
            }
            changed = true;
        }
        if self.epoch.is_some()
            && self.embedder.is_none()
            && let Some(active) = self.manifest.active_model.clone()
        {
            self.embedder =
                during_model_work(cx, self, publisher, &mut ChangedNotes::default(), async {
                    Ok(cx.services.embedder(active).await.ok().map(Arc::new))
                })
                .await?;
            changed |= self.embedder.is_some();
        }
        Ok(changed)
    }

    fn release_idle_vectors(&mut self, now: Instant, idle: Duration) {
        if now.saturating_duration_since(self.vector_last_use) >= idle {
            self.epoch.take();
            self.embedder.take();
        }
    }
}

struct Publisher<'a> {
    handle: &'a SpaceHandle,
    old: Vec<Weak<Published>>,
}

impl Publisher<'_> {
    fn replace(&mut self, next: Option<Arc<Published>>) {
        self.old.retain(|state| state.strong_count() != 0);
        if let Some(previous) = self.handle.replace(next) {
            self.old.push(Arc::downgrade(&previous));
        }
    }

    fn publish(&mut self, disk: &Disk) {
        let Some(lexical) = &disk.lexical else { return };
        self.replace(Some(Arc::new(Published {
            scope: disk.manifest.scope.clone(),
            seq: disk.manifest.tantivy_seq,
            lexical: lexical.clone(),
            searcher: lexical.searcher(),
            folders: disk.folders.clone(),
            vectors: disk.epoch.as_ref().map(|epoch| Arc::new(epoch.snapshot())),
            active_model: disk.manifest.active_model.clone(),
            embedder: disk.embedder.clone(),
            embeddings_pending: disk.manifest.embeddings_pending,
            reopening_vectors: disk.manifest.vector_seq.is_some() && disk.epoch.is_none(),
        })));
    }

    async fn drain(&mut self) {
        self.old.retain(|state| state.strong_count() != 0);
        while !self.old.is_empty() {
            sleep(Duration::from_millis(2)).await;
            self.old.retain(|state| state.strong_count() != 0);
        }
    }
}

pub(super) async fn run(
    services: Arc<Services>,
    handle: Arc<SpaceHandle>,
    mut scope: HistoryScope,
) {
    let cx = Context {
        services: &services,
        handle: &handle,
    };
    let mut publisher = Publisher {
        handle: &handle,
        old: Vec::new(),
    };
    loop {
        if handle.stop.is_cancelled() {
            break;
        }
        match consume(&cx, &mut publisher, scope.clone()).await {
            Ok(Some(next_scope)) => scope = next_scope,
            Ok(None) => break,
            Err(error) if error.requires_reseed() => {
                // A changed history or purged payload invalidates a pinned read.
                // A new subscription rechecks the durable catalogue and cutoff.
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
    starting_scope: HistoryScope,
) -> Result<Option<HistoryScope>, IndexError> {
    consume_with_schedule(cx, publisher, starting_scope, MAINTENANCE_TICK, VECTOR_IDLE).await
}

async fn consume_with_schedule(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    starting_scope: HistoryScope,
    tick_interval: Duration,
    vector_idle: Duration,
) -> Result<Option<HistoryScope>, IndexError> {
    let record = cx
        .services
        .deps
        .canonical
        .read_space(&starting_scope.space_id)
        .await?;
    let scope = record.scope;
    let layout = Arc::new(SearchLayout::open(
        &cx.services.config.data_root,
        scope.clone(),
    )?);
    if record.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active {
        // Archiving can race a purge or redaction. Retire every derived copy
        // before waiting for reactivation, without opening a reader or carrier.
        build::scrub(cx, publisher, &layout).await?;
        loop {
            tokio::select! {
                () = cx.handle.stop.cancelled() => return Ok(None),
                () = sleep(MAINTENANCE_TICK) => {}
            }
            let current = cx
                .services
                .deps
                .canonical
                .read_space(&scope.space_id)
                .await?;
            if current.scope != scope
                || current.space.lifecycle == notarium_core::auth::SpaceLifecycle::Active
            {
                return Ok(Some(current.scope));
            }
        }
    }
    let mut disk = open_disk(cx, publisher, layout.clone(), record.last_seq).await?;
    let start = disk
        .as_ref()
        .map(Disk::cursor)
        .unwrap_or_else(|| ChangeCursor {
            scope: scope.clone(),
            after: SpaceSeq::ZERO,
        });
    let changes = &cx.services.deps.changes;
    let mut subscription = changes.subscribe(cx.maintenance(), start).await?;
    if let Some(disk) = &mut disk {
        publisher.publish(disk);
        if disk.resume_vectors(cx, publisher).await? {
            publisher.publish(disk);
        }
    }
    let mut ticker = interval(tick_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut next_model_check = Instant::now();
    let mut retry_model = false;
    let mut model_retry_delay = Duration::from_secs(1);
    let mut repair = update::EmbeddingRepair::default();
    loop {
        let event = {
            let resume = subscription.processed().clone();
            let next = subscription.next();
            tokio::pin!(next);
            loop {
                break tokio::select! {
                    biased;
                    () = cx.handle.stop.cancelled() => return Ok(None),
                    notice = &mut next => notice?.ok_or(IndexError::Inconsistent)?,
                    () = cx.handle.wake.notified() => ChangeNotice::Lagged { resume },
                    _ = tokio::time::sleep_until(repair.next()), if disk.as_ref().is_some_and(Disk::needs_embedding_repair) => {
                        if let Some(current) = &mut disk {
                            if current.resume_vectors(cx, publisher).await? {
                                publisher.publish(current);
                            }
                            let cutoff = current.cursor();
                            cx.while_current(&cutoff, repair.page(cx, current, publisher)).await?.transpose()?;
                        }
                        continue;
                    }
                    _ = ticker.tick() => {
                        // Resolving a consumed ring signal can require a durable read.
                        // Keep that read alive across idle vector maintenance.
                        if Instant::now() >= next_model_check
                            && let Some(current) = &mut disk
                            && (retry_model || (current.manifest.embeddings_pending
                                && current.manifest.vector_seq.is_none()))
                        {
                            break ChangeNotice::Lagged { resume };
                        }
                        if let Some(disk) = &mut disk {
                            update::maintain_vectors(disk, publisher).await?;
                            if cx.handle.active_queries.load(Ordering::Acquire) == 0 {
                                // Keep the subscription and durable cut while the reader is idle.
                                if disk.lexical.take().is_some() {
                                    publisher.replace(None);
                                }
                                disk.release_idle_vectors(Instant::now(), vector_idle);
                            } else {
                                disk.vector_last_use = Instant::now();
                            }
                        }
                        continue;
                    }
                };
            }
        };
        if let ChangeNotice::Resync { scope } = event {
            return Ok(Some(scope));
        }
        let (target, mut scrub, mut rebind, force_seed) = match event {
            // Subscribing at zero requests a seed even for an empty Space
            // whose empty checkpoint was already verified on disk.
            ChangeNotice::SeedRequired { cutoff }
                if cutoff.after == SpaceSeq::ZERO
                    && disk
                        .as_ref()
                        .is_some_and(|current| current.cursor() == cutoff) =>
            {
                (cutoff, false, false, false)
            }
            ChangeNotice::SeedRequired { cutoff } => (cutoff, true, false, true),
            ChangeNotice::PurgeResync { cutoff } => (cutoff, true, false, true),
            ChangeNotice::Advanced(target) => (target, false, false, false),
            ChangeNotice::Lagged { resume } => {
                (cx.latest(&resume.scope).await?, false, true, false)
            }
            ChangeNotice::Resync { .. } => unreachable!("resync already handled"),
        };
        if scope != target.scope {
            return Ok(Some(target.scope));
        }
        let mut seed_at = (force_seed || disk.is_none()).then(|| target.clone());
        if !force_seed
            && let Some(current) = disk.as_ref()
            && current.lexical.is_none()
            && current.manifest.tantivy_seq < target.after
            && (cx.requires_scrub(current.cursor()).await?
                || cx.has_pending_redaction(current.cursor()).await?)
        {
            drop(disk.take());
            build::scrub(cx, publisher, &layout).await?;
            seed_at = Some(target.clone());
        }
        if !force_seed && let Some(current) = &mut disk {
            let resumed = match current.resume_reader(cx) {
                Ok(reopened) => {
                    if reopened {
                        publisher.publish(current);
                    }
                    if current.resume_vectors(cx, publisher).await? {
                        publisher.publish(current);
                    }
                    true
                }
                Err(IndexError::Lexical(LexicalError::ReaderUnavailable))
                    if current.manifest.tantivy_seq < target.after
                        && cx.has_pending_redaction(current.cursor()).await? =>
                {
                    drop(disk.take());
                    build::scrub(cx, publisher, &layout).await?;
                    seed_at = Some(target.clone());
                    false
                }
                Err(error) => return Err(error),
            };
            if resumed && let Some(current) = &mut disk {
                let catch_up = if current.manifest.tantivy_seq < target.after {
                    catch_up(cx, current, publisher, target.clone(), None).await
                } else {
                    Ok(false)
                };
                match catch_up {
                    Ok(false) => {}
                    Ok(true) => {
                        seed_at = Some(target.clone());
                        scrub = true;
                    }
                    Err(error) if error.requires_reseed() => {
                        let retired = error.requires_scrub();
                        if retired {
                            drop(disk.take());
                            build::scrub(cx, publisher, &layout).await?;
                        }
                        let latest = cx.latest(&scope).await?;
                        if latest.scope != scope {
                            layout.clear_lexical_manifests()?;
                            return Ok(Some(latest.scope));
                        }
                        rebind |= latest.after != target.after;
                        seed_at = Some(latest);
                        scrub = !retired;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if let Some(cutoff) = seed_at {
            if scrub {
                drop(disk.take());
                build::scrub(cx, publisher, &layout).await?;
            }
            let seeded = build::seed_lexical(cx, layout.clone(), &cutoff).await?;
            seeded.layout.publish_search(&seeded.manifest)?;
            disk = Some(seeded);
            build::publish_seed(cx, publisher, disk.as_ref().expect("lexical seed")).await?;
            repair = update::EmbeddingRepair::default();
            next_model_check = Instant::now();
        }
        if Instant::now() >= next_model_check
            && let Some(current) = &mut disk
        {
            match build::refresh_model(cx, publisher, current).await {
                Ok(changed) => {
                    if changed {
                        repair = update::EmbeddingRepair::default();
                        build::publish_seed(cx, publisher, current).await?;
                    }
                    retry_model = false;
                    model_retry_delay = Duration::from_secs(1);
                }
                Err(error) if error.requires_reseed() => {
                    if error.requires_scrub() {
                        drop(disk.take());
                        build::scrub(cx, publisher, &layout).await?;
                    }
                    return Err(error);
                }
                // A failed manifest sync may follow a successful atomic rename.
                // Reopen its durable selection before removing any staged epoch.
                Err(error @ IndexError::Layout(_)) => return Err(error),
                Err(error) => {
                    tracing::warn!(kind = %error, "search model refresh will retry");
                    retry_model = true;
                    next_model_check = Instant::now() + model_retry_delay;
                    model_retry_delay = (model_retry_delay * 2).min(Duration::from_secs(300));
                }
            }
        }
        let committed = disk.as_ref().ok_or(IndexError::Inconsistent)?.cursor();
        if rebind || committed.after > target.after {
            let replacement = changes.subscribe(cx.maintenance(), committed).await?;
            subscription = replacement;
        } else if committed.after >= subscription.processed().after {
            subscription.acknowledge(committed).await?;
        }
    }
}

async fn open_disk(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: Arc<SearchLayout>,
    latest: SpaceSeq,
) -> Result<Option<Disk>, IndexError> {
    let manifest = layout.search_manifest();
    let unapplied = manifest.as_ref().ok().and_then(|manifest| {
        let manifest = manifest.as_ref()?;
        (manifest.tantivy_seq < latest).then(|| ChangeCursor {
            scope: manifest.scope.clone(),
            after: manifest.tantivy_seq,
        })
    });
    if let Some(cursor) = &unapplied
        && (cx.requires_scrub(cursor.clone()).await?
            || cx.has_pending_redaction(cursor.clone()).await?)
    {
        build::scrub(cx, publisher, &layout).await?;
        return Ok(None);
    }
    let opened = (|| {
        let Some(mut manifest) = manifest? else {
            return Ok(None);
        };
        if manifest.tokenizer_version != TOKENIZER_VERSION || manifest.tantivy_seq > latest {
            return Err(IndexError::Inconsistent);
        }
        let folders = Arc::new(
            layout
                .folder_dictionary()?
                .ok_or(IndexError::Inconsistent)?,
        );
        let lexical = cx.services.readers.open(&layout.index_dir(&manifest)?)?;
        if lexical.commit_id()? != manifest.tantivy_commit {
            return Err(IndexError::Inconsistent);
        }
        if manifest.active_model.is_some()
            && manifest.vector_seq.is_none()
            && !manifest.embeddings_pending
        {
            manifest.embeddings_pending = true;
            layout.publish_search(&manifest)?;
        }
        Ok(Some(Disk {
            layout: layout.clone(),
            manifest,
            folders,
            lexical: Some(lexical),
            epoch: None,
            embedder: None,
            embedding_failures: 0,
            vector_last_use: Instant::now(),
        }))
    })();
    let disk = match opened {
        Ok(disk) => disk,
        Err(IndexError::Layout(LayoutError::WrongHistory)) => {
            layout.clear_lexical_manifests()?;
            None
        }
        Err(error @ IndexError::Lexical(LexicalError::ReaderUnavailable)) => {
            if let Some(cursor) = unapplied
                && cx.has_pending_redaction(cursor).await?
            {
                build::scrub(cx, publisher, &layout).await?;
                return Ok(None);
            }
            return Err(error);
        }
        Err(_) => None,
    };
    let preserve = disk
        .as_ref()
        .map(|disk| disk.manifest.generation())
        .transpose()?;
    for generation in layout.index_generations()? {
        if Some(generation) != preserve {
            build::remove_generation(cx, &layout, generation)?;
        }
    }
    let vector_model = disk
        .as_ref()
        .and_then(|disk| {
            disk.manifest
                .vector_seq
                .and(disk.manifest.active_model.as_ref())
        })
        .map(crate::ports::ResolvedEmbeddingTarget::vector_model);
    layout.remove_vector_epochs(vector_model.as_ref())?;
    // A corrupt dictionary cannot be used with an empty replacement index.
    if disk.is_none() && layout.folder_dictionary().is_err() {
        layout.clear_lexical_manifests()?;
    }
    Ok(disk)
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
    if !opened.is_checkpointed(seq) {
        return Err(IndexError::Inconsistent);
    }
    opened.collect_obsolete()?;
    Ok(opened)
}

#[derive(Default)]
struct ChangedNotes {
    notes: BTreeSet<NoteId>,
    moved_folders: BTreeSet<FolderId>,
    restored_folders: BTreeSet<FolderId>,
}

impl ChangedNotes {
    fn take_remote_folders(
        &mut self,
        target: Option<&crate::ports::ResolvedEmbeddingTarget>,
    ) -> BTreeSet<FolderId> {
        let moved = std::mem::take(&mut self.moved_folders);
        let mut restored = std::mem::take(&mut self.restored_folders);
        if let Some(crate::ports::EmbeddingBackendTarget::Remote { project, .. }) =
            target.map(|target| &target.backend)
        {
            if project.is_some() {
                restored.extend(moved);
            }
            restored
        } else {
            BTreeSet::new()
        }
    }
}

/// Keep the model computation alive while delivering newer lexical cuts. Its
/// input snapshot is immutable. Only the indexing owner mutates either epoch.
async fn during_model_work<T>(
    cx: &Context<'_>,
    disk: &mut Disk,
    publisher: &mut Publisher<'_>,
    dirty: &mut ChangedNotes,
    work: impl Future<Output = Result<T, IndexError>>,
) -> Result<T, IndexError> {
    let stopped = || IndexError::Embedding(crate::embed::EmbeddingError::Cancelled);
    tokio::pin!(work);
    let mut changes = tokio::select! {
        biased;
        () = cx.handle.stop.cancelled() => return Err(stopped()),
        value = &mut work => return value,
        subscription = async {
            sleep(Duration::from_millis(50)).await;
            cx.services.deps.changes.subscribe(cx.maintenance(), disk.cursor()).await
        } => subscription?,
    };
    loop {
        let notice = tokio::select! {
            biased;
            () = cx.handle.stop.cancelled() => return Err(stopped()),
            value = &mut work => return value,
            notice = changes.next() => notice?.ok_or(IndexError::Inconsistent)?,
            () = cx.handle.wake.notified() => ChangeNotice::Lagged {resume: disk.cursor()},
        };
        let target = match notice {
            ChangeNotice::Advanced(cutoff) => cutoff,
            ChangeNotice::Lagged { resume } => cx.latest(&resume.scope).await?,
            ChangeNotice::SeedRequired { cutoff } if cutoff == disk.cursor() => continue,
            _ => return Err(IndexError::Retire),
        };
        if target.scope != disk.manifest.scope {
            return Err(IndexError::Retire);
        }
        if target.after > disk.manifest.tantivy_seq
            && (cx.requires_scrub(disk.cursor()).await?
                || (disk.lexical.is_none() && cx.has_pending_redaction(disk.cursor()).await?))
        {
            return Err(IndexError::Retire);
        }
        if disk.resume_reader(cx)? {
            publisher.publish(disk);
        }
        if target.after > disk.manifest.tantivy_seq
            && catch_up(cx, disk, publisher, target.clone(), Some(dirty)).await?
        {
            return Err(IndexError::Retire);
        }
        if target.after > changes.processed().after {
            // A wakeup can observe a durable command before the subscription
            // has delivered it. Rebind at the cut the owner has now published.
            changes = cx
                .services
                .deps
                .changes
                .subscribe(cx.maintenance(), disk.cursor())
                .await?;
        }
    }
}

/// Returns true when any event requires a physical replacement generation.
async fn catch_up(
    cx: &Context<'_>,
    disk: &mut Disk,
    publisher: &mut Publisher<'_>,
    target: ChangeCursor,
    mut changed: Option<&mut ChangedNotes>,
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
        if update::requires_scrub(disk, &page.changes)? {
            return Ok(true);
        }
        tail.extend(page.changes);
        let boundary =
            tail.partition_point(|change| change.command_range.last_seq <= page.safe_ack_end);
        if boundary != 0 {
            let pending = tail.split_off(boundary);
            let complete = std::mem::replace(&mut tail, pending);
            if update::requires_scrub(disk, &complete)? {
                return Ok(true);
            }
            if let Some(dirty) = changed.as_deref_mut() {
                use notarium_core::ports::{ChangeKind, EntityId};
                for change in &complete {
                    match &change.entity {
                        EntityId::Note(id) => {
                            dirty.notes.insert(id.clone());
                        }
                        EntityId::Folder(id) if change.kind == ChangeKind::Move => {
                            dirty.moved_folders.insert(id.clone());
                        }
                        EntityId::Folder(id) if change.kind == ChangeKind::Restore => {
                            dirty.restored_folders.insert(id.clone());
                        }
                        _ => {}
                    }
                }
            }
            let committed = disk.cursor();
            let updated = update::apply(
                cx,
                disk,
                publisher,
                ChangeCursor {
                    scope: target.scope.clone(),
                    after: page.safe_ack_end,
                },
                complete,
                changed.is_some(),
            )
            .await;
            if matches!(
                updated,
                Err(IndexError::Lexical(LexicalError::WriterUnavailable))
            ) && cx.has_pending_redaction(committed).await?
            {
                // Redacted postings must be retired even when unrelated seeds
                // occupy the writers needed for the incremental merge.
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

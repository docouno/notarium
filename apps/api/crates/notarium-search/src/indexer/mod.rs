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
    ids::{RequestId, SpaceSeq},
    model::HistoryScope,
    ports::{
        CallBudget, ChangeNotice, ChangeRead, ChangeReadResult, MaintenanceContext, PageLimit,
    },
    receipt::ChangeCursor,
};
use std::{
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::{MissedTickBehavior, interval, sleep};

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
    #[error("index checkpoints disagree")]
    Inconsistent,
}

impl IndexError {
    fn requires_reseed(&self) -> bool {
        match self {
            Self::Port(PortError::Domain(error)) | Self::Domain(error) => error.requires_resync(),
            _ => false,
        }
    }

    fn requires_scrub(&self) -> bool {
        matches!(self, Self::Port(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            | Self::Domain(DomainError::ValidationFailed { diagnostic })
            if matches!(diagnostic.reason, ValidationReason::CursorStale | ValidationReason::PurgeResync))
    }
}

struct Context<'a> {
    services: &'a Services,
    handle: &'a SpaceHandle,
}

impl Context<'_> {
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

    async fn resume_vectors(&mut self) -> Result<(), IndexError> {
        self.vector_last_use = Instant::now();
        if self.epoch.is_none() && self.manifest.vector_seq.is_some() {
            let layout = self.layout.clone();
            let manifest = self.manifest.clone();
            self.epoch = tokio::task::spawn_blocking(move || open_vector_epoch(layout, &manifest))
                .await
                .map_err(|_| IndexError::Inconsistent)??;
        }
        Ok(())
    }

    fn release_idle_vectors(&mut self, now: Instant) {
        if now.saturating_duration_since(self.vector_last_use) >= VECTOR_IDLE {
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
    let latest = cx.latest(&starting_scope).await?;
    let scope = latest.scope;
    let layout = Arc::new(SearchLayout::open(
        &cx.services.config.data_root,
        scope.clone(),
    )?);
    if scope != starting_scope {
        layout.clear_lexical_manifests()?;
    }
    let mut disk = open_disk(cx, publisher, layout.clone(), latest.after).await?;
    let start = disk
        .as_ref()
        .map(Disk::cursor)
        .unwrap_or_else(|| ChangeCursor {
            scope: scope.clone(),
            after: SpaceSeq::ZERO,
        });
    let changes = &cx.services.deps.changes;
    let mut subscription = changes.subscribe(cx.maintenance(), start).await?;
    if let Some(disk) = &disk {
        publisher.publish(disk);
    }
    let mut ticker = interval(Duration::from_secs(1));
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
                            current.resume_vectors().await?;
                            repair.page(cx, current, publisher).await?;
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
                            match build::refresh_model(cx, publisher, current).await {
                                Ok(seeded) => {
                                    if let Some(seeded) = seeded {
                                        drop(disk.replace(seeded));
                                        repair = update::EmbeddingRepair::default();
                                        build::publish_seed(cx, publisher, disk.as_ref().expect("refreshed seed")).await?;
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
                                Err(error) => {
                                    tracing::warn!(kind = %error, "search model refresh will retry");
                                    retry_model = true;
                                    next_model_check = Instant::now() + model_retry_delay;
                                    model_retry_delay = (model_retry_delay * 2).min(Duration::from_secs(300));
                                }
                            }
                        }
                        if let Some(disk) = &mut disk {
                            update::maintain_vectors(disk, publisher).await?;
                            if cx.handle.active_queries.load(Ordering::Acquire) == 0 {
                                // Keep the subscription and durable cut while the reader is idle.
                                if disk.lexical.take().is_some() {
                                    publisher.replace(None);
                                }
                                disk.release_idle_vectors(Instant::now());
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
            && cx.requires_scrub(current.cursor()).await?
        {
            drop(disk.take());
            build::scrub(cx, publisher, &layout).await?;
            seed_at = Some(target.clone());
        }
        if !force_seed && let Some(current) = &mut disk {
            current.resume_vectors().await?;
            if current.resume_reader(cx)? {
                publisher.publish(current);
            }
            let catch_up = if current.manifest.tantivy_seq < target.after {
                catch_up(cx, current, publisher, target.clone()).await
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
        if seed_at.is_none()
            && Instant::now() >= next_model_check
            && let Some(current) = &mut disk
            && let Ok(selected) = cx.services.model_target(&scope, None, None).await
        {
            if current.epoch.is_some()
                && current.embedder.is_none()
                && let Some(active) = current.manifest.active_model.clone()
            {
                current.embedder = cx.services.embedder(active).await.ok().map(Arc::new);
                publisher.publish(current);
            }
            let selection_changed = current.manifest.active_model != selected;
            let backfill = current.manifest.vector_seq.is_none() && selected.is_some();
            if selection_changed || backfill {
                seed_at = Some(target.clone());
            }
        }
        if let Some(mut cutoff) = seed_at {
            loop {
                if scrub {
                    drop(disk.take());
                    build::scrub(cx, publisher, &layout).await?;
                }
                match build::seed(cx, layout.clone(), &cutoff, disk.as_ref()).await {
                    Ok(seeded) => {
                        drop(disk.replace(seeded));
                        repair = update::EmbeddingRepair::default();
                        retry_model = false;
                        model_retry_delay = Duration::from_secs(1);
                        build::publish_seed(cx, publisher, disk.as_ref().expect("seed installed"))
                            .await?;
                        break;
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
                        if latest.after <= cutoff.after {
                            return Err(error);
                        }
                        cutoff = latest;
                        rebind = true;
                        scrub = !retired;
                    }
                    Err(error) if disk.is_some() => {
                        tracing::warn!(kind = %error, "search model replacement will retry");
                        retry_model = true;
                        next_model_check = Instant::now() + model_retry_delay;
                        model_retry_delay = (model_retry_delay * 2).min(Duration::from_secs(300));
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        let committed = disk.as_ref().ok_or(IndexError::Inconsistent)?.cursor();
        if rebind {
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
        && cx.requires_scrub(cursor.clone()).await?
    {
        build::scrub(cx, publisher, &layout).await?;
        return Ok(None);
    }
    let opened = (|| {
        let Some(manifest) = manifest? else {
            return Ok(None);
        };
        if manifest.tokenizer_version != TOKENIZER_VERSION {
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
        let epoch = open_vector_epoch(layout.clone(), &manifest)?;
        Ok(Some(Disk {
            layout: layout.clone(),
            manifest,
            folders,
            lexical: Some(lexical),
            epoch,
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
                && cx
                    .services
                    .deps
                    .canonical
                    .has_search_redaction_after(&cx.services.authority, cx.budget(), cursor)
                    .await?
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
        .and_then(|disk| disk.epoch.as_ref().and(disk.manifest.active_model.as_ref()))
        .map(crate::ports::ResolvedEmbeddingTarget::vector_model);
    layout.remove_vector_epochs(vector_model.as_ref())?;
    if disk.is_none() {
        // A corrupt dictionary cannot be used with an empty replacement index.
        if layout.folder_dictionary().is_err() {
            layout.clear_lexical_manifests()?;
        }
    }
    Ok(disk)
}

fn open_vector_epoch(
    layout: Arc<SearchLayout>,
    manifest: &SearchManifest,
) -> Result<Option<VectorEpoch>, IndexError> {
    match (&manifest.active_model, manifest.vector_seq) {
        (Some(model), Some(seq)) if seq <= manifest.tantivy_seq => {
            let model = model.vector_model();
            let epoch = layout
                .epoch_manifest(&model)?
                .ok_or(IndexError::Inconsistent)?;
            let opened = VectorEpoch::open_model(layout, model)?;
            if !opened.is_checkpointed(seq) || !epoch.complete_backfill {
                return Err(IndexError::Inconsistent);
            }
            opened.collect_obsolete()?;
            Ok(Some(opened))
        }
        (None, None) => Ok(None),
        (Some(_), None) if manifest.embeddings_pending => Ok(None),
        _ => Err(IndexError::Inconsistent),
    }
}

/// Returns true when any event requires a physical replacement generation.
async fn catch_up(
    cx: &Context<'_>,
    disk: &mut Disk,
    publisher: &mut Publisher<'_>,
    target: ChangeCursor,
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
            update::apply(
                cx,
                disk,
                publisher,
                ChangeCursor {
                    scope: target.scope.clone(),
                    after: page.safe_ack_end,
                },
                complete,
            )
            .await?;
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

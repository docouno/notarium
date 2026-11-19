mod build;
mod update;

use crate::{
    engine::{Published, Services, SpaceHandle, maintenance_budget},
    layout::{FolderDictionary, LayoutError, SearchLayout, SearchManifest},
    lexical::{LexicalError, LexicalIndex, TOKENIZER_VERSION},
    vector::{VectorEpoch, VectorError},
};
use notarium_core::{
    DomainError,
    error::PortError,
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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{MissedTickBehavior, interval, sleep};

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
    fn requires_reseed(&self) -> bool {
        match self {
            Self::Port(PortError::Domain(error)) | Self::Domain(error) => error.requires_resync(),
            _ => false,
        }
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
}

struct Disk {
    layout: Arc<SearchLayout>,
    manifest: SearchManifest,
    folders: Arc<FolderDictionary>,
    lexical: Arc<LexicalIndex>,
    epoch: Option<VectorEpoch>,
}

impl Disk {
    fn cursor(&self) -> ChangeCursor {
        ChangeCursor {
            scope: self.manifest.scope.clone(),
            after: self.manifest.tantivy_seq,
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
        self.replace(Some(Arc::new(Published {
            scope: disk.manifest.scope.clone(),
            seq: disk.manifest.tantivy_seq,
            lexical: disk.lexical.clone(),
            searcher: disk.lexical.searcher(),
            folders: disk.folders.clone(),
            vectors: disk.epoch.as_ref().map(|epoch| Arc::new(epoch.snapshot())),
            embeddings_pending: disk.manifest.embeddings_pending,
        })));
    }

    async fn without_vectors(&mut self) {
        if let Some(active) = self
            .handle
            .published
            .load_full()
            .filter(|active| active.vectors.is_some())
        {
            self.replace(Some(Arc::new(Published {
                scope: active.scope.clone(),
                seq: active.seq,
                lexical: active.lexical.clone(),
                searcher: active.searcher.clone(),
                folders: active.folders.clone(),
                vectors: None,
                embeddings_pending: true,
            })));
        }
        self.drain().await;
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
    let mut disk = open_disk(cx, layout.clone())?;
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
                    _ = ticker.tick() => {
                        // Resolving a consumed ring signal can require a durable read.
                        // Keep that read alive across idle vector maintenance.
                        if let Some(disk) = &mut disk {
                            update::maintain_vectors(disk, publisher).await?;
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
        if let Some(current) = &mut disk
            && !force_seed
            && current.manifest.tantivy_seq < target.after
        {
            match catch_up(cx, current, publisher, target.clone()).await {
                Ok(false) => {}
                Ok(true) => {
                    seed_at = Some(target.clone());
                    scrub = true;
                }
                Err(error) if error.requires_reseed() => {
                    let latest = cx.latest(&scope).await?;
                    if latest.scope != scope {
                        return Ok(Some(latest.scope));
                    }
                    rebind |= latest.after != target.after;
                    seed_at = Some(latest);
                    scrub = true;
                }
                Err(error) => return Err(error),
            }
        }
        if seed_at.is_none()
            && let Some(current) = &disk
            && let Ok(selected) = cx.services.model_target(&scope, None, None).await
        {
            let selection_changed = current.manifest.active_model.as_ref()
                != selected.as_ref().map(|target| &target.model);
            let backfill = if !selection_changed
                && current.epoch.is_none()
                && let Some(target) = selected
            {
                cx.services.embedder(target, true).await.is_ok()
            } else {
                false
            };
            if selection_changed || backfill {
                seed_at = Some(target.clone());
            }
        }
        if let Some(mut cutoff) = seed_at {
            let mut reusable = disk.take().and_then(|prior| prior.epoch);
            loop {
                match build::seed(
                    cx,
                    publisher,
                    layout.clone(),
                    &cutoff,
                    scrub,
                    reusable.take(),
                )
                .await
                {
                    Ok(seeded) => {
                        disk = Some(seeded);
                        break;
                    }
                    Err(error) if error.requires_reseed() => {
                        let latest = cx.latest(&scope).await?;
                        if latest.scope != scope {
                            return Ok(Some(latest.scope));
                        }
                        if latest.after <= cutoff.after {
                            return Err(error);
                        }
                        cutoff = latest;
                        rebind = true;
                        scrub = true;
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

fn open_disk(cx: &Context<'_>, layout: Arc<SearchLayout>) -> Result<Option<Disk>, IndexError> {
    let opened = (|| {
        let Some(manifest) = layout.search_manifest()? else {
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
        let epoch = match (&manifest.active_model, manifest.vector_seq) {
            (Some(model), Some(seq)) if seq <= manifest.tantivy_seq => {
                let epoch = layout
                    .epoch_manifest(model)?
                    .ok_or(IndexError::Inconsistent)?;
                let opened =
                    VectorEpoch::open(layout.clone(), model.clone(), epoch.dimension as usize)?;
                if !opened.is_checkpointed(seq) || !epoch.complete_backfill {
                    return Err(IndexError::Inconsistent);
                }
                opened.collect_obsolete()?;
                Some(opened)
            }
            (None, None) => None,
            (Some(_), None) if manifest.embeddings_pending => None,
            _ => return Err(IndexError::Inconsistent),
        };
        Ok(Some(Disk {
            layout: layout.clone(),
            manifest,
            folders,
            lexical,
            epoch,
        }))
    })();
    let disk = match opened {
        Ok(disk) => disk,
        Err(IndexError::Layout(LayoutError::WrongHistory)) => {
            layout.clear_lexical_manifests()?;
            None
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
    if disk.is_none() {
        layout.remove_vector_epochs(None)?;
        // A corrupt dictionary cannot be used with an empty replacement index.
        if layout.folder_dictionary().is_err() {
            layout.clear_lexical_manifests()?;
        }
    }
    Ok(disk)
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

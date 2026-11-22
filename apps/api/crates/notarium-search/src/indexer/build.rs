use super::{Context, Disk, IndexError, ModelError, Publisher, new_budget};
use crate::{
    config::VectorMode,
    embed::{EmbeddingError, Priority},
    engine::{Clock, Services},
    layout::{FolderDictionary, SearchLayout, SearchManifest, VectorModel, index_name},
    lexical::{LexicalIndex, ReaderCache, SeedLease, TOKENIZER_VERSION, Update, WriterPool},
    model::{Embedder, IndexNote, NoteIndexOutcome, NotePreparation, PreparedIndexNote},
    ports::{ResolvedEmbeddingTarget, SearchIndexedNote},
    vector::{
        MmapSegment, QuantizedVector, RepairDirectory, SegmentBuilder, StagedNoteSegments,
        VectorChunk, VectorEpoch, VectorError, segment_file_path,
    },
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{ClassEgressFence, DocClass, SearchContent},
    epoch::{DataRoot, SearchIndexKind},
    error::{CommitEffect, PortError},
    ids::{ChatThreadId, ContentDigest, FolderId, NoteId, ThreadEntrySeq},
    model::Lifecycle,
    ports::{Cancellation, PageLimit},
    receipt::ChangeCursor,
};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) async fn scrub(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: &Arc<SearchLayout>,
) -> Result<(), IndexError> {
    publisher.replace(None);
    publisher.drain().await;
    let layout = layout.clone();
    let data_root = cx.services.config.data_root.clone();
    let writers = cx.services.writers.clone();
    let readers = cx.services.readers.clone();
    tokio::task::spawn_blocking(move || -> Result<(), IndexError> {
        // An absent manifest forces cleanup before reopening either index.
        layout.invalidate_search()?;
        let vectors = layout.remove_vector_epochs(None);
        let mut lexical_error = None;
        for generation in layout.index_generations()? {
            if let Err(error) =
                remove_generation_parts(&data_root, &writers, &readers, &layout, generation)
            {
                lexical_error.get_or_insert(error);
            }
        }
        vectors?;
        lexical_error.map_or(Ok(()), Err)
    })
    .await
    .map_err(|_| IndexError::Inconsistent)?
}

pub(super) async fn seed_lexical(
    cx: &Context<'_>,
    layout: Arc<SearchLayout>,
    cutoff: &ChangeCursor,
) -> Result<(Disk, Arc<LexicalIndex>), IndexError> {
    let space = cx
        .services
        .deps
        .canonical
        .read_space(&cutoff.scope.space_id)
        .await?;
    space.scope.check(&cutoff.scope)?;

    let layout_init = layout.clone();
    let readers = cx.services.readers.clone();
    let owner = cx.reader_owner();
    let root_folder = space.root_folder_id;
    let (generation, mut folders, lexical_path, lexical) = tokio::task::spawn_blocking(move || {
        let generation = layout_init
            .index_generations()?
            .last()
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(IndexError::Inconsistent)?;
        let mut folders = layout_init.folder_dictionary()?.unwrap_or_default();
        let before = folders.len();
        folders.insert(root_folder)?;
        save_new_folders(&layout_init, &folders, before)?;
        let path = layout_init.create_index_generation(generation)?;
        let lexical = match readers.create_owned(&path, owner) {
            Ok(lexical) => lexical,
            Err(error) => {
                let _ = layout_init.remove_index_generation(generation);
                return Err(error.into());
            }
        };
        Ok::<_, IndexError>((generation, folders, path, lexical))
    })
    .await
    .map_err(|_| IndexError::Inconsistent)??;

    let result = async {
        // Hold the active SeedLease across all note and chat pages until
        // commit_seed completes so the writer cannot be evicted mid-seed.
        let mut seed_lease: Option<SeedLease> = None;
        seed_notes(cx, &layout, &lexical, &mut folders, cutoff, &mut seed_lease).await?;
        seed_chats(cx, &layout, &lexical, &mut folders, cutoff, &mut seed_lease).await?;
        let writers = cx.services.writers.clone();
        let lexical_commit = lexical.clone();
        let commit_id = tokio::task::spawn_blocking(move || -> Result<u64, IndexError> {
            lexical_commit.commit_seed(&writers)?;
            drop(seed_lease);
            Ok(lexical_commit.commit_id()?)
        })
        .await
        .map_err(|_| IndexError::Inconsistent)??;
        let now = Instant::now();
        let manifest = SearchManifest {
            scope: cutoff.scope.clone(),
            tantivy_seq: cutoff.after,
            tantivy_commit: commit_id,
            active_index_dir: index_name(generation),
            tokenizer_version: TOKENIZER_VERSION,
            remote_admission: None,
            active_model: None,
            vector_seq: None,
            vector_replay_after: None,
            embeddings_pending: !matches!(cx.services.config.vector_mode, VectorMode::Disabled),
        };
        Ok::<_, IndexError>((
            Disk {
                layout: layout.clone(),
                manifest,
                folders: Arc::new(folders),
                lexical_path,
                lexical_idle_retired: false,
                epoch: None,
                embedder: None,
                dirty_notes: BTreeSet::new(),
                repairs: super::RepairTurns::default(),
                cached_vectors: HashMap::new(),
                sweep: super::FullSweep::Idle,
                last_activity: now,
                embedder_last_use: now,
                embedder_unavailable: false,
            },
            lexical,
        ))
    }
    .await;
    if result.is_err() {
        let data_root = cx.services.config.data_root.clone();
        let writers = cx.services.writers.clone();
        let readers = cx.services.readers.clone();
        let layout_clean = layout.clone();
        let _ = tokio::task::spawn_blocking(move || {
            remove_generation_parts(&data_root, &writers, &readers, &layout_clean, generation)
        })
        .await;
    }
    result
}

pub(super) struct ModelRefreshInput {
    pub services: Arc<Services>,
    pub layout: Arc<SearchLayout>,
    pub base: ChangeCursor,
    pub folders: Arc<FolderDictionary>,
    pub active: Option<ResolvedEmbeddingTarget>,
    pub remote_admission: Option<ContentDigest>,
    pub have_epoch: bool,
    pub pending: bool,
    pub cancel: Cancellation,
}

pub(super) struct BuiltModelEpoch {
    pub target: ResolvedEmbeddingTarget,
    pub remote_admission: Option<ContentDigest>,
    pub embedder: Arc<Embedder>,
    pub epoch: VectorEpoch,
    pub failed_notes: BTreeSet<NoteId>,
    pub missing_folders: BTreeSet<FolderId>,
}

pub(super) enum ModelRefreshOutcome {
    Unchanged,
    AdmissionChanged(ContentDigest),
    Cleared,
    PendingModel(ResolvedEmbeddingTarget),
    Built(Box<BuiltModelEpoch>),
}

/// Prepare and seal a vector epoch against a frozen cut off-owner.
pub(super) async fn prepare_model_refresh(
    input: ModelRefreshInput,
) -> Result<ModelRefreshOutcome, ModelError> {
    let ModelRefreshInput {
        services,
        layout,
        base,
        folders,
        active,
        remote_admission,
        have_epoch,
        pending,
        cancel,
    } = input;

    let target = services
        .model_target(&base.scope, None, &new_budget(&cancel))
        .await?;
    let revision = if target.as_ref().is_some_and(|target| {
        matches!(
            target.backend,
            crate::ports::EmbeddingBackendTarget::Remote { .. }
        )
    }) {
        let resolver = services
            .deps
            .model_resolver
            .as_ref()
            .ok_or(EmbeddingError::ModelUnavailable)?;
        let budget = new_budget(&cancel);
        Some(tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(EmbeddingError::Cancelled.into()),
            revision = tokio::time::timeout(budget.remaining,
                resolver.remote_indexing_revision(&services.authority, &base.scope, budget)) =>
                revision.map_err(|_| EmbeddingError::BudgetExceeded)??,
        })
    } else {
        None
    };
    if target == active && (!pending || have_epoch) {
        if let Some(revision) = revision
            && have_epoch
            && Some(revision) != remote_admission
        {
            return Ok(ModelRefreshOutcome::AdmissionChanged(revision));
        }
        return Ok(ModelRefreshOutcome::Unchanged);
    }
    let Some(target) = target else {
        return Ok(ModelRefreshOutcome::Cleared);
    };
    let embedder = match services.embedder(target.clone()).await {
        Ok(embedder) => Arc::new(embedder),
        Err(error) if have_epoch => return Err(ModelError::Embedding(error)),
        Err(_) => return Ok(ModelRefreshOutcome::PendingModel(target)),
    };
    let model = target.vector_model();
    if have_epoch
        && active
            .as_ref()
            .is_some_and(|current| current.vector_model() == model)
    {
        return Err(ModelError::Index(IndexError::Inconsistent));
    }

    let layout_stage = layout.clone();
    let model_stage = model.clone();
    let epoch_path = tokio::task::spawn_blocking(move || {
        layout_stage.remove_model_epoch(&model_stage)?;
        layout_stage.model_epoch(&model_stage)
    })
    .await
    .map_err(|_| ModelError::Index(IndexError::Inconsistent))??;

    let build_result = seed_vectors(
        &services,
        &layout,
        &epoch_path,
        &base,
        &folders,
        &embedder,
        &model,
        have_epoch,
        &cancel,
    )
    .await;

    let seeded = match build_result {
        Ok(seeded) => seeded,
        Err(error) => {
            cleanup_staging_epoch(layout, model).await;
            return Err(error);
        }
    };

    let selected = services
        .model_target(&base.scope, None, &new_budget(&cancel))
        .await;
    match selected {
        Ok(selected) if selected.as_ref() == Some(&target) => {
            Ok(ModelRefreshOutcome::Built(Box::new(BuiltModelEpoch {
                target,
                embedder,
                epoch: seeded.epoch,
                remote_admission: revision,
                failed_notes: seeded.failed_notes,
                missing_folders: seeded.missing_folders,
            })))
        }
        Ok(_) => {
            drop(seeded);
            cleanup_staging_epoch(layout, model).await;
            Err(ModelError::Embedding(EmbeddingError::ModelUnavailable))
        }
        Err(error) => {
            drop(seeded);
            cleanup_staging_epoch(layout, model).await;
            Err(ModelError::Embedding(error))
        }
    }
}

async fn cleanup_staging_epoch(layout: Arc<SearchLayout>, model: VectorModel) {
    let _ = tokio::task::spawn_blocking(move || layout.remove_model_epoch(&model)).await;
}

struct SeededEpoch {
    #[cfg(test)]
    peak_pending_rows: usize,
    epoch: VectorEpoch,
    failed_notes: BTreeSet<NoteId>,
    missing_folders: BTreeSet<FolderId>,
}

#[allow(clippy::too_many_arguments)]
async fn seed_vectors(
    services: &Services,
    layout: &Arc<SearchLayout>,
    epoch_path: &std::path::Path,
    cutoff: &ChangeCursor,
    folders: &FolderDictionary,
    embedder: &Embedder,
    model: &VectorModel,
    have_epoch: bool,
    cancel: &Cancellation,
) -> Result<SeededEpoch, ModelError> {
    let mut staged = SeedSegments::new(model.clone(), epoch_path.to_path_buf())?;
    let mut failed_notes = BTreeSet::new();
    let mut missing_folders = BTreeSet::new();
    let mut after = None;

    loop {
        if cancel.is_cancelled() {
            return Err(ModelError::Embedding(EmbeddingError::Cancelled));
        }
        let page = note_page_raw(services, cancel, cutoff, after).await?;
        for note in page.notes {
            if cancel.is_cancelled() {
                return Err(ModelError::Embedding(EmbeddingError::Cancelled));
            }
            if note.document.lifecycle() != Lifecycle::Active
                || note.document.class() == DocClass::EncryptedNote
                || ClassEgressFence::index_for_search(note.document.clone(), &services.authority)
                    .is_err()
            {
                continue;
            }
            let Some(folder) = folders.get(&note.parent_folder_id) else {
                missing_folders.insert(note.parent_folder_id);
                failed_notes.insert(note.note_id);
                continue;
            };
            let prepared = embedder
                .prepare_note(IndexNote {
                    services,
                    scope: &cutoff.scope,
                    note: &note,
                    folder: folder.get(),
                    budget: new_budget(cancel),
                    priority: Priority::BulkImportBackfill,
                })
                .await?;
            let outcome = match prepared {
                NotePreparation::Ready(prepared) => {
                    let (next, outcome) = staged.index(*prepared, &|_| None, cancel).await?;
                    staged = next;
                    outcome
                }
                NotePreparation::Finished(outcome) => outcome,
            };
            match outcome {
                NoteIndexOutcome::Complete | NoteIndexOutcome::Denied => {}
                NoteIndexOutcome::Pending => {
                    failed_notes.insert(note.note_id);
                }
                NoteIndexOutcome::Fatal(error) => return Err(ModelError::Embedding(error)),
            }
        }
        after = page.next_after;
        if after.is_none() {
            break;
        }
    }

    // Do not swap away from a healthy active epoch when every embeddable note
    // failed transiently during the replacement backfill.
    if have_epoch && staged.is_empty() && !failed_notes.is_empty() {
        return Err(ModelError::Embedding(EmbeddingError::ModelUnavailable));
    }

    #[cfg(test)]
    let peak_pending_rows = staged.peak_pending_rows;
    let layout_owned = layout.clone();
    let cancel_owned = cancel.clone();
    let seq = cutoff.after;
    let epoch = tokio::task::spawn_blocking(move || -> Result<VectorEpoch, VectorError> {
        staged.build_pending(&cancel_owned)?;
        staged.seal(&cancel_owned)?;
        let mut epoch = VectorEpoch::open_model(layout_owned, staged.model)?;
        epoch.seed_segments(staged.sealed, seq)?;
        Ok(epoch)
    })
    .await
    .map_err(|_| ModelError::Index(IndexError::Inconsistent))??;

    Ok(SeededEpoch {
        #[cfg(test)]
        peak_pending_rows,
        epoch,
        failed_notes,
        missing_folders,
    })
}

// At the largest supported dimension this holds at most 1 MiB of pending
// quantized payload, shared across note and canonical-page boundaries.
pub(super) const VECTOR_WINDOW_ROWS: usize = 256;

struct SeedSegments {
    #[cfg(test)]
    peak_pending_rows: usize,
    model: VectorModel,
    path: std::path::PathBuf,
    builder: SegmentBuilder,
    sealed: Vec<(u64, MmapSegment)>,
    pending: Vec<VectorChunk>,
    pending_keys: HashMap<ContentDigest, usize>,
    repair_directory: Option<Arc<RepairDirectory>>,
}

/// Build one large warm replacement off-owner. No segment is linked into the
/// active epoch until the owner checks concurrent edits and folder changes.
pub(super) async fn stage_repair(
    note: PreparedIndexNote<'_>,
    layout: &SearchLayout,
    model: &VectorModel,
    existing: &(dyn Fn(ContentDigest) -> Option<QuantizedVector> + Sync),
    cancel: &Cancellation,
) -> Result<(Option<StagedNoteSegments>, NoteIndexOutcome), IndexError> {
    let directory = RepairDirectory::new(&layout.model_epoch(model)?)?;
    let mut staged = SeedSegments::new(model.clone(), directory.path.clone())?;
    // A cancelled async caller may leave a blocking seal running briefly.
    staged.repair_directory = Some(directory.clone());
    let (mut staged, outcome) = match staged.index(note, existing, cancel).await {
        Ok(result) => result,
        Err(ModelError::Index(error)) => return Err(error),
        Err(ModelError::Embedding(EmbeddingError::IndexingDenied)) => {
            return Ok((None, NoteIndexOutcome::Denied));
        }
        Err(ModelError::Embedding(error)) => return Ok((None, NoteIndexOutcome::Fatal(error))),
    };
    if staged.is_empty() || matches!(outcome, NoteIndexOutcome::Denied) {
        return Ok((None, outcome));
    }
    let stop = cancel.clone();
    let segments = tokio::task::spawn_blocking(move || {
        staged.build_pending(&stop)?;
        staged.seal(&stop)?;
        Ok::<_, VectorError>(staged.sealed)
    })
    .await
    .map_err(|_| IndexError::Inconsistent)??;
    Ok((
        Some(StagedNoteSegments {
            directory,
            segments,
        }),
        outcome,
    ))
}

impl SeedSegments {
    fn new(model: VectorModel, path: std::path::PathBuf) -> Result<Self, VectorError> {
        Ok(Self {
            #[cfg(test)]
            peak_pending_rows: 0,
            builder: SegmentBuilder::for_model(&model)?,
            model,
            path,
            sealed: Vec::new(),
            pending: Vec::with_capacity(VECTOR_WINDOW_ROWS),
            pending_keys: HashMap::new(),
            repair_directory: None,
        })
    }

    fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.builder.is_empty() && self.sealed.is_empty()
    }

    fn find_vector(&self, key: ContentDigest) -> Option<QuantizedVector> {
        self.pending_keys
            .get(&key)
            .map(|&index| self.pending[index].vector.clone())
            .or_else(|| self.builder.find_vector(key))
            .or_else(|| {
                self.sealed
                    .iter()
                    .rev()
                    .find_map(|(_, segment)| segment.find_vector(key))
            })
    }

    async fn index(
        mut self,
        mut note: PreparedIndexNote<'_>,
        existing: &(dyn Fn(ContentDigest) -> Option<QuantizedVector> + Sync),
        cancel: &Cancellation,
    ) -> Result<(Self, NoteIndexOutcome), ModelError> {
        let mut has_note_rows = false;
        let mut pending = false;
        while note.has_more() {
            if cancel.is_cancelled() {
                return Err(EmbeddingError::Cancelled.into());
            }
            let room = VECTOR_WINDOW_ROWS - self.pending.len();
            let window = note
                .index_next(room, &|key| self.find_vector(key).or_else(|| existing(key)))
                .await;
            #[cfg(test)]
            {
                self.peak_pending_rows = self
                    .peak_pending_rows
                    .max(self.pending.len() + window.chunks.len());
            }
            match window.outcome {
                NoteIndexOutcome::Denied if has_note_rows => {
                    // A scheduled grant check revoked a note that already has
                    // staged rows. Discard this unpublished epoch and retry cleanly.
                    return Err(EmbeddingError::IndexingDenied.into());
                }
                NoteIndexOutcome::Denied => return Ok((self, NoteIndexOutcome::Denied)),
                NoteIndexOutcome::Fatal(error) => return Err(error.into()),
                NoteIndexOutcome::Pending => pending = true,
                NoteIndexOutcome::Complete => {}
            }
            has_note_rows |= !window.chunks.is_empty();
            for chunk in window.chunks {
                self.pending_keys
                    .entry(chunk.metadata.key)
                    .or_insert(self.pending.len());
                self.pending.push(chunk);
            }
            if self.pending.len() == VECTOR_WINDOW_ROWS {
                let stop = cancel.clone();
                self = tokio::task::spawn_blocking(move || {
                    self.build_pending(&stop)?;
                    Ok::<_, VectorError>(self)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
            }
        }
        Ok((
            self,
            if pending {
                NoteIndexOutcome::Pending
            } else {
                NoteIndexOutcome::Complete
            },
        ))
    }

    fn build_pending(&mut self, stop: &Cancellation) -> Result<(), VectorError> {
        self.pending_keys.clear();
        let mut pending = std::mem::take(&mut self.pending);
        for chunk in pending.drain(..) {
            if self.builder.at_budget() {
                self.seal(stop)?;
            }
            self.builder.push_cancellable(chunk, stop)?;
        }
        self.pending = pending;
        Ok(())
    }

    fn seal(&mut self, stop: &Cancellation) -> Result<(), VectorError> {
        let id = u64::try_from(self.sealed.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .ok_or(VectorError::BufferFull)?;
        let builder = std::mem::replace(&mut self.builder, SegmentBuilder::for_model(&self.model)?);
        if let Some(segment) =
            builder.finish_cancellable(&segment_file_path(&self.path, id), stop)?
        {
            self.sealed.push((id, segment));
        }
        Ok(())
    }
}

pub(super) async fn publish_seed(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    disk: &Disk,
    lexical: Option<&Arc<LexicalIndex>>,
) -> Result<(), IndexError> {
    match lexical {
        Some(lexical) => publisher.publish_with(disk, lexical, false),
        None => publisher.publish_if_live(disk, false),
    }
    publisher.drain().await;
    let active = disk.manifest.generation()?;
    let layout = disk.layout.clone();
    let data_root = cx.services.config.data_root.clone();
    let writers = cx.services.writers.clone();
    let readers = cx.services.readers.clone();
    let model = disk
        .manifest
        .active_model
        .as_ref()
        .map(ResolvedEmbeddingTarget::vector_model);
    tokio::task::spawn_blocking(move || -> Result<(), IndexError> {
        for previous in layout.index_generations()? {
            if previous != active {
                remove_generation_parts(&data_root, &writers, &readers, &layout, previous)?;
            }
        }
        layout.remove_vector_epochs(model.as_ref())?;
        Ok(())
    })
    .await
    .map_err(|_| IndexError::Inconsistent)?
}

async fn seed_notes(
    cx: &Context<'_>,
    layout: &Arc<SearchLayout>,
    lexical: &Arc<LexicalIndex>,
    folders: &mut FolderDictionary,
    cutoff: &ChangeCursor,
    seed_lease: &mut Option<SeedLease>,
) -> Result<(), IndexError> {
    let mut after = None;
    loop {
        let page = note_page_raw(cx.services, &cx.handle.stop, cutoff, after).await?;
        let before = folders.len();
        let mut prepared = Vec::with_capacity(page.notes.len());
        for note in page.notes {
            if let Some(content) = prepare_note(cx, &note) {
                prepared.push((content, note.title, folders.insert(note.parent_folder_id)?));
            }
        }
        let needs_folders = folders.len() != before;
        if needs_folders || !prepared.is_empty() {
            let layout_owned = layout.clone();
            let lexical_owned = lexical.clone();
            let writers = cx.services.writers.clone();
            let folders_snapshot = needs_folders.then(|| folders.clone());
            let next_lease =
                tokio::task::spawn_blocking(move || -> Result<Option<SeedLease>, IndexError> {
                    if let Some(dict) = folders_snapshot {
                        save_new_folders(&layout_owned, &dict, before)?;
                    }
                    if prepared.is_empty() {
                        return Ok(None);
                    }
                    let updates: Vec<_> = prepared
                        .iter()
                        .map(|(content, title, folder)| Update::Note {
                            content,
                            title,
                            folder: *folder,
                        })
                        .collect();
                    Ok(Some(lexical_owned.stage_seed(&writers, &updates)?))
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
            if let Some(lease) = next_lease {
                *seed_lease = Some(lease);
            }
        }
        after = page.next_after;
        if after.is_none() {
            return Ok(());
        }
    }
}

pub(super) async fn note_page_raw(
    services: &Services,
    cancel: &Cancellation,
    cutoff: &ChangeCursor,
    after: Option<NoteId>,
) -> Result<crate::ports::SearchNotesSeedPage, IndexError> {
    let clock = Clock::new(&new_budget(cancel))?;
    let limit = PageLimit::new(100)?;
    let page = clock
        .within(async {
            let mut retries = 0;
            loop {
                let result = services
                    .deps
                    .carriers
                    .read_searchable_notes_seed_page(
                        services.authority.clone(),
                        clock.remaining()?,
                        cutoff.scope.clone(),
                        Some(cutoff.after),
                        after.clone(),
                        limit,
                    )
                    .await;
                match result {
                    Err(PortError::DeadlineExceeded(failure))
                        if failure.effect() == CommitEffect::NotCommitted && retries < 2 =>
                    {
                        retries += 1;
                        tokio::time::sleep(Duration::from_millis(25 * retries)).await;
                    }
                    result => return result,
                }
            }
        })
        .await?;
    if page.cutoff != *cutoff {
        return Err(IndexError::Inconsistent);
    }
    Ok(page)
}

async fn seed_chats(
    cx: &Context<'_>,
    layout: &Arc<SearchLayout>,
    lexical: &Arc<LexicalIndex>,
    folders: &mut FolderDictionary,
    cutoff: &ChangeCursor,
    seed_lease: &mut Option<SeedLease>,
) -> Result<(), IndexError> {
    let mut after = None;
    loop {
        let (threads, next) = cx
            .services
            .deps
            .canonical
            .list_searchable_threads_seed_page(
                &cx.services.authority,
                &cx.budget(),
                &cutoff.scope,
                cutoff.after,
                after.as_ref(),
                PageLimit::new(100)?,
            )
            .await?;
        for thread in threads {
            let mut before = None;
            loop {
                let (page, next) = chat_page_until(cx, cutoff, &thread, before, None).await?;
                let previous_len = folders.len();
                let mut rows = Vec::with_capacity(page.len());
                for hit in page {
                    let folder = hit
                        .project_folder
                        .as_ref()
                        .map(|folder| folders.insert(folder.clone()))
                        .transpose()?;
                    rows.push((hit, folder));
                }
                let needs_folders = folders.len() != previous_len;
                if needs_folders || !rows.is_empty() {
                    let layout_owned = layout.clone();
                    let lexical_owned = lexical.clone();
                    let writers = cx.services.writers.clone();
                    let folders_snapshot = needs_folders.then(|| folders.clone());
                    let next_lease = tokio::task::spawn_blocking(
                        move || -> Result<Option<SeedLease>, IndexError> {
                            if let Some(dict) = folders_snapshot {
                                save_new_folders(&layout_owned, &dict, previous_len)?;
                            }
                            if rows.is_empty() {
                                return Ok(None);
                            }
                            let updates: Vec<_> = rows
                                .iter()
                                .map(|(hit, folder)| Update::Chat {
                                    hit,
                                    folder: *folder,
                                })
                                .collect();
                            Ok(Some(lexical_owned.stage_seed(&writers, &updates)?))
                        },
                    )
                    .await
                    .map_err(|_| IndexError::Inconsistent)??;
                    if let Some(lease) = next_lease {
                        *seed_lease = Some(lease);
                    }
                }
                before = next;
                if before.is_none() {
                    break;
                }
            }
        }
        after = next;
        if after.is_none() {
            return Ok(());
        }
    }
}

pub(super) async fn chat_page_until(
    cx: &Context<'_>,
    cutoff: &ChangeCursor,
    thread: &ChatThreadId,
    before: Option<ThreadEntrySeq>,
    stop_at: Option<ThreadEntrySeq>,
) -> Result<(Vec<HydratedChatHit>, Option<ThreadEntrySeq>), IndexError> {
    let page = cx
        .services
        .deps
        .canonical
        .read_searchable_chat_entries_page_until(
            &cx.services.authority,
            &cx.budget(),
            &cutoff.scope,
            thread,
            cutoff.after,
            before,
            stop_at,
            PageLimit::new(200)?,
        )
        .await?;
    Ok((page.entries, page.next_before))
}

pub(super) fn prepare_note(cx: &Context<'_>, note: &SearchIndexedNote) -> Option<SearchContent> {
    if note.document.lifecycle() != Lifecycle::Active
        || note.document.class() == DocClass::EncryptedNote
    {
        return None;
    }
    ClassEgressFence::index_for_search(note.document.clone(), &cx.services.authority).ok()
}

pub(super) fn save_new_folders(
    layout: &SearchLayout,
    folders: &FolderDictionary,
    previous_len: usize,
) -> Result<(), IndexError> {
    if folders.len() != previous_len {
        layout.persist_folder_dictionary(folders)?;
    }
    Ok(())
}

pub(super) fn remove_generation_parts(
    data_root: &DataRoot,
    writers: &WriterPool,
    readers: &ReaderCache,
    layout: &SearchLayout,
    generation: u64,
) -> Result<(), IndexError> {
    let path = data_root
        .search(&layout.scope().space_id, SearchIndexKind::Tantivy)
        .join(index_name(generation));
    writers.release(&path)?;
    if !readers.release(&path)? {
        return Err(IndexError::Inconsistent);
    }
    layout.remove_index_generation(generation)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SearchDependencies, SearchEngine, config::SearchConfig, indexer::tests::UnusedStructural,
    };
    use notarium_canonical::{
        CanonicalConfig, CanonicalRuntime, CreateSpaceSpec, changes::SyntheticNoteSpec,
    };
    use notarium_core::{
        auth::SpaceKind,
        ids::{HistoryIncarnation, InstallationId, LeaseEpoch, PrincipalId, SpaceId, SpaceSeq},
    };

    struct WindowFixture {
        path: std::path::PathBuf,
        engine: SearchEngine,
        runtime: CanonicalRuntime,
        layout: Arc<SearchLayout>,
        embedder: Arc<Embedder>,
        cutoff: ChangeCursor,
        folders: Arc<FolderDictionary>,
        seeded: SeededEpoch,
    }

    impl WindowFixture {
        async fn shutdown(self) {
            drop(self.seeded);
            self.engine.shutdown().await;
            self.runtime.shutdown().await.unwrap();
            std::fs::remove_dir_all(self.path).unwrap();
        }

        async fn repair(
            &self,
            folders: Arc<FolderDictionary>,
            mode: crate::indexer::update::EmbedBatchMode,
        ) -> crate::indexer::update::EmbedBatchOutcome {
            crate::indexer::update::run_embed_batch(crate::indexer::update::EmbedBatchInput {
                layout: self.layout.clone(),
                services: self.engine.services.clone(),
                cutoff: self.cutoff.clone(),
                folders,
                embedder: self.embedder.clone(),
                snapshot: self.seeded.epoch.snapshot(),
                cached_vectors: HashMap::new(),
                mode,
                cancel: Cancellation::default(),
            })
            .await
            .unwrap()
        }
    }

    async fn window_fixture(rows_per_note: usize) -> WindowFixture {
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).unwrap();
        let path =
            std::env::temp_dir().join(format!("search-seed-window-{}", hex::encode(entropy)));
        std::fs::create_dir(&path).unwrap();
        let root = DataRoot::new(&path);
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([3; 16]),
            root.clone(),
        ))
        .await
        .unwrap();
        let owner = PrincipalId::from_bytes([4; 16]);
        let folder = FolderId::from_bytes([5; 16]);
        let lease = LeaseEpoch::new(1).unwrap();
        let space = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([6; 16]),
                incarnation: HistoryIncarnation::from_bytes([6; 16]),
                root_folder_id: folder.clone(),
                slug: "seed-window".into(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: lease,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let notes = (1..=2)
            .map(|id| SyntheticNoteSpec {
                note_id: NoteId::from_bytes([id; 16]),
                parent_folder: Some(folder.clone()),
                slug: format!("note-{id}"),
                title: format!("Note {id}"),
                doc_class: DocClass::UserDoc,
                lifecycle: Lifecycle::Active,
                carrier: "# Section\n\nSame body.\n\n".repeat(rows_per_note),
                fields: Default::default(),
            })
            .collect();
        let (range, _) = store
            .commit_synthetic_note_batch_for_test(&space.scope, lease, &owner, notes)
            .await
            .unwrap();
        let cutoff = ChangeCursor {
            scope: space.scope.clone(),
            after: range.last_seq,
        };
        let engine = SearchEngine::start(
            SearchConfig::new(
                root.clone(),
                VectorMode::DeterministicTest { dimension: 64 },
            ),
            SearchDependencies::new(Arc::new(store), Arc::new(UnusedStructural)),
        );
        let cancel = Cancellation::default();
        let target = engine
            .services
            .model_target(&space.scope, None, &new_budget(&cancel))
            .await
            .unwrap()
            .unwrap();
        let model = target.vector_model();
        let embedder = engine.services.embedder(target).await.unwrap();
        let layout = Arc::new(SearchLayout::open(&root, space.scope).unwrap());
        let epoch_path = layout.model_epoch(&model).unwrap();
        let mut folders = FolderDictionary::default();
        folders.insert(folder).unwrap();
        let seeded = seed_vectors(
            &engine.services,
            &layout,
            &epoch_path,
            &cutoff,
            &folders,
            &embedder,
            &model,
            false,
            &cancel,
        )
        .await
        .unwrap();
        WindowFixture {
            path,
            engine,
            runtime,
            layout,
            embedder: Arc::new(embedder),
            cutoff,
            folders: Arc::new(folders),
            seeded,
        }
    }

    #[tokio::test]
    async fn cold_seed_bounds_vector_rows_across_notes_and_keeps_every_repeated_chunk() {
        let fixture = window_fixture(VECTOR_WINDOW_ROWS + 7).await;
        let seeded = &fixture.seeded;
        let rows_per_note = VECTOR_WINDOW_ROWS + 7;
        let model = fixture.embedder.target.vector_model();
        let layout = &fixture.layout;
        let epoch_path = layout.model_epoch(&model).unwrap();
        assert!(seeded.failed_notes.is_empty());
        assert_eq!(seeded.peak_pending_rows, VECTOR_WINDOW_ROWS);
        let manifest = layout.epoch_manifest(&model).unwrap().unwrap();
        let mut counts = HashMap::<NoteId, usize>::new();
        let mut keys = BTreeSet::new();
        for id in manifest.active_segments {
            let segment =
                MmapSegment::open(&segment_file_path(&epoch_path, id), &model.hash()).unwrap();
            for slot in 0..segment.len() {
                let metadata = segment.metadata(slot).unwrap();
                *counts.entry(metadata.note).or_default() += 1;
                keys.insert(metadata.key);
            }
        }
        assert_eq!(counts.len(), 2);
        assert!(counts.values().all(|&count| count == rows_per_note));
        assert_eq!(keys.len(), 1);
        fixture.shutdown().await;
    }

    fn moved_folder_dictionary() -> Arc<FolderDictionary> {
        let mut moved = FolderDictionary::default();
        moved.insert(FolderId::from_bytes([9; 16])).unwrap();
        moved.insert(FolderId::from_bytes([5; 16])).unwrap();
        Arc::new(moved)
    }

    #[tokio::test]
    async fn warm_repair_yields_before_two_inline_notes_exceed_its_window() {
        use crate::indexer::update::{EmbedBatchMode, EmbedBatchOutcome, EmbeddedChunks};
        let per_note = VECTOR_WINDOW_ROWS / 2 + 1;
        let fixture = window_fixture(per_note).await;
        let moved = moved_folder_dictionary();
        let first = NoteId::from_bytes([1; 16]);
        let second = NoteId::from_bytes([2; 16]);
        let mut after = None;
        for expected in [first.clone(), second.clone()] {
            let result = fixture
                .repair(moved.clone(), EmbedBatchMode::FullSweep { after })
                .await;
            let EmbedBatchOutcome::Applied {
                rows,
                next_sweep_after,
                ..
            } = result
            else {
                panic!("expected inline repair")
            };
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].note_id, expected);
            assert!(
                matches!(&rows[0].chunks, EmbeddedChunks::Inline(chunks) if chunks.len() == per_note)
            );
            assert_eq!(
                next_sweep_after,
                (expected == first).then_some(first.clone())
            );
            after = next_sweep_after;
        }
        let dirty = fixture
            .repair(
                moved,
                EmbedBatchMode::DirtyNotes(vec![first.clone(), second.clone()]),
            )
            .await;
        assert!(
            matches!(dirty, EmbedBatchOutcome::Applied {rows, requeue, ..} if rows.len() == 1 && rows[0].note_id == first && requeue == [second])
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn warm_repair_skips_unchanged_and_stages_long_notes_without_losing_the_page_tail() {
        use crate::indexer::update::{EmbedBatchMode, EmbedBatchOutcome, EmbeddedChunks};
        let mut fixture = window_fixture(VECTOR_WINDOW_ROWS + 7).await;
        let full = |after| EmbedBatchMode::FullSweep { after };
        let unchanged = fixture.repair(fixture.folders.clone(), full(None)).await;
        assert!(
            matches!(unchanged, EmbedBatchOutcome::Applied {rows, requeue, next_sweep_after: None, ..} if rows.is_empty() && requeue.is_empty())
        );

        let moved = moved_folder_dictionary();
        let first = NoteId::from_bytes([1; 16]);
        let second = NoteId::from_bytes([2; 16]);
        let dirty = fixture
            .repair(
                moved.clone(),
                EmbedBatchMode::DirtyNotes(vec![first.clone(), second.clone()]),
            )
            .await;
        let EmbedBatchOutcome::Applied {
            mut rows, requeue, ..
        } = dirty
        else {
            panic!("expected staged repair")
        };
        assert_eq!(requeue.as_slice(), std::slice::from_ref(&second));
        assert_eq!(rows.len(), 1);
        let EmbeddedChunks::Staged(abandoned) = rows.remove(0).chunks else {
            panic!("expected a sealed replacement")
        };
        let scratch = abandoned.directory.path.clone();
        drop(abandoned);
        assert!(!scratch.exists());

        let mut after = None;
        for (expected_id, expected_next) in [(first.clone(), Some(first)), (second, None)] {
            let repaired = fixture.repair(moved.clone(), full(after)).await;
            let EmbedBatchOutcome::Applied {
                mut rows,
                requeue,
                next_sweep_after,
                ..
            } = repaired
            else {
                panic!("expected staged repair")
            };
            assert!(requeue.is_empty());
            assert_eq!(next_sweep_after, expected_next);
            after = next_sweep_after;
            assert_eq!(rows.len(), 1);
            let row = rows.pop().unwrap();
            assert_eq!(row.note_id, expected_id);
            let EmbeddedChunks::Staged(staged) = row.chunks else {
                panic!("expected a sealed replacement")
            };
            assert_eq!(
                staged
                    .segments
                    .iter()
                    .map(|(_, s)| s.len() as usize)
                    .sum::<usize>(),
                VECTOR_WINDOW_ROWS + 7
            );
            fixture
                .seeded
                .epoch
                .replace_staged_note(fixture.cutoff.after, row.note_id, staged)
                .unwrap();
        }
        fixture.seeded.epoch = VectorEpoch::open_model(
            fixture.layout.clone(),
            fixture.embedder.target.vector_model(),
        )
        .unwrap();
        let final_page = fixture.repair(moved, full(None)).await;
        assert!(
            matches!(final_page, EmbedBatchOutcome::Applied { rows, requeue, next_sweep_after: None, .. } if rows.is_empty() && requeue.is_empty())
        );
        fixture.shutdown().await;
    }
}

use super::{Context, Disk, IndexError, ModelError, Publisher, new_budget};
use crate::{
    config::VectorMode,
    embed::{EmbeddingError, Priority},
    engine::{Clock, Services},
    layout::{FolderDictionary, FolderOrd, SearchLayout, SearchManifest, VectorModel, index_name},
    lexical::{LexicalIndex, ReaderCache, SeedLease, TOKENIZER_VERSION, Update, WriterPool},
    model::{Embedder, IndexNote, NoteIndexOutcome},
    ports::{ResolvedEmbeddingTarget, SearchIndexedNote},
    vector::{
        MmapSegment, SegmentBuilder, VectorChunk, VectorEpoch, VectorError, segment_file_path,
    },
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{ClassEgressFence, DocClass, SearchContent},
    epoch::{DataRoot, SearchIndexKind},
    error::{CommitEffect, PortError},
    ids::{ChatThreadId, FolderId, NoteId, ThreadEntrySeq},
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
            active_model: None,
            vector_seq: None,
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
                cached_vectors: HashMap::new(),
                full_sweep_after: None,
                full_sweep_needed: false,
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
    pub have_epoch: bool,
    pub pending: bool,
    pub cancel: Cancellation,
}

pub(super) struct BuiltModelEpoch {
    pub target: ResolvedEmbeddingTarget,
    pub embedder: Arc<Embedder>,
    pub epoch: VectorEpoch,
    pub failed_notes: BTreeSet<NoteId>,
    pub missing_folders: BTreeSet<FolderId>,
}

pub(super) enum ModelRefreshOutcome {
    Unchanged,
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
        have_epoch,
        pending,
        cancel,
    } = input;

    let target = services
        .model_target(&base.scope, None, &new_budget(&cancel))
        .await?;
    if target == active && (!pending || have_epoch) {
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
    let mut builder = SegmentBuilder::for_model(model)?;
    let mut sealed: Vec<(u64, MmapSegment)> = Vec::new();
    let mut next_seg_id = 1u64;
    let mut failed_notes = BTreeSet::new();
    let mut missing_folders = BTreeSet::new();
    let mut embedded_any = false;
    let mut after = None;

    loop {
        if cancel.is_cancelled() {
            return Err(ModelError::Embedding(EmbeddingError::Cancelled));
        }
        let page = note_page_raw(services, cancel, cutoff, after).await?;
        let mut page_groups: Vec<Vec<VectorChunk>> = Vec::with_capacity(page.notes.len());
        let mut page_keys = HashMap::<_, (usize, usize)>::new();
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
            let indexed = embedder
                .index_note(IndexNote {
                    services,
                    scope: &cutoff.scope,
                    note: &note,
                    folder: folder.get(),
                    budget: new_budget(cancel),
                    priority: Priority::BulkImportBackfill,
                    existing: &|key| {
                        page_keys
                            .get(&key)
                            .map(|&(group, slot)| page_groups[group][slot].vector.clone())
                            .or_else(|| builder.find_vector(key))
                            .or_else(|| {
                                sealed
                                    .iter()
                                    .rev()
                                    .find_map(|(_, seg)| seg.find_vector(key))
                            })
                    },
                })
                .await?;
            match indexed.outcome {
                NoteIndexOutcome::Complete => {
                    if !indexed.chunks.is_empty() {
                        embedded_any = true;
                    }
                }
                NoteIndexOutcome::Pending => {
                    failed_notes.insert(note.note_id.clone());
                    if !indexed.chunks.is_empty() {
                        embedded_any = true;
                    }
                }
                NoteIndexOutcome::Fatal(error) => {
                    return Err(ModelError::Embedding(error));
                }
            }
            if !indexed.chunks.is_empty() {
                let group_idx = page_groups.len();
                for (slot, chunk) in indexed.chunks.iter().enumerate() {
                    page_keys
                        .entry(chunk.metadata.key)
                        .or_insert((group_idx, slot));
                }
                page_groups.push(indexed.chunks);
            }
        }
        if !page_groups.is_empty() {
            let model_owned = model.clone();
            let path_owned = epoch_path.to_path_buf();
            let cancel_owned = cancel.clone();
            let (next_builder, newly_sealed, updated_id) =
                tokio::task::spawn_blocking(move || -> Result<_, VectorError> {
                    let mut newly_sealed = Vec::new();
                    let mut seg_id = next_seg_id;
                    for group in page_groups {
                        // Cut segments strictly between notes so no note ever
                        // spans two sealed segments.
                        if !builder.is_empty() && builder.at_budget() {
                            let seg_path = segment_file_path(&path_owned, seg_id);
                            if let Some(segment) =
                                builder.finish_cancellable(&seg_path, &cancel_owned)?
                            {
                                newly_sealed.push((seg_id, segment));
                                seg_id = seg_id.checked_add(1).ok_or(VectorError::BufferFull)?;
                            }
                            builder = SegmentBuilder::for_model(&model_owned)?;
                        }
                        for chunk in group {
                            builder.push_cancellable(chunk, &cancel_owned)?;
                        }
                    }
                    Ok((builder, newly_sealed, seg_id))
                })
                .await
                .map_err(|_| ModelError::Index(IndexError::Inconsistent))??;
            builder = next_builder;
            sealed.extend(newly_sealed);
            next_seg_id = updated_id;
        }
        after = page.next_after;
        if after.is_none() {
            break;
        }
    }

    // Do not swap away from a healthy active epoch when every embeddable note
    // failed transiently during the replacement backfill.
    if have_epoch && !embedded_any && !failed_notes.is_empty() {
        return Err(ModelError::Embedding(EmbeddingError::ModelUnavailable));
    }

    let layout_owned = layout.clone();
    let model_owned = model.clone();
    let path_owned = epoch_path.to_path_buf();
    let cancel_owned = cancel.clone();
    let seq = cutoff.after;
    let epoch = tokio::task::spawn_blocking(move || -> Result<VectorEpoch, VectorError> {
        if !builder.is_empty() {
            let seg_path = segment_file_path(&path_owned, next_seg_id);
            if let Some(segment) = builder.finish_cancellable(&seg_path, &cancel_owned)? {
                sealed.push((next_seg_id, segment));
            }
        }
        let mut epoch = VectorEpoch::open_model(layout_owned, model_owned)?;
        epoch.seed_segments(sealed, seq)?;
        Ok(epoch)
    })
    .await
    .map_err(|_| ModelError::Index(IndexError::Inconsistent))??;

    Ok(SeededEpoch {
        epoch,
        failed_notes,
        missing_folders,
    })
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
            if let Some((content, folder)) = prepare_note(cx, folders, &note)? {
                prepared.push((content, note.title, folder));
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

pub(super) fn prepare_note(
    cx: &Context<'_>,
    folders: &mut FolderDictionary,
    note: &SearchIndexedNote,
) -> Result<Option<(SearchContent, FolderOrd)>, IndexError> {
    if note.document.lifecycle() != Lifecycle::Active
        || note.document.class() == DocClass::EncryptedNote
    {
        return Ok(None);
    }
    let Ok(content) =
        ClassEgressFence::index_for_search(note.document.clone(), &cx.services.authority)
    else {
        return Ok(None);
    };
    Ok(Some((
        content,
        folders.insert(note.parent_folder_id.clone())?,
    )))
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

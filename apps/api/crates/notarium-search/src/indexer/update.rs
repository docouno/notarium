use super::{Context, Disk, IndexError, Publisher, build, new_budget};
use crate::{
    embed::{EmbeddingError, Priority},
    engine::Services,
    layout::{FolderDictionary, FolderOrd, SearchLayout},
    lexical::{SeedLease, Update},
    model::{Embedder, IndexNote, NoteIndexOutcome, NotePreparation},
    ports::SearchIndexedNote,
    vector::{
        MutableOperation, QuantizedVector, StagedNoteSegments, VectorChunk, VectorError,
        VectorSnapshot,
    },
};
use notarium_canonical::chats::search::SearchChatDeltaPlan;
use notarium_core::{
    classes::{ClassEgressFence, DocClass, SearchContent},
    ids::{ChatThreadId, ContentDigest, FolderId, NoteId, SpaceSeq, ThreadEntrySeq},
    model::Lifecycle,
    ports::{Cancellation, Change, ChangeKind, EntityId, PageLimit},
    receipt::ChangeCursor,
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};

pub(super) async fn requires_scrub(
    lexical: &Arc<crate::lexical::LexicalIndex>,
    changes: &[Change],
) -> Result<bool, IndexError> {
    let mut encrypted_notes = Vec::new();
    for change in changes {
        if change.kind == ChangeKind::Purge || change.lifecycle == Lifecycle::Purged {
            return Ok(true);
        }
        if change.class == Some(DocClass::EncryptedNote)
            && let EntityId::Note(note) = &change.entity
        {
            encrypted_notes.push(note.clone());
        }
    }
    if encrypted_notes.is_empty() {
        return Ok(false);
    }
    let lexical = lexical.clone();
    tokio::task::spawn_blocking(move || -> Result<bool, IndexError> {
        let searcher = lexical.searcher();
        for note in &encrypted_notes {
            if lexical.contains_note(&searcher, note)? {
                return Ok(true);
            }
        }
        Ok(false)
    })
    .await
    .map_err(|_| IndexError::Inconsistent)?
}

pub(super) async fn apply(
    cx: &Context<'_>,
    disk: &mut Disk,
    lexical: &Arc<crate::lexical::LexicalIndex>,
    publisher: &mut Publisher<'_>,
    cutoff: ChangeCursor,
    changes: Vec<Change>,
    reopening: bool,
) -> Result<(), IndexError> {
    let mut notes = BTreeMap::new();
    let mut threads = BTreeSet::new();
    let mut active_folders = Vec::new();
    for change in changes {
        match change.entity {
            EntityId::Note(note) => {
                notes.insert(note, (change.lifecycle, change.class));
            }
            EntityId::Thread(thread) => {
                threads.insert(thread);
            }
            EntityId::Folder(folder) => {
                if change.lifecycle == Lifecycle::Active {
                    active_folders.push(folder);
                }
                if matches!(change.kind, ChangeKind::Restore | ChangeKind::Move)
                    && disk.manifest.active_model.as_ref().is_some_and(|target| {
                        matches!(
                            target.backend,
                            crate::ports::EmbeddingBackendTarget::Remote { .. }
                        )
                    })
                {
                    // Each remote grant uses the note's actual project, including
                    // when the selected model serves the entire space.
                    disk.request_full_sweep();
                }
            }
            EntityId::Ability(_) | EntityId::Job(_) => {}
        }
    }
    let old_folder_count = disk.folders.len();
    for folder in active_folders {
        disk.folders.get_or_insert_shared(&folder)?;
    }
    if notes.is_empty() && threads.is_empty() {
        if disk.folders.len() != old_folder_count {
            let layout = disk.layout.clone();
            let snapshot_folders = disk.folders.clone();
            tokio::task::spawn_blocking(move || {
                build::save_new_folders(&layout, &snapshot_folders, old_folder_count)
            })
            .await
            .map_err(|_| IndexError::Inconsistent)??;
        }
        disk.manifest.tantivy_seq = cutoff.after;
        disk.publish_manifest().await?;
        publisher.publish_with(disk, lexical, reopening);
        return Ok(());
    }

    let lexical = lexical.clone();

    let mut active = Vec::new();
    let mut inactive_candidates = Vec::new();
    for (note, (lifecycle, class)) in notes {
        if lifecycle == Lifecycle::Active && class != Some(DocClass::EncryptedNote) {
            active.push(note);
        } else {
            inactive_candidates.push(note);
        }
    }

    let mut deleted: BTreeSet<NoteId> = if inactive_candidates.is_empty() {
        BTreeSet::new()
    } else {
        let lexical_check = lexical.clone();
        tokio::task::spawn_blocking(move || -> Result<BTreeSet<NoteId>, IndexError> {
            let searcher = lexical_check.searcher();
            let mut found = BTreeSet::new();
            for note in inactive_candidates {
                if lexical_check.contains_note(&searcher, &note)? {
                    found.insert(note);
                }
            }
            Ok(found)
        })
        .await
        .map_err(|_| IndexError::Inconsistent)??
    };

    let mut updated_notes = Vec::new();
    let mut missing_or_denied = Vec::new();
    for ids in active.chunks(200) {
        for (id, carrier) in cx
            .services
            .deps
            .carriers
            .read_note_documents_at_cutoff(
                cx.services.authority.clone(),
                cx.budget(),
                cutoff.scope.clone(),
                cutoff.after,
                ids.to_vec(),
            )
            .await?
        {
            if let Some(row) = carrier
                && let Some(content) = build::prepare_note(cx, &row)
            {
                let folder = disk.folders.get_or_insert_shared(&row.parent_folder_id)?;
                updated_notes.push(PreparedNote {
                    row,
                    content,
                    folder,
                });
            } else {
                missing_or_denied.push(id);
            }
        }
    }
    if !missing_or_denied.is_empty() {
        let lexical_check = lexical.clone();
        let found = tokio::task::spawn_blocking(move || -> Result<Vec<NoteId>, IndexError> {
            let searcher = lexical_check.searcher();
            let mut found = Vec::new();
            for id in missing_or_denied {
                if lexical_check.contains_note(&searcher, &id)? {
                    found.push(id);
                }
            }
            Ok(found)
        })
        .await
        .map_err(|_| IndexError::Inconsistent)??;
        deleted.extend(found);
    }

    let previous_cutoff = disk.manifest.tantivy_seq;
    let chat = reconcile_chats(
        cx,
        &lexical,
        &mut disk.folders,
        previous_cutoff,
        &cutoff,
        threads,
    )
    .await?;
    let has_chat_removed = !chat.removed.is_empty();
    let updated_note_ids: Vec<NoteId> = updated_notes
        .iter()
        .map(|note| note.row.note_id.clone())
        .collect();
    let deleted_ids: Vec<NoteId> = deleted.iter().cloned().collect();

    let needs_folders = disk.folders.len() != old_folder_count;
    let folders_snapshot = needs_folders.then(|| disk.folders.clone());
    let layout = disk.layout.clone();
    let writers = cx.services.writers.clone();
    let lexical_apply = lexical.clone();
    let chat_removed = chat.removed;
    let new_commit_id = tokio::task::spawn_blocking(move || -> Result<Option<u64>, IndexError> {
        if let Some(dict) = folders_snapshot {
            build::save_new_folders(&layout, &dict, old_folder_count)?;
        }
        let mut updates =
            Vec::with_capacity(chat_removed.len() + deleted.len() + updated_notes.len());
        for (thread, seq) in &chat_removed {
            updates.push(Update::RemoveChat(thread, *seq));
        }
        for id in &deleted {
            updates.push(Update::RemoveNote(id));
        }
        for note in &updated_notes {
            updates.push(Update::Note {
                content: &note.content,
                title: &note.row.title,
                folder: note.folder,
            });
        }
        if updates.is_empty() && chat.staged.is_none() {
            return Ok(None);
        }
        lexical_apply.commit_updates(&writers, &updates, chat.staged)?;
        if !chat_removed.is_empty() {
            lexical_apply.merge_deleted(&writers)?;
        }
        Ok(Some(lexical_apply.commit_id()?))
    })
    .await
    .map_err(|_| IndexError::Inconsistent)??;

    if let Some(commit_id) = new_commit_id {
        disk.manifest.tantivy_commit = commit_id;
    }

    if disk.epoch.is_none()
        && disk.manifest.vector_seq.is_some()
        && (!updated_note_ids.is_empty() || !deleted_ids.is_empty())
    {
        // Keep the physical checkpoint. Until replay masks every changed note,
        // only the lexical cut can be published to readers.
        disk.manifest
            .vector_replay_after
            .get_or_insert(crate::layout::VectorReplay {
                after: previous_cutoff,
                needs_sweep: disk.manifest.embeddings_pending,
            });
        disk.manifest.embeddings_pending = true;
    }

    if disk.epoch.is_some() && (!updated_note_ids.is_empty() || !deleted_ids.is_empty()) {
        for id in &updated_note_ids {
            disk.cache_note_vectors(id);
        }
        let mut delete_ops = Vec::with_capacity(updated_note_ids.len() + deleted_ids.len());
        delete_ops.extend(
            updated_note_ids
                .iter()
                .cloned()
                .map(MutableOperation::Delete),
        );
        delete_ops.extend(deleted_ids.iter().cloned().map(MutableOperation::Delete));
        let mut epoch = disk.epoch.take().ok_or(IndexError::Inconsistent)?;
        let seq = cutoff.after;
        let epoch = tokio::task::spawn_blocking(move || -> Result<_, VectorError> {
            epoch.apply_batch(seq, delete_ops)?;
            epoch.checkpoint(seq)?;
            Ok(epoch)
        })
        .await
        .map_err(|_| IndexError::Inconsistent)??;
        disk.epoch = Some(epoch);
        disk.manifest.vector_seq = Some(seq);
    }

    for id in &deleted_ids {
        disk.repairs.forget(id);
    }
    if disk.epoch.is_some() || disk.manifest.vector_seq.is_some() {
        for id in updated_note_ids {
            disk.repairs.edit(id);
        }
        if disk.epoch.is_some() {
            disk.manifest.embeddings_pending = disk.has_pending_embeddings();
        }
    }

    if has_chat_removed {
        publisher.replace(None);
        publisher.drain().await;
        let writers = cx.services.writers.clone();
        let lexical_gc = lexical.clone();
        tokio::task::spawn_blocking(move || lexical_gc.collect_obsolete(&writers))
            .await
            .map_err(|_| IndexError::Inconsistent)??;
    }

    disk.manifest.tantivy_seq = cutoff.after;
    // Publishing the cut certifies that any redacted files have been removed.
    disk.publish_manifest().await?;
    publisher.publish_with(disk, &lexical, reopening);
    Ok(())
}

pub(super) const REPAIR_CARRIER_PAGE: usize = 16;

pub(super) enum EmbedBatchMode {
    DirtyNotes(Vec<NoteId>),
    FullSweep { after: Option<NoteId> },
}

pub(super) struct EmbedBatchInput {
    pub layout: Arc<SearchLayout>,
    pub services: Arc<Services>,
    pub cutoff: ChangeCursor,
    pub folders: Arc<FolderDictionary>,
    pub embedder: Arc<Embedder>,
    pub snapshot: VectorSnapshot,
    pub cached_vectors: HashMap<ContentDigest, Arc<QuantizedVector>>,
    pub deferred: Arc<BTreeSet<NoteId>>,
    pub mode: EmbedBatchMode,
    pub cancel: Cancellation,
}

pub(super) enum EmbeddedChunks {
    Inline(Vec<VectorChunk>),
    Staged(StagedNoteSegments),
}

pub(super) struct EmbeddedNoteRow {
    pub note_id: NoteId,
    pub ancestor_folders: Vec<FolderId>,
    pub chunks: EmbeddedChunks,
}

pub(super) enum EmbedBatchOutcome {
    ModelChanged,
    Backoff,
    Applied {
        rows: Vec<EmbeddedNoteRow>,
        requeue: Vec<NoteId>,
        missing_folders: BTreeSet<FolderId>,
        next_sweep_after: Option<NoteId>,
        was_full_sweep: bool,
        last_attempted: Option<NoteId>,
        selected: Vec<NoteId>,
        retry_notes: Vec<NoteId>,
        provider_backoff: Option<Duration>,
    },
}

pub(super) async fn run_embed_batch(
    input: EmbedBatchInput,
) -> Result<EmbedBatchOutcome, IndexError> {
    let EmbedBatchInput {
        layout,
        services,
        cutoff,
        folders,
        embedder,
        snapshot,
        cached_vectors,
        deferred,
        mode,
        cancel,
    } = input;

    match services
        .model_target(&cutoff.scope, None, &new_budget(&cancel))
        .await
    {
        Ok(selected) if selected.as_ref() == Some(&embedder.target) => {}
        Ok(_) => {
            return Ok(EmbedBatchOutcome::ModelChanged);
        }
        Err(_) => {
            return Ok(EmbedBatchOutcome::Backoff);
        }
    }

    let (was_full_sweep, mut next_sweep_after, items) = match &mode {
        EmbedBatchMode::DirtyNotes(ids) => {
            let rows = services
                .deps
                .carriers
                .read_note_documents_at_cutoff(
                    services.authority.clone(),
                    new_budget(&cancel),
                    cutoff.scope.clone(),
                    cutoff.after,
                    ids.clone(),
                )
                .await?;
            (false, None, rows)
        }
        EmbedBatchMode::FullSweep { after } => {
            let page = services
                .deps
                .carriers
                .read_searchable_notes_seed_page(
                    services.authority.clone(),
                    new_budget(&cancel),
                    cutoff.scope.clone(),
                    Some(cutoff.after),
                    after.clone(),
                    PageLimit::new(REPAIR_CARRIER_PAGE as u16)?,
                )
                .await?;
            if page.cutoff != cutoff {
                return Err(IndexError::Inconsistent);
            }
            let rows = page
                .notes
                .into_iter()
                .map(|note| (note.note_id.clone(), Some(note)))
                .collect();
            (true, page.next_after, rows)
        }
    };

    let priority = if was_full_sweep {
        Priority::BulkImportBackfill
    } else {
        Priority::LiveNoteEdit
    };

    let mut rows: Vec<EmbeddedNoteRow> = Vec::with_capacity(items.len());
    let mut requeue = Vec::new();
    let mut missing_folders = BTreeSet::new();
    let mut page_keys = HashMap::<ContentDigest, (usize, usize)>::new();
    let mut buffered_rows = 0;
    let mut retry_notes = Vec::new();
    let mut provider_backoff = None;
    let mut last_processed = None;
    let mut remaining = items.into_iter();
    while let Some((note_id, carrier)) = remaining.next() {
        if cancel.is_cancelled() {
            return Ok(EmbedBatchOutcome::Backoff);
        }
        let mut folded = None;
        if let Some(note) = &carrier
            && note.document.lifecycle() == Lifecycle::Active
            && note.document.class() != DocClass::EncryptedNote
            && let Ok(content) =
                ClassEgressFence::index_for_search(note.document.clone(), &services.authority)
        {
            let Some(folder) = folders.get(&note.parent_folder_id) else {
                missing_folders.insert(note.parent_folder_id.clone());
                requeue.push(note_id.clone());
                last_processed = Some(note_id);
                continue;
            };
            let prepared = embedder
                .prepare_note(IndexNote {
                    services: &services,
                    scope: &cutoff.scope,
                    note,
                    folder: folder.get(),
                    budget: new_budget(&cancel),
                    priority,
                })
                .await?;
            let lookup = |key| {
                page_keys
                    .get(&key)
                    .and_then(|&(row, slot)| {
                        if let EmbeddedChunks::Inline(chunks) = &rows[row].chunks {
                            Some(chunks[slot].vector.clone())
                        } else {
                            None
                        }
                    })
                    .or_else(|| cached_vectors.get(&key).map(|v| v.as_ref().clone()))
                    .or_else(|| snapshot.find_vector(key))
            };
            let (chunks, outcome) = match prepared {
                NotePreparation::Finished(outcome) => (None, outcome),
                NotePreparation::Ready(mut prepared) => {
                    if deferred.contains(&note_id) || prepared.matches_snapshot(&snapshot) {
                        last_processed = Some(note_id);
                        continue;
                    }
                    let count = prepared.descriptor_count();
                    if buffered_rows > 0 && count > build::VECTOR_WINDOW_ROWS - buffered_rows {
                        // The canonical cursor and the dirty queue describe only the
                        // consumed prefix. This note starts the next batch.
                        if was_full_sweep {
                            next_sweep_after = last_processed.clone();
                        } else {
                            requeue.push(note_id);
                            requeue.extend(remaining.map(|(id, _)| id));
                        }
                        break;
                    }
                    if count > build::VECTOR_WINDOW_ROWS {
                        let (staged, outcome) = build::stage_repair(
                            *prepared,
                            &layout,
                            &embedder.target.vector_model(),
                            &lookup,
                            &cancel,
                        )
                        .await?;
                        (staged.map(EmbeddedChunks::Staged), outcome)
                    } else {
                        let indexed = prepared
                            .index_next(build::VECTOR_WINDOW_ROWS, &lookup)
                            .await;
                        (
                            (!indexed.chunks.is_empty())
                                .then_some(EmbeddedChunks::Inline(indexed.chunks)),
                            indexed.outcome,
                        )
                    }
                }
            };
            match outcome {
                NoteIndexOutcome::Complete | NoteIndexOutcome::Denied => {}
                NoteIndexOutcome::Pending => {
                    retry_notes.push(note_id.clone());
                    last_processed = Some(note_id);
                    continue;
                }
                NoteIndexOutcome::Fatal(EmbeddingError::ModelUnavailable) => {
                    return Ok(EmbedBatchOutcome::ModelChanged);
                }
                NoteIndexOutcome::Fatal(error) => {
                    provider_backoff = Some(match error {
                        EmbeddingError::IndexingThrottled(delay) => delay,
                        _ => Duration::ZERO,
                    });
                    last_processed = Some(note_id.clone());
                    requeue.push(note_id);
                    requeue.extend(remaining.map(|(id, _)| id));
                    break;
                }
            }
            folded = Some((content.into_recorded_ancestor_folders(), chunks));
        }
        let (ancestor_folders, chunks) = folded.unwrap_or_default();
        let chunks = chunks.unwrap_or_else(|| EmbeddedChunks::Inline(Vec::new()));
        match &chunks {
            EmbeddedChunks::Inline(chunks) => {
                buffered_rows += chunks.len();
                for (slot, chunk) in chunks.iter().enumerate() {
                    page_keys
                        .entry(chunk.metadata.key)
                        .or_insert((rows.len(), slot));
                }
            }
            // A staged note is independent of inline WAL operations and must
            // be adopted or discarded as one unit before starting another.
            EmbeddedChunks::Staged(_) => buffered_rows = build::VECTOR_WINDOW_ROWS,
        }
        rows.push(EmbeddedNoteRow {
            note_id: note_id.clone(),
            ancestor_folders,
            chunks,
        });
        last_processed = Some(note_id.clone());
        if buffered_rows == build::VECTOR_WINDOW_ROWS && !remaining.as_slice().is_empty() {
            if was_full_sweep {
                next_sweep_after = Some(note_id);
            } else {
                requeue.extend(remaining.map(|(id, _)| id));
            }
            break;
        }
    }

    match services
        .model_target(&cutoff.scope, None, &new_budget(&cancel))
        .await
    {
        Ok(selected) if selected.as_ref() == Some(&embedder.target) => {}
        Ok(_) => {
            return Ok(EmbedBatchOutcome::ModelChanged);
        }
        Err(_) => {
            return Ok(EmbedBatchOutcome::Backoff);
        }
    }

    Ok(EmbedBatchOutcome::Applied {
        rows,
        requeue,
        missing_folders,
        next_sweep_after,
        was_full_sweep,
        last_attempted: last_processed,
        selected: match mode {
            EmbedBatchMode::DirtyNotes(ids) => ids,
            EmbedBatchMode::FullSweep { .. } => Vec::new(),
        },
        retry_notes,
        provider_backoff,
    })
}

struct PreparedNote {
    row: SearchIndexedNote,
    content: SearchContent,
    folder: FolderOrd,
}

#[derive(Default)]
struct ChatChanges {
    staged: Option<SeedLease>,
    removed: Vec<(ChatThreadId, ThreadEntrySeq)>,
}

async fn reconcile_chats(
    cx: &Context<'_>,
    lexical: &Arc<crate::lexical::LexicalIndex>,
    folders: &mut Arc<FolderDictionary>,
    previous_cutoff: SpaceSeq,
    cutoff: &ChangeCursor,
    threads: BTreeSet<ChatThreadId>,
) -> Result<ChatChanges, IndexError> {
    let mut changes = ChatChanges::default();
    for thread in threads {
        let plan = cx
            .services
            .deps
            .canonical
            .plan_searchable_chat_delta(
                &cx.services.authority,
                &cx.budget(),
                &cutoff.scope,
                &thread,
                previous_cutoff,
                cutoff.after,
            )
            .await?;
        let (stop_at, mut obsolete) = match plan {
            SearchChatDeltaPlan::Unchanged => continue,
            SearchChatDeltaPlan::AppendOnly { stop_at } => (Some(stop_at), BTreeSet::new()),
            SearchChatDeltaPlan::FullReconcile => {
                let lexical_scan = lexical.clone();
                let thread_scan = thread.clone();
                let existing = tokio::task::spawn_blocking(move || {
                    lexical_scan.live_chat_entries(&lexical_scan.searcher(), &thread_scan)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
                (None, existing)
            }
        };
        let mut before = None;
        loop {
            let (page, next) = build::chat_page_until(cx, cutoff, &thread, before, stop_at).await?;
            let mut rows = Vec::new();
            for hit in page {
                if obsolete.remove(&hit.entry) {
                    continue;
                }
                let folder = hit
                    .project_folder
                    .as_ref()
                    .map(|folder| folders.get_or_insert_shared(folder))
                    .transpose()?;
                rows.push((hit, folder));
            }
            if !rows.is_empty() {
                let lexical = lexical.clone();
                let writers = cx.services.writers.clone();
                let lease = tokio::task::spawn_blocking(move || {
                    let additions = rows
                        .iter()
                        .map(|(hit, folder)| Update::Chat {
                            hit,
                            folder: *folder,
                        })
                        .collect::<Vec<_>>();
                    lexical.stage_seed(&writers, &additions)
                })
                .await
                .map_err(|_| IndexError::Inconsistent)??;
                changes.staged = Some(lease);
            }
            before = next;
            if before.is_none() {
                break;
            }
        }
        changes
            .removed
            .extend(obsolete.into_iter().map(|seq| (thread.clone(), seq)));
    }
    Ok(changes)
}

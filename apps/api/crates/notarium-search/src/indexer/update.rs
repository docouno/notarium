use super::{Context, Disk, IndexError, Publisher, build};
use crate::{
    embed::Priority, layout::FolderOrd, lexical::Update, model::IndexNote,
    ports::SearchIndexedNote, vector::MutableOperation,
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{DocClass, SearchContent},
    ids::{ChatThreadId, NoteId, ThreadEntrySeq},
    model::Lifecycle,
    ports::{Change, ChangeKind, EntityId, PageLimit},
    receipt::ChangeCursor,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) fn requires_scrub(disk: &Disk, changes: &[Change]) -> Result<bool, IndexError> {
    let lexical = disk.lexical.as_ref().ok_or(IndexError::Inconsistent)?;
    let searcher = lexical.searcher();
    for change in changes {
        if change.kind == ChangeKind::Purge || change.lifecycle == Lifecycle::Purged {
            return Ok(true);
        }
        if change.class == Some(DocClass::EncryptedNote)
            && let EntityId::Note(note) = &change.entity
            && lexical.contains_note(&searcher, note)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn apply(
    cx: &Context<'_>,
    disk: &mut Disk,
    publisher: &mut Publisher<'_>,
    cutoff: ChangeCursor,
    changes: Vec<Change>,
) -> Result<(), IndexError> {
    let mut notes = BTreeMap::new();
    let mut threads = BTreeSet::new();
    for change in changes {
        match change.entity {
            EntityId::Note(note) => {
                notes.insert(note, (change.lifecycle, change.class));
            }
            EntityId::Thread(thread) => {
                threads.insert(thread);
            }
            EntityId::Folder(_)
                if change.kind == ChangeKind::Restore
                    && disk.manifest.active_model.as_ref().is_some_and(|target| {
                        matches!(
                            target.backend,
                            crate::ports::EmbeddingBackendTarget::Remote { .. }
                        )
                    }) =>
            {
                // A remote seed can omit descendants of a trashed folder.
                // Restoration reopens those notes for bounded embedding repair.
                disk.manifest.embeddings_pending = true;
                disk.embedding_failures = disk.embedding_failures.wrapping_add(1);
            }
            EntityId::Folder(_) | EntityId::Ability(_) | EntityId::Job(_) => {}
        }
    }
    if notes.is_empty() && threads.is_empty() {
        disk.manifest.tantivy_seq = cutoff.after;
        disk.layout.publish_search(&disk.manifest)?;
        publisher.publish(disk);
        return Ok(());
    }

    let lexical = disk
        .lexical
        .as_ref()
        .ok_or(IndexError::Inconsistent)?
        .clone();
    let previous = lexical.searcher();
    let folders = Arc::make_mut(&mut disk.folders);
    let old_folder_count = folders.len();
    let mut deleted = BTreeSet::new();
    let mut active = Vec::new();
    for (note, (lifecycle, class)) in notes {
        if lifecycle == Lifecycle::Active && class != Some(DocClass::EncryptedNote) {
            active.push(note);
        } else if lexical.contains_note(&previous, &note)? {
            deleted.insert(note);
        }
    }
    let mut updated_notes = Vec::new();
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
                && let Some((content, folder)) = build::prepare_note(cx, folders, &row)?
            {
                updated_notes.push(PreparedNote {
                    row,
                    content,
                    folder,
                });
            } else if lexical.contains_note(&previous, &id)? {
                deleted.insert(id);
            }
        }
    }
    let chat = reconcile_chats(cx, disk, &previous, &cutoff, threads).await?;
    drop(previous);
    let folders = Arc::make_mut(&mut disk.folders);
    let mut updates = build::chat_updates(folders, &chat.added)?;
    updates.extend(
        chat.removed
            .iter()
            .map(|(thread, seq)| Update::RemoveChat(thread, *seq)),
    );
    updates.extend(deleted.iter().map(Update::RemoveNote));
    updates.extend(updated_notes.iter().map(|note| Update::Note {
        content: &note.content,
        title: &note.row.title,
        folder: note.folder,
    }));
    build::save_new_folders(&disk.layout, folders, old_folder_count)?;

    if !updates.is_empty() {
        // The opstamp detects interrupted updates before a newer vector cut
        // could be paired with an older lexical publication on restart.
        lexical.apply(&cx.services.writers, &updates)?;
        if !chat.removed.is_empty() {
            lexical.merge_deleted(&cx.services.writers)?;
        }
        disk.manifest.tantivy_commit = lexical.commit_id()?;
    }
    let previous_pending = disk.manifest.embeddings_pending;
    let mut previous_vectors = std::collections::HashMap::new();
    if let Some(epoch) = &mut disk.epoch
        && (!updated_notes.is_empty() || !deleted.is_empty())
    {
        for update in &updated_notes {
            let id = &update.row.note_id;
            for chunk in epoch.mutable_note_chunks(id) {
                previous_vectors
                    .entry(chunk.metadata.key)
                    .or_insert_with(|| chunk.vector.clone());
            }
            epoch.apply(cutoff.after, MutableOperation::Delete(id.clone()))?;
        }
        for id in deleted {
            epoch.apply(cutoff.after, MutableOperation::Delete(id))?;
        }
        epoch.checkpoint(cutoff.after)?;
        disk.manifest.vector_seq = Some(cutoff.after);
        disk.manifest.embeddings_pending |= !updated_notes.is_empty();
    }
    if !chat.removed.is_empty() {
        publisher.replace(None);
        publisher.drain().await;
        lexical.collect_obsolete(&cx.services.writers)?;
    }
    disk.manifest.tantivy_seq = cutoff.after;
    // Publishing the cut certifies that any redacted files have been removed.
    disk.layout.publish_search(&disk.manifest)?;
    publisher.publish(disk);
    if disk.epoch.is_some() && !updated_notes.is_empty() {
        // Missing work survives a crash in the pending manifest. Readers can
        // already search the new text and cannot rank the old vector slots.
        let pending = cx
            .while_current(&cutoff, async {
                let selected = cx.services.model_target(&cutoff.scope, None, None).await;
                if !matches!(selected, Ok(selected) if selected == disk.manifest.active_model) {
                    return Ok(true);
                }
                disk.ensure_embedder(cx).await;
                let Some(embedder) = disk.embedder.as_ref() else {
                    return Ok(true);
                };
                let epoch = disk.epoch.as_mut().ok_or(IndexError::Inconsistent)?;
                let mut pending = false;
                for note in updated_notes {
                    let (chunks, missing) = embedder
                        .index_note(IndexNote {
                            services: cx.services,
                            scope: &cutoff.scope,
                            note: &note.row,
                            folder: note.folder.get(),
                            budget: cx.budget(),
                            priority: Priority::LiveNoteEdit,
                            existing: &|key| {
                                previous_vectors
                                    .get(&key)
                                    .cloned()
                                    .or_else(|| epoch.find_vector(key))
                            },
                        })
                        .await?;
                    pending |= missing;
                    if !chunks.is_empty() {
                        epoch.apply(
                            cutoff.after,
                            MutableOperation::Upsert {
                                note: note.row.note_id,
                                chunks,
                            },
                        )?;
                    }
                }
                Ok::<_, IndexError>(pending)
            })
            .await?
            .transpose()?
            .unwrap_or(true);
        if pending {
            disk.embedding_failures = disk.embedding_failures.wrapping_add(1);
        }
        disk.manifest.embeddings_pending = previous_pending || pending;
        disk.epoch
            .as_mut()
            .ok_or(IndexError::Inconsistent)?
            .checkpoint(cutoff.after)?;
        disk.layout.publish_search(&disk.manifest)?;
        publisher.publish(disk);
    }
    Ok(())
}

pub(super) struct EmbeddingRepair {
    after: Option<NoteId>,
    pending: bool,
    started_failures: u64,
    next: tokio::time::Instant,
    backoff: Duration,
}

impl Default for EmbeddingRepair {
    fn default() -> Self {
        let backoff = Duration::from_secs(1);
        Self {
            after: None,
            pending: false,
            started_failures: 0,
            next: tokio::time::Instant::now() + backoff,
            backoff,
        }
    }
}

impl EmbeddingRepair {
    pub(super) fn next(&self) -> tokio::time::Instant {
        self.next
    }

    fn defer(&mut self) {
        self.next = tokio::time::Instant::now() + self.backoff;
        self.backoff = (self.backoff * 2).min(Duration::from_secs(300));
    }

    /// Use the durable pending bit to resume a bounded pass after restart.
    /// A failed live edit during a pass leaves the next pass armed.
    pub(super) async fn page(
        &mut self,
        cx: &Context<'_>,
        disk: &mut Disk,
        publisher: &mut Publisher<'_>,
    ) -> Result<(), IndexError> {
        if !cx
            .services
            .model_target(&disk.manifest.scope, None, None)
            .await
            .is_ok_and(|selected| selected == disk.manifest.active_model)
        {
            self.defer();
            return Ok(());
        }
        if disk.ensure_embedder(cx).await {
            publisher.publish(disk);
        }
        let Some(embedder) = disk.embedder.as_deref() else {
            self.defer();
            return Ok(());
        };
        if self.after.is_none() {
            self.pending = false;
            self.started_failures = disk.embedding_failures;
        }
        let cutoff = disk.cursor();
        let page = cx
            .services
            .deps
            .carriers
            .read_searchable_notes_seed_page(
                cx.services.authority.clone(),
                cx.budget(),
                cutoff.scope.clone(),
                Some(cutoff.after),
                self.after.clone(),
                PageLimit::new(16)?,
            )
            .await?;
        if page.cutoff != cutoff {
            return Err(IndexError::Inconsistent);
        }
        let epoch = disk.epoch.as_mut().ok_or(IndexError::Inconsistent)?;
        let mut changed = false;
        for note in page.notes {
            let folder = disk
                .folders
                .get(&note.parent_folder_id)
                .ok_or(IndexError::Inconsistent)?;
            let (chunks, pending) = embedder
                .index_note(IndexNote {
                    services: cx.services,
                    scope: &cutoff.scope,
                    note: &note,
                    folder: folder.get(),
                    budget: cx.budget(),
                    priority: Priority::BulkImportBackfill,
                    existing: &|key| epoch.find_vector(key),
                })
                .await?;
            self.pending |= pending;
            if !epoch.matches_note_chunks(&note.note_id, &chunks) {
                epoch.apply(
                    cutoff.after,
                    MutableOperation::Upsert {
                        note: note.note_id,
                        chunks,
                    },
                )?;
                changed = true;
            }
        }
        self.after = page.next_after;
        if self.after.is_none() {
            let pending = self.pending || self.started_failures != disk.embedding_failures;
            changed |= pending != disk.manifest.embeddings_pending;
            disk.manifest.embeddings_pending = pending;
            self.defer();
        } else {
            self.next = tokio::time::Instant::now() + Duration::from_millis(25);
        }
        if changed {
            epoch.checkpoint(cutoff.after)?;
            disk.manifest.vector_seq = Some(cutoff.after);
            disk.layout.publish_search(&disk.manifest)?;
            publisher.publish(disk);
        }
        Ok(())
    }
}

pub(super) async fn maintain_vectors(
    disk: &mut Disk,
    publisher: &mut Publisher<'_>,
) -> Result<(), IndexError> {
    let Some(epoch) = &mut disk.epoch else {
        return Ok(());
    };
    let compact = epoch.should_compact();
    if compact || epoch.should_flush(Instant::now()) {
        let mut epoch = disk.epoch.take().ok_or(IndexError::Inconsistent)?;
        disk.epoch = Some(
            tokio::task::spawn_blocking(move || {
                if compact {
                    epoch.compact()?;
                } else {
                    epoch.flush()?;
                }
                Ok::<_, crate::vector::VectorError>(epoch)
            })
            .await
            .map_err(|_| IndexError::Inconsistent)??,
        );
        publisher.publish(disk);
        if compact {
            publisher.drain().await;
            disk.epoch
                .as_ref()
                .ok_or(IndexError::Inconsistent)?
                .collect_obsolete()?;
        }
    }
    Ok(())
}

struct PreparedNote {
    row: SearchIndexedNote,
    content: SearchContent,
    folder: FolderOrd,
}

#[derive(Default)]
struct ChatChanges {
    added: Vec<HydratedChatHit>,
    removed: Vec<(ChatThreadId, ThreadEntrySeq)>,
}

async fn reconcile_chats(
    cx: &Context<'_>,
    disk: &Disk,
    previous: &tantivy::Searcher,
    cutoff: &ChangeCursor,
    threads: BTreeSet<ChatThreadId>,
) -> Result<ChatChanges, IndexError> {
    let mut changes = ChatChanges::default();
    for thread in threads {
        let lexical = disk.lexical.as_ref().ok_or(IndexError::Inconsistent)?;
        let mut obsolete = lexical.live_chat_entries(previous, &thread)?;
        let mut before = None;
        loop {
            let (page, next) = build::chat_page(cx, cutoff, &thread, before).await?;
            changes
                .added
                .extend(page.into_iter().filter(|hit| !obsolete.remove(&hit.entry)));
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

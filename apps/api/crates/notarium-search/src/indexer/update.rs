use super::{Context, Disk, IndexError, Publisher, build};
use crate::{
    embed::Priority,
    layout::FolderOrd,
    lexical::Update,
    model::{Embedder, IndexNote},
    ports::SearchIndexedNote,
    vector::MutableOperation,
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{DocClass, SearchContent},
    ids::{ChatThreadId, NoteId, ThreadEntrySeq},
    model::Lifecycle,
    ports::{Change, ChangeKind, EntityId},
    receipt::ChangeCursor,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Instant,
};

pub(super) fn requires_scrub(disk: &Disk, changes: &[Change]) -> Result<bool, IndexError> {
    let searcher = disk.lexical.searcher();
    for change in changes {
        if change.kind == ChangeKind::Purge || change.lifecycle == Lifecycle::Purged {
            return Ok(true);
        }
        if change.class == Some(DocClass::EncryptedNote)
            && let EntityId::Note(note) = &change.entity
            && disk.lexical.contains_note(&searcher, note)?
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
            EntityId::Folder(_) | EntityId::Ability(_) | EntityId::Job(_) => {}
        }
    }
    if notes.is_empty() && threads.is_empty() {
        disk.manifest.tantivy_seq = cutoff.after;
        disk.layout.publish_search(&disk.manifest)?;
        publisher.publish(disk);
        return Ok(());
    }

    let previous = disk.lexical.searcher();
    let folders = Arc::make_mut(&mut disk.folders);
    let old_folder_count = folders.len();
    let mut deleted = BTreeSet::new();
    let mut active = Vec::new();
    for (note, (lifecycle, class)) in notes {
        if lifecycle == Lifecycle::Active && class != Some(DocClass::EncryptedNote) {
            active.push(note);
        } else if disk.lexical.contains_note(&previous, &note)? {
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
            } else if disk.lexical.contains_note(&previous, &id)? {
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
        disk.lexical.apply(&cx.services.writers, &updates)?;
        if !chat.removed.is_empty() {
            disk.lexical.merge_deleted(&cx.services.writers)?;
        }
        disk.manifest.tantivy_commit = disk.lexical.commit_id()?;
    }
    if disk.epoch.is_some() && (!updated_notes.is_empty() || !deleted.is_empty()) {
        let target = cx
            .services
            .model_target(&cutoff.scope, None, disk.manifest.active_model.as_ref())
            .await
            .ok()
            .flatten();
        let embedder = match target {
            Some(target) => cx.services.embedder(target, true).await.ok(),
            None => None,
        };
        apply_vectors(cx, disk, &cutoff, updated_notes, deleted, embedder.as_ref()).await?;
    }
    disk.manifest.tantivy_seq = cutoff.after;
    if !chat.removed.is_empty() {
        publisher.publish(disk);
        publisher.drain().await;
        disk.lexical.collect_obsolete(&cx.services.writers)?;
        // Closing the durable cut also certifies that the redacted files have
        // been removed. Interrupted scrubs are replayed from the older cut.
        disk.layout.publish_search(&disk.manifest)?;
    } else {
        disk.layout.publish_search(&disk.manifest)?;
        publisher.publish(disk);
    }
    Ok(())
}

async fn apply_vectors(
    cx: &Context<'_>,
    disk: &mut Disk,
    cutoff: &ChangeCursor,
    notes: Vec<PreparedNote>,
    deleted: BTreeSet<NoteId>,
    embedder: Option<&Embedder>,
) -> Result<(), IndexError> {
    let epoch = disk.epoch.as_mut().ok_or(IndexError::Inconsistent)?;
    for note in deleted {
        epoch.apply(cutoff.after, MutableOperation::Delete(note))?;
    }
    for note in notes {
        let (chunks, pending) = match embedder {
            Some(embedder) => {
                embedder
                    .index_note(IndexNote {
                        services: cx.services,
                        scope: &cutoff.scope,
                        note: &note.row,
                        folder: note.folder.get(),
                        budget: cx.budget(),
                        priority: Priority::LiveNoteEdit,
                        existing: Some(epoch),
                    })
                    .await?
            }
            None => (Vec::new(), true),
        };
        disk.manifest.embeddings_pending |= pending;
        epoch.apply(
            cutoff.after,
            MutableOperation::Upsert {
                note: note.row.note_id,
                chunks,
            },
        )?;
    }
    epoch.checkpoint(cutoff.after)?;
    disk.manifest.vector_seq = Some(cutoff.after);
    Ok(())
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
        let mut obsolete = disk.lexical.live_chat_entries(previous, &thread)?;
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

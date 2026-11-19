use super::{Context, Disk, IndexError, Publisher};
use crate::{
    embed::Priority,
    layout::{FolderDictionary, FolderOrd, SearchLayout, SearchManifest, index_name},
    lexical::{LexicalIndex, TOKENIZER_VERSION, Update},
    model::{Embedder, IndexNote},
    ports::{ResolvedEmbeddingTarget, SearchIndexedNote},
    vector::{SegmentBuilder, VectorEpoch},
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{ClassEgressFence, DocClass, SearchContent},
    ids::{ChatThreadId, SpaceSeq, ThreadEntrySeq},
    model::Lifecycle,
    ports::PageLimit,
    receipt::ChangeCursor,
};
use std::sync::Arc;

pub(super) async fn seed(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: Arc<SearchLayout>,
    cutoff: &ChangeCursor,
    target: Option<&ResolvedEmbeddingTarget>,
    scrub: bool,
    reusable: Option<VectorEpoch>,
) -> Result<Disk, IndexError> {
    let space = cx
        .services
        .deps
        .canonical
        .read_space(&cutoff.scope.space_id)
        .await?;
    space.scope.check(&cutoff.scope)?;
    let mut folders = layout.folder_dictionary()?.unwrap_or_default();
    let before = folders.len();
    folders.insert(space.root_folder_id)?;
    save_new_folders(&layout, &folders, before)?;

    let generations = layout.index_generations()?;
    let generation = generations
        .last()
        .copied()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(IndexError::Inconsistent)?;
    let path = layout.create_index_generation(generation)?;
    let result = async {
        let lexical = cx.services.readers.create(&path)?;
        let embedder = match target {
            Some(target) => cx.services.embedder(target.clone(), true).await.ok(),
            None => None,
        };
        let active = target.map(|target| &target.model);
        if scrub || active.is_some() {
            // A clean lexical generation is still being built. Keep the last
            // BM25 cut readable, and drain every generation pin before unlinking
            // any epoch that could have been referenced by it.
            publisher.without_vectors().await;
        }
        let mut vectors = match &embedder {
            Some(embedder) => Some(SeedVectors::new(&embedder.target, reusable)?),
            None => {
                drop(reusable);
                None
            }
        };
        seed_notes(
            cx,
            &layout,
            &lexical,
            &mut folders,
            cutoff,
            embedder.as_ref().zip(vectors.as_mut()),
        )
        .await?;
        seed_chats(cx, &layout, &lexical, &mut folders, cutoff).await?;
        lexical.commit_seed(&cx.services.writers)?;
        // Only the current canonical carriers contribute rows to the new
        // generation. Release old mappings before removing their directories.
        if let Some(vectors) = &mut vectors {
            drop(vectors.reusable.take());
        }
        if scrub {
            layout.remove_vector_epochs(None)?;
        } else if let Some(model) = active {
            layout.remove_model_epoch(model)?;
        }
        let (epoch, pending) = match vectors {
            Some(vectors) => {
                let (epoch, pending) = vectors.finish(layout.clone(), cutoff.after).await?;
                (Some(epoch), pending)
            }
            None => (None, active.is_some()),
        };
        let manifest = SearchManifest {
            scope: cutoff.scope.clone(),
            tantivy_seq: cutoff.after,
            tantivy_commit: lexical.commit_id()?,
            active_index_dir: index_name(generation),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: active.cloned(),
            vector_seq: epoch.as_ref().map(|_| cutoff.after),
            embeddings_pending: pending,
        };
        Ok::<_, IndexError>(Disk {
            layout: layout.clone(),
            manifest,
            folders: Arc::new(folders),
            lexical,
            epoch,
        })
    }
    .await;
    let disk = match result {
        Ok(disk) => disk,
        Err(error) => {
            cx.services.writers.release(&path)?;
            if !cx.services.readers.release(&path)? {
                return Err(IndexError::Inconsistent);
            }
            layout.remove_index_generation(generation)?;
            return Err(error);
        }
    };
    // A crash before this point can only cause a new seed. After publishing,
    // startup removes all unreferenced generations before exposing the cut.
    disk.layout.publish_search(&disk.manifest)?;
    publisher.publish(&disk);
    publisher.drain().await;
    for previous in generations {
        remove_generation(cx, &layout, previous)?;
    }
    Ok(disk)
}

async fn seed_notes(
    cx: &Context<'_>,
    layout: &SearchLayout,
    lexical: &LexicalIndex,
    folders: &mut FolderDictionary,
    cutoff: &ChangeCursor,
    mut vectors: Option<(&Embedder, &mut SeedVectors)>,
) -> Result<(), IndexError> {
    let mut after = None;
    loop {
        let page = cx
            .services
            .deps
            .carriers
            .read_searchable_notes_seed_page(
                cx.services.authority.clone(),
                cx.budget(),
                cutoff.scope.clone(),
                Some(cutoff.after),
                after,
                PageLimit::new(100)?,
            )
            .await?;
        if page.cutoff != *cutoff {
            return Err(IndexError::Inconsistent);
        }
        let before = folders.len();
        let mut prepared = Vec::new();
        let mut pending_vectors = Vec::new();
        for note in page.notes {
            if let Some((content, folder)) = prepare_note(cx, folders, &note)? {
                if let Some((embedder, builder)) = vectors.as_mut() {
                    let (for_note, pending) = embedder
                        .index_note(IndexNote {
                            services: cx.services,
                            scope: &cutoff.scope,
                            note: &note,
                            folder: folder.get(),
                            budget: cx.budget(),
                            priority: Priority::BulkImportBackfill,
                            existing: builder.reusable.as_ref(),
                        })
                        .await?;
                    builder.pending |= pending;
                    pending_vectors.extend(for_note);
                }
                prepared.push((content, note.title, folder));
            }
        }
        save_new_folders(layout, folders, before)?;
        let updates: Vec<_> = prepared
            .iter()
            .map(|(content, title, folder)| Update::Note {
                content,
                title,
                folder: *folder,
            })
            .collect();
        lexical.stage_seed(&cx.services.writers, &updates)?;
        if let Some((_, vectors)) = vectors.as_mut() {
            vectors.push(pending_vectors).await?;
        }
        if let Some(next) = page.next_after {
            after = Some(next);
        } else {
            return Ok(());
        }
    }
}

async fn seed_chats(
    cx: &Context<'_>,
    layout: &SearchLayout,
    lexical: &LexicalIndex,
    folders: &mut FolderDictionary,
    cutoff: &ChangeCursor,
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
                let (page, next) = chat_page(cx, cutoff, &thread, before).await?;
                let previous_len = folders.len();
                let updates = chat_updates(folders, &page)?;
                save_new_folders(layout, folders, previous_len)?;
                lexical.stage_seed(&cx.services.writers, &updates)?;
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

pub(super) async fn chat_page(
    cx: &Context<'_>,
    cutoff: &ChangeCursor,
    thread: &ChatThreadId,
    before: Option<ThreadEntrySeq>,
) -> Result<(Vec<HydratedChatHit>, Option<ThreadEntrySeq>), IndexError> {
    let page = cx
        .services
        .deps
        .canonical
        .read_searchable_chat_entries_page(
            &cx.services.authority,
            &cx.budget(),
            &cutoff.scope,
            thread,
            cutoff.after,
            before,
            PageLimit::new(200)?,
        )
        .await?;
    Ok((page.entries, page.next_before))
}

pub(super) fn chat_updates<'a>(
    folders: &mut FolderDictionary,
    entries: &'a [HydratedChatHit],
) -> Result<Vec<Update<'a>>, IndexError> {
    entries
        .iter()
        .map(|hit| {
            let folder = hit
                .project_folder
                .as_ref()
                .map(|folder| folders.insert(folder.clone()))
                .transpose()?;
            Ok(Update::Chat { hit, folder })
        })
        .collect()
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
    // The carrier can be pinned to an older revision while a live class or
    // lifecycle transition makes it no longer admissible to search.
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

pub(super) fn remove_generation(
    cx: &Context<'_>,
    layout: &SearchLayout,
    generation: u64,
) -> Result<(), IndexError> {
    let path = cx
        .services
        .config
        .data_root
        .search(
            &layout.scope().space_id,
            notarium_core::epoch::SearchIndexKind::Tantivy,
        )
        .join(index_name(generation));
    cx.services.writers.release(&path)?;
    if !cx.services.readers.release(&path)? {
        return Err(IndexError::Inconsistent);
    }
    layout.remove_index_generation(generation)?;
    Ok(())
}

struct SeedVectors {
    model: notarium_core::ids::ModelProfileId,
    dimension: usize,
    builder: Option<SegmentBuilder>,
    reusable: Option<VectorEpoch>,
    pending: bool,
}

impl SeedVectors {
    fn new(
        target: &ResolvedEmbeddingTarget,
        reusable: Option<VectorEpoch>,
    ) -> Result<Self, IndexError> {
        let dimension = target.dimension as usize;
        Ok(Self {
            model: target.model.clone(),
            dimension,
            builder: Some(SegmentBuilder::new(&target.model, dimension)?),
            reusable: reusable.filter(|epoch| epoch.matches_profile(&target.model, dimension)),
            pending: false,
        })
    }

    async fn push(&mut self, records: Vec<crate::vector::VectorChunk>) -> Result<(), IndexError> {
        if records.is_empty() {
            return Ok(());
        }
        let mut builder = self.builder.take().ok_or(IndexError::Inconsistent)?;
        self.builder = Some(
            tokio::task::spawn_blocking(move || {
                for record in records {
                    builder.push(record)?;
                }
                Ok::<_, crate::vector::VectorError>(builder)
            })
            .await
            .map_err(|_| IndexError::Inconsistent)??,
        );
        Ok(())
    }

    async fn finish(
        self,
        layout: Arc<SearchLayout>,
        seq: SpaceSeq,
    ) -> Result<(VectorEpoch, bool), IndexError> {
        tokio::task::spawn_blocking(move || {
            let mut epoch = VectorEpoch::open(layout, self.model, self.dimension)?;
            epoch.seed(self.builder.ok_or(IndexError::Inconsistent)?, seq)?;
            Ok((epoch, self.pending))
        })
        .await
        .map_err(|_| IndexError::Inconsistent)?
    }
}

use super::{Context, Disk, IndexError, Publisher};
use crate::{
    embed::Priority,
    layout::{FolderDictionary, FolderOrd, SearchLayout, SearchManifest, VectorModel, index_name},
    lexical::{LexicalIndex, TOKENIZER_VERSION, Update},
    model::{Embedder, IndexNote},
    ports::SearchIndexedNote,
    vector::{SegmentBuilder, VectorChunk, VectorEpoch},
};
use notarium_canonical::chats::search::HydratedChatHit;
use notarium_core::{
    classes::{ClassEgressFence, DocClass, SearchContent},
    ids::{ChatThreadId, SpaceSeq, ThreadEntrySeq},
    model::Lifecycle,
    ports::PageLimit,
    receipt::ChangeCursor,
};
use std::{collections::HashMap, sync::Arc};

pub(super) async fn scrub(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    layout: &SearchLayout,
) -> Result<(), IndexError> {
    publisher.replace(None);
    publisher.drain().await;
    // An absent manifest forces cleanup before reopening either index.
    layout.invalidate_search()?;
    let vectors = layout.remove_vector_epochs(None);
    let mut lexical_error = None;
    for generation in layout.index_generations()? {
        if let Err(error) = remove_generation(cx, layout, generation) {
            lexical_error.get_or_insert(error);
        }
    }
    vectors?;
    lexical_error.map_or(Ok(()), Err)
}

pub(super) async fn seed(
    cx: &Context<'_>,
    layout: Arc<SearchLayout>,
    cutoff: &ChangeCursor,
    prior: Option<&Disk>,
) -> Result<Disk, IndexError> {
    let generations = layout.index_generations()?;
    let generation = generations
        .last()
        .copied()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(IndexError::Inconsistent)?;
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

    let target = match cx.services.model_target(&cutoff.scope, None, None).await {
        Ok(target) => target,
        Err(error) if prior.is_some() => return Err(error.into()),
        Err(_) => None,
    };
    let model = target.as_ref().map(|target| target.vector_model());
    if let Some(model) = &model
        && prior
            .and_then(|disk| disk.epoch.as_ref())
            .is_some_and(|epoch| epoch.matches_model(model))
    {
        // The selection changed back before staging began.
        return Err(IndexError::Inconsistent);
    }
    let embedder = match &target {
        Some(target) => match cx.services.embedder(target.clone()).await {
            Ok(embedder) => Some(Arc::new(embedder)),
            Err(error) if prior.and_then(|disk| disk.epoch.as_ref()).is_some() => {
                return Err(error.into());
            }
            Err(_) => None,
        },
        None => None,
    };
    let path = layout.create_index_generation(generation)?;
    let result = async {
        let lexical = cx.services.readers.create(&path)?;
        let mut vectors = embedder
            .as_ref()
            .zip(model.as_ref())
            .map(|(_, model)| SeedVectors::new(model.clone()))
            .transpose()?;
        seed_notes(
            cx,
            &layout,
            &lexical,
            &mut folders,
            cutoff,
            embedder.as_deref().zip(vectors.as_mut()),
        )
        .await?;
        seed_chats(cx, &layout, &lexical, &mut folders, cutoff).await?;
        lexical.commit_seed(&cx.services.writers)?;
        if let Some(model) = &model {
            layout.remove_model_epoch(model)?;
        }
        let (epoch, pending) = match vectors {
            Some(vectors) => {
                let (epoch, pending) = vectors.finish(layout.clone(), cutoff.after).await?;
                (Some(epoch), pending)
            }
            None => (None, target.is_some()),
        };
        let manifest = SearchManifest {
            scope: cutoff.scope.clone(),
            tantivy_seq: cutoff.after,
            tantivy_commit: lexical.commit_id()?,
            active_index_dir: index_name(generation),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: target,
            vector_seq: epoch.as_ref().map(|_| cutoff.after),
            embeddings_pending: pending,
        };
        Ok::<_, IndexError>(Disk {
            layout: layout.clone(),
            manifest,
            folders: Arc::new(folders),
            lexical: Some(lexical),
            epoch,
            embedder,
            embedding_failures: 0,
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
            if let Some(model) = &model {
                layout.remove_model_epoch(model)?;
            }
            return Err(error);
        }
    };
    // A crash before this point can only cause a new seed. After publishing,
    // startup removes all unreferenced generations before exposing the cut.
    disk.layout.publish_search(&disk.manifest)?;
    Ok(disk)
}

pub(super) async fn publish_seed(
    cx: &Context<'_>,
    publisher: &mut Publisher<'_>,
    disk: &Disk,
) -> Result<(), IndexError> {
    publisher.publish(disk);
    publisher.drain().await;
    let active = disk.manifest.generation()?;
    for previous in disk.layout.index_generations()? {
        if previous != active {
            remove_generation(cx, &disk.layout, previous)?;
        }
    }
    let model = disk
        .manifest
        .active_model
        .as_ref()
        .map(|target| target.vector_model());
    disk.layout.remove_vector_epochs(model.as_ref())?;
    Ok(())
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
        let mut pending_vectors: Vec<VectorChunk> = Vec::new();
        let mut page_keys = HashMap::<_, usize>::new();
        for note in page.notes {
            if let Some((content, folder)) = prepare_note(cx, folders, &note)? {
                if let Some((embedder, builder)) = vectors.as_mut() {
                    let existing = |key| {
                        page_keys
                            .get(&key)
                            .map(|&slot| pending_vectors[slot].vector.clone())
                            .or_else(|| builder.builder.as_ref()?.find_vector(key).cloned())
                    };
                    let (for_note, pending) = embedder
                        .index_note(IndexNote {
                            services: cx.services,
                            scope: &cutoff.scope,
                            note: &note,
                            folder: folder.get(),
                            budget: cx.budget(),
                            priority: Priority::BulkImportBackfill,
                            existing: &existing,
                        })
                        .await?;
                    builder.pending |= pending;
                    for (position, chunk) in for_note.iter().enumerate() {
                        page_keys
                            .entry(chunk.metadata.key)
                            .or_insert(pending_vectors.len() + position);
                    }
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
    model: VectorModel,
    builder: Option<SegmentBuilder>,
    pending: bool,
}

impl SeedVectors {
    fn new(model: VectorModel) -> Result<Self, IndexError> {
        Ok(Self {
            builder: Some(SegmentBuilder::for_model(&model)?),
            model,
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
            let mut epoch = VectorEpoch::open_model(layout, self.model)?;
            epoch.seed(self.builder.ok_or(IndexError::Inconsistent)?, seq)?;
            Ok((epoch, self.pending))
        })
        .await
        .map_err(|_| IndexError::Inconsistent)?
    }
}

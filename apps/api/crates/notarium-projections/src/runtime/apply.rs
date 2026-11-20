use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Weak, atomic::Ordering},
};

use notarium_canonical::{
    LiveDenseLookup, LiveSpaceHandle, ProjectionErasures,
    codec::now_unix_ms,
    projection_chat::{ProjectionChatHead, ProjectionChatRef, ProjectionChatRefLimits},
    projection_read::{ProjectionAlias, ProjectionDelta, ProjectionNote},
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::*,
    model::{HistoryScope, Lifecycle, SnapshotCut},
    ports::{Cancellation, CommandSeqRange, SpaceEventKind},
};

use crate::{
    derived::{
        DerivedMutation, DerivedStore, ProjectedChatRef, ProjectedChatThread, ProjectedFolderAlias,
        ProjectedNoteAlias, ProjectionWatermark, SpaceApply, StageBuffer, StageKey,
        TrustedCheckpoint,
    },
    index::{FastIndexBuilder, IndexView, L0Delta, PostingKey},
    mmap::{
        self, BaseIndexHandle, IndexIdentity, PreparedCheckpoint, TrustedCheckpoint as MmapTrust,
    },
};

use super::{
    Generation, ProjectionEngine, PublishedCut, SpaceSlot,
    board_events::AffectedBoards,
    checkpoint_error, folder_move, graph_settle, link_apply,
    records::{
        FolderCatalog, NoteProjection, allocate_dense, decode, descriptors, index_note,
        persisted_schema, project_note, rank_row, reevaluate,
    },
    replay,
    worker::page_limit,
};

pub(super) struct Applied {
    pub(super) cut: Arc<PublishedCut>,
    pub(super) graph_changes: u32,
    pub(super) events: Vec<SpaceEventKind>,
    pub(super) boards: AffectedBoards,
}

pub(super) async fn recover(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    slot: &Arc<SpaceSlot>,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    let current = recover_cut(engine, store, scope, slot, stop).await?;
    engine.reclaim_superseded_checkpoints(&current).await?;
    Ok(current)
}

async fn recover_cut(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    slot: &Arc<SpaceSlot>,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    slot.check_attached()?;
    let stored = store.watermarks(&scope.space_id).await?;
    if stored.as_ref().is_none_or(|row| row.scope == *scope)
        && let Err(error) = store.register_scope(scope).await
        && !(stored.is_none() && is_history_mismatch(&error))
    {
        return Err(error);
    }
    if let Some(watermark) = stored
        && watermark.scope == *scope
        && !watermark.seed_in_progress
    {
        store.discard_staging(scope).await?;
        let previous = slot.cut.load_full().filter(|cut| &cut.cut.scope == scope);
        let purge_floor = hydrate_visibility(engine, store, scope, None, stop).await?;
        if purge_floor > watermark.projected_seq {
            // The old projection predates erased data and its checkpoint
            // cannot be recovered. Seed from the current canonical history.
            return seed(engine, store, scope, slot, None, stop).await;
        }
        let mut watermark = if purge_floor == SpaceSeq::ZERO {
            watermark
        } else {
            store
                .watermarks(&scope.space_id)
                .await?
                .filter(|current| {
                    current.scope == *scope
                        && !current.seed_in_progress
                        && current.projected_seq == watermark.projected_seq
                })
                .ok_or_else(visibility_cursor_stale)?
        };
        let reopened = open_checkpoint(
            engine,
            store,
            &watermark,
            previous.as_ref().map(|cut| &cut.base),
        )
        .await?;
        if let Some((base, graph_seq)) = reopened
            && let Some(delta) = replay::restore(store, &watermark, graph_seq, stop).await?
        {
            reclaim_unpublished_head(engine, store, &watermark).await?;
            return publish_cut(engine, store, slot, watermark, base, delta).await;
        }

        let desired = engine.cache_root.space_fast_index(
            store.generation(),
            &scope.space_id,
            watermark.projected_seq,
        );
        if previous
            .as_ref()
            .is_none_or(|cut| cut.base.path() != desired)
        {
            // A crash can leave trust metadata for a file whose new snapshot
            // watermark was never installed. A rebuild publishes a fresh file.
            if let Some(unpublished) = store
                .trusted_checkpoint(
                    scope,
                    watermark.projected_seq,
                    u32::from(crate::mmap::FORMAT_VERSION),
                    &crate::mmap::platform_abi(),
                    &engine.cache_identity,
                )
                .await?
            {
                store.forget_checkpoint(&unpublished).await?;
            }
            discard_checkpoint(engine, store, scope, slot, watermark.projected_seq).await?;
        }
        let base = write_checkpoint(engine, store, &mut watermark, None, true, stop).await?;
        let cut = publish_cut(engine, store, slot, watermark, base, L0Delta::default()).await?;
        if let Some(previous) = previous
            && previous.base.path() != cut.base.path()
        {
            // Retire the published lease shared by older readers. A separately
            // reopened handle would not keep their retained file leases alive.
            previous.base.retire(&engine.pool);
        }
        return Ok(cut);
    }
    seed(engine, store, scope, slot, None, stop).await
}

pub(super) async fn seed(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    slot: &Arc<SpaceSlot>,
    mut requested: Option<SpaceSeq>,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    const MAX_IMMEDIATE_RETRIES: usize = 3;
    for attempt in 0..MAX_IMMEDIATE_RETRIES {
        check_stop(stop)?;
        match seed_once(engine, store, scope, slot, requested, stop).await {
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if attempt + 1 < MAX_IMMEDIATE_RETRIES
                    && matches!(
                        diagnostic.reason,
                        ValidationReason::CursorStale | ValidationReason::PurgeResync
                    ) =>
            {
                requested = None;
            }
            result => return result,
        }
    }
    Err(DomainError::validation(ValidationReason::CursorStale).into())
}

async fn seed_once(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    slot: &Arc<SpaceSlot>,
    requested: Option<SpaceSeq>,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    slot.check_attached()?;
    let canonical = &engine.canonical;
    let ctx = engine.projection_context();
    let observed = store.observe_seed(&scope.space_id).await?;
    check_stop(stop)?;
    let header = canonical
        .read_projection_space_header(&ctx, &scope.space_id, requested)
        .await?;
    scope.check(&header.scope)?;
    let mut watermark = ProjectionWatermark {
        scope: scope.clone(),
        root_folder_id: header.root_folder_id,
        next_dense_id: 0,
        next_dense_folder_id: 0,
        projected_seq: header.cutoff,
        snapshot_seq: SpaceSeq::ZERO,
        graph_settled_seq: SpaceSeq::ZERO,
        schema: header.schema.as_ref().map(persisted_schema).transpose()?,
        seed_in_progress: true,
        updated_at_ms: now_unix_ms()?,
    };
    let previous = observed.previous_watermark()?;
    let mut folders = FolderCatalog::default();
    let same_history = previous.as_ref().filter(|old| old.scope == *scope);
    if let Some(old) = same_history {
        watermark.next_dense_id = old.next_dense_id;
        watermark.next_dense_folder_id = old.next_dense_folder_id;
    }
    let repair_incoming = store.begin_seed(&watermark, observed, stop).await?;
    // Physical cleanup can invalidate staging pages. Complete it before
    // constructing this seed or copying incoming references from other Spaces.
    hydrate_visibility(engine, store, scope, Some(header.cutoff), stop).await?;
    let mut stage = Stage::new(store, scope, SpaceSeq::ZERO, header.cutoff);
    let mut after = None;
    loop {
        check_stop(stop)?;
        let page = canonical
            .read_projection_folders_page(&ctx, scope, header.cutoff, after, page_limit())
            .await?;
        for folder in page.rows {
            let known = if same_history.is_some() {
                store
                    .folder_dense_for_seed(scope, &folder.metadata.folder_id)
                    .await?
            } else {
                None
            };
            folders.put(scope, folder, &mut watermark.next_dense_folder_id, known)?;
        }
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    folders.refresh_paths()?;

    let mut aliases = Vec::new();
    let mut links = link_apply::ColdLinks::default();
    let mut after = None;
    loop {
        check_stop(stop)?;
        let page = canonical
            .read_projection_aliases_page(&ctx, scope, header.cutoff, after, page_limit())
            .await?;
        let mut mutations = Vec::new();
        for alias in page.rows {
            let mutation = alias_mutation(scope, alias);
            if let DerivedMutation::UpsertFolderAlias(row) = &mutation {
                aliases.push(row.clone());
            }
            if let DerivedMutation::UpsertNoteAlias(row) = &mutation {
                links.add_note_alias(row)?;
            }
            mutations.push(mutation);
        }
        stage.push(mutations).await?;
        after = page.next;
        if after.is_none() {
            break;
        }
    }

    let topology = link_apply::build_topology(&watermark.root_folder_id, &folders, aliases)?;
    let fields = header
        .schema
        .map(|schema| schema.fields)
        .unwrap_or_default();
    let mut after = None;
    loop {
        check_stop(stop)?;
        let page = canonical
            .read_projection_notes_page(&ctx, scope, header.cutoff, after, page_limit())
            .await?;
        for note in page.rows {
            let known = if same_history.is_some() {
                store
                    .note_dense_for_seed(scope, &note.metadata.note_id)
                    .await?
            } else {
                None
            };
            let dense = match known {
                Some(dense) => dense,
                None => allocate_dense(&mut watermark.next_dense_id)?,
            };
            let outcome =
                prepare_note(engine, scope, header.cutoff, note, dense, &folders, &fields).await?;
            count_note(&mut folders, &outcome.row, true)?;
            stage.push(links.add(&outcome, &topology)?).await?;
            stage
                .push(note_mutations(outcome, watermark.schema.as_ref())?)
                .await?;
        }
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    for batch in folders
        .rows
        .into_values()
        .map(DerivedMutation::UpsertFolder)
        .collect::<Vec<_>>()
        .chunks(200)
    {
        stage.push(batch.to_vec()).await?;
    }

    let mut after = None;
    loop {
        check_stop(stop)?;
        let page = canonical
            .read_projection_overlays_page(&ctx, scope, header.cutoff, after, page_limit())
            .await?;
        let rows = page
            .rows
            .into_iter()
            .map(|row| rank_row(scope, row).map(DerivedMutation::UpsertViewRank))
            .collect::<Result<Vec<_>, _>>()?;
        stage.push(rows).await?;
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    seed_chats(engine, scope, header.cutoff, &mut stage, stop).await?;
    if repair_incoming {
        repair_incoming_chats(engine, store, scope, stop).await?;
    }
    loop {
        check_stop(stop)?;
        let batch = links.resolve_page(&scope.space_id, &topology).await?;
        if batch.is_empty() {
            break;
        }
        stage.push(batch).await?;
    }
    drop(links);
    // Revalidate the exact history before publishing a slow seed. The page call
    // also detects a purge of a pre-existing note after the originally held cut.
    canonical
        .read_projection_notes_page(&ctx, scope, header.cutoff, None, page_limit())
        .await?;
    check_stop(stop)?;
    watermark.seed_in_progress = false;
    stage
        .publish(&watermark, Some(SpaceSeq::ZERO), None)
        .await?;
    discard_checkpoint(engine, store, scope, slot, watermark.projected_seq).await?;
    let base = write_checkpoint(engine, store, &mut watermark, None, true, stop).await?;
    publish_cut(engine, store, slot, watermark, base, L0Delta::default()).await
}

/// The journal can omit the erased payload that would have replayed a purge
/// or chat redaction. Reconcile the canonical tombstones directly before
/// publishing any recovered cut or starting a seed's private write set.
async fn hydrate_visibility(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    cutoff: Option<SpaceSeq>,
    stop: &Cancellation,
) -> Result<SpaceSeq, PortError> {
    let ctx = engine.projection_context();
    let head = engine
        .canonical
        .read_projection_erasure_head(&ctx, scope)
        .await?;
    let cutoff = cutoff.unwrap_or(head.at);
    let mut purge_floor = SpaceSeq::ZERO;
    if head.has_purges {
        let mut after = None;
        loop {
            check_stop(stop)?;
            let page = engine
                .canonical
                .read_projection_purge_fences_page(&ctx, scope, after, page_limit())
                .await?;
            if let Some(through) = page.rows.iter().map(|row| row.purge_seq).max() {
                if through > cutoff {
                    return Err(visibility_cursor_stale());
                }
                engine
                    .hydrate_erasure(
                        store,
                        &ProjectionErasures {
                            scope: scope.clone(),
                            through,
                            purged: page.rows.into_iter().map(|row| row.note_id).collect(),
                            redacted: Vec::new(),
                        },
                    )
                    .await?;
                purge_floor = purge_floor.max(through);
            }
            after = page.next;
            if after.is_none() {
                break;
            }
        }
    }

    if head.has_chat_redactions {
        let mut after = None;
        loop {
            check_stop(stop)?;
            let page = engine
                .canonical
                .read_projection_chat_redactions_page(&ctx, scope, cutoff, after, page_limit())
                .await?;
            if let Some(last) = page.rows.last() {
                engine
                    .hydrate_erasure(
                        store,
                        &ProjectionErasures {
                            scope: scope.clone(),
                            through: last.redacted_at,
                            purged: Vec::new(),
                            redacted: page.rows,
                        },
                    )
                    .await?;
            }
            after = page.next;
            if after.is_none() {
                break;
            }
        }
    }
    Ok(purge_floor)
}

fn visibility_cursor_stale() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

/// Private to one serialized feed. A failed command discards this cache with its feed.
pub(super) struct CommandFolders {
    rows: FolderCatalog,
    topology: crate::links::FolderTopology,
}

async fn load_folder_aliases(
    store: &DerivedStore,
    scope: &HistoryScope,
    seq: SpaceSeq,
) -> Result<Vec<ProjectedFolderAlias>, PortError> {
    let mut aliases = Vec::new();
    let mut after = None;
    loop {
        let page = store
            .folder_alias_page(scope, seq, after.as_ref(), page_limit())
            .await?;
        let Some(last) = page.last() else { break };
        after = Some(last.clone());
        aliases.extend(page);
    }
    Ok(aliases)
}

#[cfg(test)]
pub(super) async fn command(
    engine: &ProjectionEngine,
    current: &Arc<PublishedCut>,
    range: CommandSeqRange,
    stop: &Cancellation,
) -> Result<Applied, PortError> {
    command_with_folders(engine, current, range, stop, &mut None).await
}

pub(super) async fn command_with_folders(
    engine: &ProjectionEngine,
    current: &Arc<PublishedCut>,
    range: CommandSeqRange,
    stop: &Cancellation,
    cached: &mut Option<CommandFolders>,
) -> Result<Applied, PortError> {
    const BUFFERED_NOTE_LIMIT: usize = 200;

    let store = &current.store;
    let scope = &current.cut.scope;
    let ctx = engine.projection_context();
    let after_seq = current.cut.projected_seq;
    let cutoff = range.last_seq;
    let mut watermark = current.watermark.clone();
    watermark.projected_seq = cutoff;
    watermark.updated_at_ms = now_unix_ms()?;

    let mut next = None;
    let mut has_notes = false;
    let mut buffered_notes: Vec<Box<ProjectionNote>> = Vec::new();
    let mut buffered_note_aliases: Vec<ProjectedNoteAlias> = Vec::new();
    let mut notes_spilled = false;
    let mut folder_updates = BTreeMap::new();
    let mut boards = AffectedBoards::default();
    let mut purged = BTreeSet::new();
    let mut schema_change = None;
    let mut folder_aliases = Vec::new();
    let mut has_note_aliases = false;
    let mut thread_changed = false;
    let mut sink = CommandSink::new(store, scope, range.first_seq, cutoff);
    loop {
        check_stop(stop)?;
        let page = engine
            .canonical
            .read_projection_delta_batch(&ctx, scope, after_seq, cutoff, next, page_limit())
            .await?;
        for item in page.rows {
            match item {
                ProjectionDelta::Note(note) => {
                    has_notes = true;
                    if !notes_spilled {
                        if buffered_notes.len() < BUFFERED_NOTE_LIMIT {
                            buffered_notes.push(note);
                        } else {
                            buffered_notes.clear();
                            buffered_note_aliases.clear();
                            notes_spilled = true;
                        }
                    }
                }
                ProjectionDelta::Folder(folder) => {
                    folder_updates.insert(folder.metadata.folder_id.clone(), folder);
                }
                ProjectionDelta::Thread(head) => {
                    thread_changed = true;
                    sink.push(vec![thread_mutation(head, cutoff)]).await?;
                }
                ProjectionDelta::Ability(ability) => {
                    if let Some(note) = ability.note {
                        has_notes = true;
                        if !notes_spilled {
                            if buffered_notes.len() < BUFFERED_NOTE_LIMIT {
                                buffered_notes.push(note);
                            } else {
                                buffered_notes.clear();
                                buffered_note_aliases.clear();
                                notes_spilled = true;
                            }
                        }
                    }
                }
                ProjectionDelta::Rank {
                    rank,
                    changes_placement,
                } => {
                    boards.record(&rank, changes_placement);
                    let mutation = if rank.metadata.removed {
                        let (view, key, target) = rank.key();
                        DerivedMutation::DeleteRank(view, key, target)
                    } else {
                        DerivedMutation::UpsertViewRank(rank_row(scope, rank)?)
                    };
                    sink.push(vec![mutation]).await?;
                }
                ProjectionDelta::Schema(schema) => schema_change = Some(schema),
                ProjectionDelta::Alias(alias) => {
                    let mutation = alias_mutation(scope, alias);
                    match &mutation {
                        DerivedMutation::UpsertFolderAlias(row) => folder_aliases.push(row.clone()),
                        DerivedMutation::UpsertNoteAlias(row) => {
                            has_note_aliases = true;
                            if !notes_spilled {
                                if buffered_note_aliases.len() < BUFFERED_NOTE_LIMIT {
                                    buffered_note_aliases.push(row.clone());
                                } else {
                                    buffered_notes.clear();
                                    buffered_note_aliases.clear();
                                    notes_spilled = true;
                                }
                            }
                        }
                        _ => unreachable!("an alias yields its matching derived record"),
                    }
                    sink.push(vec![mutation]).await?;
                }
                ProjectionDelta::Purge(note) => {
                    purged.insert(note);
                }
            }
        }
        next = page.next;
        if next.is_none() {
            break;
        }
    }

    let structural_change = has_notes
        || has_note_aliases
        || !purged.is_empty()
        || !folder_updates.is_empty()
        || !folder_aliases.is_empty()
        || schema_change.is_some();

    let (fields, mut delta, mut replay, bulk_folder_move, links) =
        if !structural_change {
            // Pure chat / board-rank commands leave folders, notes, links and L0
            // postings unchanged; skip topology loading and mmap opening.
            (
                Arc::clone(&current.fields),
                Some((*current.delta).clone()),
                replay::ChangedSlots::default(),
                false,
                link_apply::LinkApply::default(),
            )
        } else {
            let changed_folders = folder_updates.keys().cloned().collect::<Vec<_>>();
            let topology_changed = !folder_updates.is_empty() || !folder_aliases.is_empty();
            let mut aliases = if cached.is_none() || topology_changed {
                load_folder_aliases(store, scope, after_seq).await?
            } else {
                Vec::new()
            };
            let CommandFolders {
                rows: mut folders,
                topology: old_topology,
            } = match cached.take() {
                Some(known) => known,
                None => {
                    let rows = load_folders(store, scope, after_seq).await?;
                    let topology = link_apply::build_topology(
                        &watermark.root_folder_id,
                        &rows,
                        aliases.iter().cloned(),
                    )?;
                    CommandFolders { rows, topology }
                }
            };
            // Ordinary note edits change counts only on their old and new ancestors.
            let mut previous_counts = BTreeMap::new();
            let old_folders = (topology_changed || schema_change.is_some() || !purged.is_empty())
                .then(|| FolderCatalog {
                    rows: folders.rows.clone(),
                });
            let new_topology = if topology_changed {
                aliases.extend(folder_aliases);
                for folder in folder_updates.into_values() {
                    folders.put(scope, folder, &mut watermark.next_dense_folder_id, None)?;
                }
                folders.refresh_paths()?;
                Some(link_apply::build_topology(
                    &watermark.root_folder_id,
                    &folders,
                    aliases,
                )?)
            } else {
                None
            };
            let topology = new_topology.as_ref().unwrap_or(&old_topology);
            let old_folders_ref = old_folders.as_ref();
            let fields = if let Some(schema) = &schema_change {
                watermark.schema = schema.as_ref().map(persisted_schema).transpose()?;
                Arc::new(
                    schema
                        .as_ref()
                        .map(|schema| schema.fields.clone())
                        .unwrap_or_default(),
                )
            } else {
                Arc::clone(&current.fields)
            };
            let mut delta = Some((*current.delta).clone());
            let mut replay = replay::ChangedSlots::default();
            let index = engine.open_index_async(current).await?;
            let mut link_stage =
                link_apply::LinkStage::new(store, scope.clone(), &old_topology, topology);
            let mut pending = croaring::Bitmap::new();
            for note_id in &purged {
                let old = store.note_by_id(scope, after_seq, note_id).await?;
                if old.is_none() && index.dense_id(note_id).is_some() {
                    // The synchronous erasure barrier already deleted the source data.
                    // Rebuild from the new complete cut rather than guessing old keys.
                    return Err(DomainError::validation(ValidationReason::PurgeResync).into());
                }
                if let Some(row) = &old {
                    pending.add(row.dense_id);
                    count_note_with_location(
                        &mut folders,
                        row,
                        &old_folders_ref
                            .expect("purge saved old folders")
                            .location(&row.parent_folder_id)?,
                        false,
                    )?;
                }
                if let Some(dense) = index.dense_id(note_id)
                    && let Some(delta) = &mut delta
                {
                    delta.remove_note(dense);
                }
                for folder in folders.rows.values_mut() {
                    if folder.cover_note_id.as_ref() == Some(note_id) {
                        folder.cover_note_id = None;
                    }
                }
                link_stage.record_change(old.as_ref(), None, None).await?;
                sink.push(vec![DerivedMutation::PurgeNote(note_id.clone())])
                    .await?;
            }

            if has_notes || has_note_aliases {
                if !notes_spilled {
                    for alias in &buffered_note_aliases {
                        link_stage.record_alias(alias)?;
                    }
                    for note in buffered_notes {
                        check_stop(stop)?;
                        apply_command_note(
                            engine,
                            store,
                            scope,
                            after_seq,
                            cutoff,
                            *note,
                            &purged,
                            old_folders_ref,
                            &mut previous_counts,
                            &mut folders,
                            &fields,
                            &mut watermark,
                            &mut delta,
                            &mut replay,
                            &mut pending,
                            &mut link_stage,
                            &mut sink,
                        )
                        .await?;
                    }
                } else {
                    let mut page_after = None;
                    loop {
                        check_stop(stop)?;
                        let page = engine
                            .canonical
                            .read_projection_delta_batch(
                                &ctx,
                                scope,
                                after_seq,
                                cutoff,
                                page_after,
                                page_limit(),
                            )
                            .await?;
                        for item in page.rows {
                            let note = match item {
                                ProjectionDelta::Note(note) => note,
                                ProjectionDelta::Ability(ability) => match ability.note {
                                    Some(note) => note,
                                    None => continue,
                                },
                                ProjectionDelta::Alias(alias @ ProjectionAlias::Note(_)) => {
                                    if let DerivedMutation::UpsertNoteAlias(row) =
                                        alias_mutation(scope, alias)
                                    {
                                        link_stage.record_alias(&row)?;
                                    }
                                    continue;
                                }
                                _ => continue,
                            };
                            apply_command_note(
                                engine,
                                store,
                                scope,
                                after_seq,
                                cutoff,
                                *note,
                                &purged,
                                old_folders_ref,
                                &mut previous_counts,
                                &mut folders,
                                &fields,
                                &mut watermark,
                                &mut delta,
                                &mut replay,
                                &mut pending,
                                &mut link_stage,
                                &mut sink,
                            )
                            .await?;
                        }
                        page_after = page.next;
                        if page_after.is_none() {
                            break;
                        }
                    }
                }
            }

            let mut bulk_folder_move = false;
            if schema_change.is_none()
                && !has_notes
                && purged.is_empty()
                && boards.is_empty()
                && !has_note_aliases
                && !thread_changed
                && let Some(delta) = &mut delta
                && let Some(old_folders_ref) = old_folders_ref
            {
                bulk_folder_move = folder_move::apply_active_move(
                    old_folders_ref,
                    &mut folders,
                    &changed_folders,
                    &index,
                    delta,
                )?;
            }
            if !bulk_folder_move && (schema_change.is_some() || !changed_folders.is_empty()) {
                let old_folders_ref =
                    old_folders_ref.expect("folder or schema changes saved old folders");
                let mut affected = croaring::Bitmap::new();
                if schema_change.is_none() {
                    for folder in changed_folders {
                        let Some(old) = old_folders_ref.rows.get(&folder) else {
                            continue;
                        };
                        let Some(new) = folders.rows.get(&folder) else {
                            continue;
                        };
                        if old.parent_folder_id != new.parent_folder_id
                            || old.lifecycle != new.lifecycle
                        {
                            affected.or_inplace(
                                &index
                                    .posting(&PostingKey::FolderSubtree(old.dense_folder_id))
                                    .map_err(checkpoint_error)?,
                            );
                        }
                    }
                }
                let mut rows = affected.iter();
                let mut after = None;
                loop {
                    check_stop(stop)?;
                    let page = if schema_change.is_some() {
                        store
                            .notes_page(scope, after_seq, after, page_limit())
                            .await?
                    } else {
                        let mut keys = rows.by_ref().take(200).collect::<Vec<_>>();
                        if keys.is_empty() {
                            break;
                        }
                        keys.retain(|dense| !pending.contains(*dense));
                        if keys.is_empty() {
                            continue;
                        }
                        store
                            .hydrate(scope, after_seq, &keys)
                            .await?
                            .into_iter()
                            .flatten()
                            .collect()
                    };
                    if page.is_empty() {
                        break;
                    }
                    after = page.last().map(|row| row.dense_id);
                    for mut row in page
                        .into_iter()
                        .filter(|row| !pending.contains(row.dense_id))
                    {
                        let old = old_folders_ref.location(&row.parent_folder_id)?;
                        let current = folders.location(&row.parent_folder_id)?;
                        if old.trashed != current.trashed || old.ids != current.ids {
                            count_note_with_location(&mut folders, &row, &old, false)?;
                            count_note_with_location(&mut folders, &row, &current, true)?;
                        }
                        if old.trashed != current.trashed {
                            link_stage
                                .record_change(Some(&row), Some(&row), None)
                                .await?;
                        }
                        let views = schema_change
                            .is_some()
                            .then(|| reevaluate(&mut row, &fields))
                            .transpose()?;
                        if let Some(active) = &mut delta
                            && (views.is_some()
                                || old.dense != current.dense
                                || old.trashed != current.trashed)
                        {
                            index_note(&row, &current, |note| active.replace_note(note))?;
                            replay.note(row.dense_id);
                        }
                        enforce_l0_budget(&mut delta);
                        if let Some(views) = views {
                            sink.push(note_mutations(
                                NoteProjection {
                                    row,
                                    views,
                                    links: Vec::new(),
                                },
                                watermark.schema.as_ref(),
                            )?)
                            .await?;
                        }
                    }
                }
            }
            let changed_rows: Vec<_> = if let Some(old) = old_folders {
                folders
                    .rows
                    .iter()
                    .filter_map(|(id, row)| (old.rows.get(id) != Some(row)).then_some(row))
                    .collect()
            } else {
                previous_counts
                    .iter()
                    .filter_map(|(id, count)| {
                        folders
                            .rows
                            .get(id)
                            .filter(|row| row.active_note_count != *count)
                    })
                    .collect()
            };
            for folder in changed_rows {
                if let Some(active) = &mut delta {
                    active
                        .replace_folder(folder.dense_folder_id, &folder.folder_id, folder.lifecycle)
                        .map_err(checkpoint_error)?;
                    replay.folder(folder.dense_folder_id);
                }
                enforce_l0_budget(&mut delta);
                sink.push(vec![DerivedMutation::UpsertFolder(folder.clone())])
                    .await?;
            }
            let links = link_stage.finish(&mut sink, stop).await?;
            *cached = Some(CommandFolders {
                rows: folders,
                topology: new_topology.unwrap_or(old_topology),
            });
            (fields, delta, replay, bulk_folder_move, links)
        };
    delta_chats(engine, scope, after_seq, cutoff, &mut sink, stop).await?;
    check_stop(stop)?;
    // Large bitmap-wide moves and erasures rebuild from current derived rows.
    let slots = if delta.is_some() && purged.is_empty() && !bulk_folder_move {
        replay.edges(&links.outgoing, &links.incoming);
        replay.encode()
    } else {
        None
    };
    sink.publish(&watermark, Some(after_seq), slots).await?;
    #[cfg(any(test, feature = "test-support"))]
    {
        let generation = engine.generation.load();
        if generation.store.generation() == store.generation()
            && let Some(slot) = generation.slot(&scope.space_id)
            && let Some(error) = slot
                .benchmark_pause
                .inject_failure(super::benchmark::FailurePoint::AfterPublish, cutoff)
        {
            return Err(error);
        }
    }

    if let Some(active) = &mut delta {
        if link_apply::reload_adjacency(store, scope, cutoff, active, &links).await? {
            active.record_events(u32::try_from(cutoff.get() - after_seq.get()).unwrap_or(u32::MAX));
        } else {
            delta = None;
        }
    }
    enforce_l0_budget(&mut delta);
    let force_checkpoint = delta.is_none();
    let mut cut = Arc::new(PublishedCut {
        handoff_graph_source: Weak::new(),
        slot: current.slot.clone(),
        cut: SnapshotCut {
            scope: scope.clone(),
            generation: store.generation(),
            projected_seq: cutoff,
            canonical_seq: cutoff,
        },
        root_folder_id: watermark.root_folder_id.clone(),
        store: store.clone(),
        fields,
        live: current.live.clone(),
        base: current.base.clone(),
        delta: Arc::new(delta.unwrap_or_default()),
        watermark,
    });
    if !purged.is_empty()
        || force_checkpoint
        || cut.delta.should_checkpoint(std::time::Instant::now())
    {
        if !purged.is_empty() {
            engine.reads.invalidate_history(scope);
        }
        cut = checkpoint(engine, &cut, !purged.is_empty(), stop).await?;
    }
    let mut events = Vec::new();
    if !purged.is_empty() && cut.watermark.graph_settled_seq > current.watermark.graph_settled_seq {
        events.push(SpaceEventKind::GraphSettled {
            generation: cut.cut.generation,
        });
    }
    Ok(Applied {
        cut,
        graph_changes: links.graph_changes,
        events,
        boards,
    })
}

#[allow(clippy::too_many_arguments)]
async fn apply_command_note(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    after_seq: SpaceSeq,
    cutoff: SpaceSeq,
    note: ProjectionNote,
    purged: &BTreeSet<NoteId>,
    old_folders: Option<&FolderCatalog>,
    previous_counts: &mut BTreeMap<FolderId, u64>,
    folders: &mut FolderCatalog,
    fields: &BTreeMap<String, notarium_core::query::FieldSchema>,
    watermark: &mut ProjectionWatermark,
    delta: &mut Option<L0Delta>,
    replay: &mut replay::ChangedSlots,
    pending: &mut croaring::Bitmap,
    link_stage: &mut link_apply::LinkStage<'_>,
    sink: &mut CommandSink<'_>,
) -> Result<(), PortError> {
    let id = &note.metadata.note_id;
    if purged.contains(id) || !link_stage.first_note(id)? {
        return Ok(());
    }
    let old = store.note_by_id(scope, after_seq, id).await?;
    let dense = match &old {
        Some(old) => {
            let location = old_folders
                .unwrap_or(folders)
                .location(&old.parent_folder_id)?;
            remember_counts(folders, &location, previous_counts);
            count_note_with_location(folders, old, &location, false)?;
            old.dense_id
        }
        None => allocate_dense(&mut watermark.next_dense_id)?,
    };
    let outcome = prepare_note(engine, scope, cutoff, note, dense, folders, fields).await?;
    let location = folders.location(&outcome.row.parent_folder_id)?;
    remember_counts(folders, &location, previous_counts);
    count_note_with_location(folders, &outcome.row, &location, true)?;
    if let Some(active) = delta {
        index_note(&outcome.row, &location, |note| active.replace_note(note))?;
        replay.note(dense);
    }
    enforce_l0_budget(delta);
    pending.add(dense);
    link_stage
        .record_change(old.as_ref(), Some(&outcome.row), Some(&outcome.links))
        .await?;
    sink.push(note_mutations(outcome, watermark.schema.as_ref())?)
        .await
}

fn enforce_l0_budget(delta: &mut Option<L0Delta>) {
    if delta
        .as_ref()
        .is_some_and(|delta| delta.approx_bytes() >= crate::index::L0_BYTE_LIMIT)
    {
        *delta = None;
    }
}

async fn prepare_note(
    engine: &ProjectionEngine,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    note: ProjectionNote,
    dense: u32,
    folders: &FolderCatalog,
    fields: &BTreeMap<String, notarium_core::query::FieldSchema>,
) -> Result<NoteProjection, PortError> {
    let location = folders.location(&note.metadata.parent_folder_id)?;
    let source = engine
        .canonical
        .read_projection_note_carrier(&engine.projection_context(), scope, cutoff, &note)
        .await?;
    project_note(scope, note, dense, &location, source.as_deref(), fields)
}

fn remember_counts(
    folders: &FolderCatalog,
    location: &super::records::FolderLocation,
    before: &mut BTreeMap<FolderId, u64>,
) {
    for id in &location.ids {
        if let Some(row) = folders.rows.get(id) {
            before.entry(id.clone()).or_insert(row.active_note_count);
        }
    }
}

fn count_note(
    folders: &mut FolderCatalog,
    row: &crate::derived::ProjectedNote,
    add: bool,
) -> Result<(), PortError> {
    let location = folders.location(&row.parent_folder_id)?;
    count_note_with_location(folders, row, &location, add)
}

fn count_note_with_location(
    folders: &mut FolderCatalog,
    note: &crate::derived::ProjectedNote,
    location: &super::records::FolderLocation,
    add: bool,
) -> Result<(), PortError> {
    if note.lifecycle != Lifecycle::Active
        || location.trashed
        || note.doc_class == notarium_core::classes::DocClass::EncryptedNote
    {
        return Ok(());
    }
    for id in &location.ids {
        if let Some(folder) = folders.rows.get_mut(id) {
            folder.active_note_count = if add {
                folder.active_note_count.checked_add(1)
            } else {
                folder.active_note_count.checked_sub(1)
            }
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
        }
    }
    Ok(())
}

fn note_mutations(
    note: NoteProjection,
    schema: Option<&crate::derived::ProjectionSchema>,
) -> Result<Vec<DerivedMutation>, PortError> {
    let mut mutations = Vec::with_capacity(note.views.descriptors.len() + 2);
    mutations.push(DerivedMutation::DeleteDescriptors(note.row.note_id.clone()));
    mutations.extend(
        descriptors(&note.row, note.views, schema)?
            .into_iter()
            .map(DerivedMutation::UpsertViewDescriptor),
    );
    mutations.push(DerivedMutation::UpsertNote(Box::new(note.row)));
    Ok(mutations)
}

fn alias_mutation(scope: &HistoryScope, alias: ProjectionAlias) -> DerivedMutation {
    match alias {
        ProjectionAlias::Note(row) => DerivedMutation::UpsertNoteAlias(ProjectedNoteAlias {
            space_id: scope.space_id.clone(),
            old_parent_folder_id: row.old_parent_folder_id,
            old_slug_fold: row.old_slug_fold,
            old_title_norm: row.old_title_norm,
            created_seq: row.created_seq,
            target_note_id: row.target_note_id,
        }),
        ProjectionAlias::Folder(row) => DerivedMutation::UpsertFolderAlias(ProjectedFolderAlias {
            space_id: scope.space_id.clone(),
            old_parent_folder_id: row.old_parent_folder_id,
            old_slug_fold: row.old_slug_fold,
            created_seq: row.created_seq,
            target_folder_id: row.target_folder_id,
        }),
    }
}

async fn load_folders(
    store: &DerivedStore,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
) -> Result<FolderCatalog, PortError> {
    let mut folders = FolderCatalog::default();
    let mut after = None;
    loop {
        let page = store
            .folders_page(scope, cutoff, after, page_limit())
            .await?;
        let Some(last) = page.last() else { break };
        after = Some(last.dense_folder_id);
        for row in page {
            folders.rows.insert(row.folder_id.clone(), row);
        }
    }
    Ok(folders)
}

async fn seed_chats(
    engine: &ProjectionEngine,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    stage: &mut Stage<'_>,
    stop: &Cancellation,
) -> Result<(), PortError> {
    let ctx = engine.projection_context();
    let mut after = None;
    loop {
        check_stop(stop)?;
        let rows = engine
            .canonical
            .read_projection_chat_heads_page(&ctx, scope, cutoff, after.as_ref(), page_limit())
            .await?;
        after = rows.last().map(|head| head.thread.id.clone());
        stage
            .push(
                rows.into_iter()
                    .map(|head| thread_mutation(head, cutoff))
                    .collect(),
            )
            .await?;
        if after.is_none() {
            break;
        }
    }
    let mut position = None;
    loop {
        check_stop(stop)?;
        let page = engine
            .canonical
            .read_projection_chat_refs_page(
                &ctx,
                scope,
                cutoff,
                position,
                ProjectionChatRefLimits::default(),
            )
            .await?;
        stage
            .push(page.refs.into_iter().map(chat_ref_mutation).collect())
            .await?;
        position = page.next;
        if position.is_none() {
            break;
        }
    }
    Ok(())
}

async fn repair_incoming_chats(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    target: &HistoryScope,
    stop: &Cancellation,
) -> Result<(), PortError> {
    let canonical = &engine.canonical;
    let ctx = engine.projection_context();
    for (_, source, _, _) in canonical.list_spaces(&ctx).await? {
        if source.space_id == target.space_id {
            continue;
        }
        check_stop(stop)?;
        let source = match canonical
            .read_projection_space_header(&ctx, &source.space_id, None)
            .await
        {
            Ok(header) => header,
            Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
            Err(error) => return Err(error),
        };
        match store.register_scope(&source.scope).await {
            Ok(()) => {}
            // Another worker is rebinding this source. Its new seed owns
            // rebuilding outgoing occurrences in the new history.
            Err(error) if is_history_mismatch(&error) => continue,
            Err(error) => return Err(error),
        }
        let mut position = None;
        loop {
            check_stop(stop)?;
            let page = async {
                let page = canonical
                    .read_projection_incoming_chat_refs_page(
                        &ctx,
                        &source.scope,
                        source.cutoff,
                        target,
                        position,
                        ProjectionChatRefLimits::default(),
                    )
                    .await?;
                store
                    .repair_incoming_chat_refs(
                        target,
                        &source.scope,
                        page.refs.into_iter().map(projected_chat_ref).collect(),
                    )
                    .await?;
                Ok::<_, PortError>(page.next)
            }
            .await;
            position = match page {
                Ok(next) => next,
                Err(error) if is_history_mismatch(&error) => {
                    // A source changed while the scan was in progress. Its
                    // own rebind will replace the erased outgoing identities.
                    // An obsolete target must never be published.
                    let current = canonical
                        .read_projection_space_header(&ctx, &target.space_id, None)
                        .await?;
                    target.check(&current.scope)?;
                    break;
                }
                Err(error) => return Err(error),
            };
            if position.is_none() {
                break;
            }
        }
    }
    Ok(())
}

async fn delta_chats(
    engine: &ProjectionEngine,
    scope: &HistoryScope,
    after: SpaceSeq,
    cutoff: SpaceSeq,
    sink: &mut CommandSink<'_>,
    stop: &Cancellation,
) -> Result<(), PortError> {
    let ctx = engine.projection_context();
    let mut position = None;
    loop {
        check_stop(stop)?;
        let page = engine
            .canonical
            .read_projection_chat_changes_page(
                &ctx,
                scope,
                after,
                cutoff,
                position.as_ref(),
                page_limit(),
            )
            .await?;
        for change in page.changes {
            if change.removed {
                sink.push(vec![DerivedMutation::RedactChatEntry(
                    change.entry.thread,
                    change.entry.seq,
                )])
                .await?;
                continue;
            }
            let mut entry_position = None;
            loop {
                check_stop(stop)?;
                let page = engine
                    .canonical
                    .read_projection_chat_entry_refs_page(
                        &ctx,
                        scope,
                        cutoff,
                        &change.entry,
                        entry_position,
                        ProjectionChatRefLimits::default(),
                    )
                    .await?;
                sink.push(page.refs.into_iter().map(chat_ref_mutation).collect())
                    .await?;
                entry_position = page.next;
                if entry_position.is_none() {
                    break;
                }
            }
        }
        position = page.next;
        if position.is_none() {
            break;
        }
    }
    Ok(())
}

fn thread_mutation(head: ProjectionChatHead, cutoff: SpaceSeq) -> DerivedMutation {
    let thread = head.thread;
    DerivedMutation::UpsertChatThread(ProjectedChatThread {
        space_id: thread.space,
        thread_id: thread.id,
        kind: thread.kind,
        owner_id: thread.owner,
        project_folder_id: thread.project_folder,
        tainted: thread.tainted,
        updated_seq: cutoff,
    })
}

fn chat_ref_mutation(row: ProjectionChatRef) -> DerivedMutation {
    DerivedMutation::UpsertChatRef(projected_chat_ref(row))
}

fn projected_chat_ref(row: ProjectionChatRef) -> ProjectedChatRef {
    ProjectedChatRef {
        target_space_id: row.target.space_id,
        target_note_id: row.target.note_id,
        thread_space_id: row.locator.source.space_id,
        thread_id: row.locator.entry.thread,
        entry_seq: row.locator.entry.seq,
        source_incarnation: row.locator.source.incarnation,
        target_incarnation: row.target_scope.incarnation,
        source_revision: row.locator.revision,
        ref_ordinal: u64::from(row.locator.ref_ordinal),
    }
}

const DIRECT_MUTATION_LIMIT: usize = 4_096;

/// Accumulates incremental command mutations directly in memory for single-tx
/// apply, spilling transparently to `Stage` only for unusually large commands.
pub(super) enum CommandSink<'a> {
    Direct {
        store: &'a DerivedStore,
        key: StageKey,
        mutations: Vec<DerivedMutation>,
        bytes: usize,
    },
    Staged(Stage<'a>),
}

impl<'a> CommandSink<'a> {
    fn new(store: &'a DerivedStore, scope: &HistoryScope, first: SpaceSeq, last: SpaceSeq) -> Self {
        Self::Direct {
            store,
            key: StageKey {
                scope: scope.clone(),
                first,
                last,
            },
            mutations: Vec::new(),
            bytes: 0,
        }
    }

    pub(super) async fn push(&mut self, mutations: Vec<DerivedMutation>) -> Result<(), PortError> {
        if mutations.is_empty() {
            return Ok(());
        }
        match self {
            Self::Direct {
                store,
                key,
                mutations: pending,
                bytes,
            } => {
                let size = mutations.iter().fold(*bytes, |sum, row| {
                    sum.saturating_add(crate::derived::approx_mutation_bytes(row))
                });
                if pending.len().saturating_add(mutations.len()) <= DIRECT_MUTATION_LIMIT
                    && size <= crate::derived::MAX_STAGE_BYTES
                {
                    *bytes = size;
                    pending.extend(mutations);
                    return Ok(());
                }
                let store = *store;
                let key = key.clone();
                let existing = std::mem::take(pending);
                store.discard_staging(&key.scope).await?;
                let mut stage = Stage::new(store, &key.scope, key.first, key.last);
                stage.push(existing).await?;
                stage.push(mutations).await?;
                *self = Self::Staged(stage);
                Ok(())
            }
            Self::Staged(stage) => stage.push(mutations).await,
        }
    }

    async fn publish(
        self,
        watermark: &ProjectionWatermark,
        expected: Option<SpaceSeq>,
        slots: Option<Vec<u8>>,
    ) -> Result<(), PortError> {
        match self {
            Self::Direct {
                store, mutations, ..
            } => {
                store
                    .apply_with_replay(
                        &SpaceApply {
                            expected,
                            watermark: watermark.clone(),
                            mutations,
                        },
                        slots,
                    )
                    .await
            }
            Self::Staged(stage) => stage.publish(watermark, expected, slots).await,
        }
    }
}

pub(super) struct Stage<'a> {
    store: &'a DerivedStore,
    key: StageKey,
    pages: u64,
    buffered: StageBuffer,
}

impl<'a> Stage<'a> {
    fn new(store: &'a DerivedStore, scope: &HistoryScope, first: SpaceSeq, last: SpaceSeq) -> Self {
        Self {
            store,
            key: StageKey {
                scope: scope.clone(),
                first,
                last,
            },
            pages: 0,
            buffered: StageBuffer::default(),
        }
    }

    pub(super) async fn push(&mut self, mutations: Vec<DerivedMutation>) -> Result<(), PortError> {
        for mutation in mutations {
            if self.buffered.push(&self.key, &mutation)? {
                continue;
            }
            self.flush().await?;
            if !self.buffered.push(&self.key, &mutation)? {
                self.store
                    .stage_single(&self.key, self.pages, &mutation)
                    .await?;
                self.pages += 1;
            }
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), PortError> {
        if !self.buffered.is_empty() {
            self.store
                .stage_buffer(&self.key, self.pages, std::mem::take(&mut self.buffered))
                .await?;
            self.pages += 1;
        }
        Ok(())
    }

    async fn publish(
        mut self,
        watermark: &ProjectionWatermark,
        expected: Option<SpaceSeq>,
        slots: Option<Vec<u8>>,
    ) -> Result<(), PortError> {
        self.flush().await?;
        self.store
            .publish_staged_with_replay(&self.key, self.pages, watermark, expected, slots)
            .await
    }
}

pub(super) async fn checkpoint(
    engine: &ProjectionEngine,
    current: &Arc<PublishedCut>,
    settle: bool,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    let slot = current
        .slot
        .upgrade()
        .ok_or_else(|| DomainError::validation(ValidationReason::NotReady))?;
    slot.check_attached()?;
    if current.watermark.snapshot_seq == current.cut.projected_seq {
        if settle && current.watermark.graph_settled_seq < current.cut.projected_seq {
            return graph_settle::settle_mapped_cut(engine, current, stop).await;
        }
        return Ok(Arc::clone(current));
    }
    let mut watermark = current.watermark.clone();
    if !reclaim_unpublished_head(engine, &current.store, &watermark).await? {
        return Err(DomainError::validation(ValidationReason::NotReady).into());
    }
    // A forced compaction has discarded L0, including any settlement newer
    // than the mmap. Use durable memberships when no complete overlay remains.
    let previous = if current.delta.is_empty() {
        None
    } else {
        engine.open_index_async(current).await.ok()
    };
    let base = write_checkpoint(
        engine,
        &current.store,
        &mut watermark,
        previous.as_ref(),
        settle,
        stop,
    )
    .await?;
    let next = publish_cut(
        engine,
        &current.store,
        &slot,
        watermark,
        base,
        L0Delta::default(),
    )
    .await?;
    if current.base.path() != next.base.path() {
        current.base.retire(&engine.pool);
    }
    Ok(next)
}

async fn reclaim_unpublished_head(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
) -> Result<bool, PortError> {
    if watermark.projected_seq <= watermark.snapshot_seq {
        return Ok(true);
    }
    let maintenance = Arc::clone(&engine.generation_cleanup).lock_owned().await;
    store
        .forget_unpublished_checkpoint(
            watermark,
            u32::from(crate::mmap::FORMAT_VERSION),
            crate::mmap::platform_abi(),
            engine.cache_identity.clone(),
        )
        .await?;
    let seq = watermark.projected_seq;
    let space = watermark.scope.space_id.clone();
    let path = engine
        .cache_root
        .space_fast_index(store.generation(), &space, seq);
    let canonical = engine.canonical.clone();
    let ctx = engine.projection_context();
    tokio::task::spawn_blocking(move || {
        let _maintenance = maintenance;
        canonical.check_projection_writer_candidate(&ctx, &space)?;
        BaseIndexHandle::discard_unpublished_name(&path, seq).map_err(checkpoint_error)
    })
    .await
    .map_err(checkpoint_error)?
}

async fn write_checkpoint(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    watermark: &mut ProjectionWatermark,
    previous: Option<&IndexView>,
    settle: bool,
    stop: &Cancellation,
) -> Result<BaseIndexHandle, PortError> {
    let scope = &watermark.scope;
    let cutoff = watermark.projected_seq;
    let folders = load_folders(store, scope, cutoff).await?;
    let identity = IndexIdentity {
        generation: store.generation(),
        scope: scope.clone(),
        seq: cutoff,
    };
    let mut builder = FastIndexBuilder::default();
    builder.reserve_dense(
        u32::try_from(watermark.next_dense_id).map_err(checkpoint_error)?,
        u32::try_from(watermark.next_dense_folder_id).map_err(checkpoint_error)?,
    );
    for folder in folders.rows.values() {
        builder
            .add_folder(folder.dense_folder_id, &folder.folder_id, folder.lifecycle)
            .map_err(checkpoint_error)?;
    }
    let mut graph_notes = vec![None; watermark.next_dense_id as usize];
    let mut graph_effective = croaring::Bitmap::new();
    let mut after = None;
    loop {
        check_stop(stop)?;
        let page = store.notes_page(scope, cutoff, after, page_limit()).await?;
        after = page.last().map(|row| row.dense_id);
        for row in page {
            let location = folders.location(&row.parent_folder_id)?;
            index_note(&row, &location, |note| builder.add_note(note))?;
            if row.lifecycle == Lifecycle::Active
                && !location.trashed
                && row.doc_class != notarium_core::classes::DocClass::EncryptedNote
            {
                graph_effective.add(row.dense_id);
                let slot = graph_notes
                    .get_mut(row.dense_id as usize)
                    .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
                *slot = Some(row.note_id);
            }
        }
        if after.is_none() {
            break;
        }
    }
    let graph = link_apply::collect_graph_sections(
        store,
        watermark,
        graph_notes,
        graph_effective,
        previous,
        settle,
        stop,
    )
    .await?;
    builder.set_graph(graph.sections);
    let prepared = tokio::task::spawn_blocking(move || builder.prepare(identity))
        .await
        .map_err(checkpoint_error)?
        .map_err(checkpoint_error)?;
    let (base, trusted) = publish_checkpoint_file(engine, store, prepared).await?;
    store
        .register_checkpoint(&TrustedCheckpoint {
            space_id: scope.space_id.clone(),
            history_incarnation: scope.incarnation,
            seq: cutoff,
            format_version: u32::from(crate::mmap::FORMAT_VERSION),
            platform_abi: trusted.abi,
            publication_id: engine.cache_identity.clone(),
            size_bytes: trusted.size,
            digest: ContentDigest::from_bytes(trusted.digest),
            graph_seq: if settle {
                cutoff
            } else {
                watermark.graph_settled_seq
            },
        })
        .await?;
    watermark.snapshot_seq = cutoff;
    if settle {
        watermark.graph_settled_seq = cutoff;
    }
    store
        .apply(&SpaceApply {
            expected: Some(cutoff),
            watermark: watermark.clone(),
            mutations: graph.mutations,
        })
        .await?;
    base.finish_publication().map_err(checkpoint_error)?;
    Ok(base)
}

pub(super) async fn publish_checkpoint_file(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    prepared: PreparedCheckpoint,
) -> Result<(BaseIndexHandle, MmapTrust), PortError> {
    let IndexIdentity {
        generation,
        scope,
        seq,
    } = prepared.identity();
    if *generation != store.generation() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let maintenance = Arc::clone(&engine.generation_cleanup).lock_owned().await;
    store.validate_checkpoint_publication(scope, *seq).await?;
    engine
        .canonical
        .check_projection_writer_candidate(&engine.projection_context(), &scope.space_id)?;
    let path = engine
        .cache_root
        .space_fast_index(*generation, &scope.space_id, *seq);
    let pool = engine.pool.clone();
    let cache_lease = store.cache_lease()?;
    let cache_owner = engine.postgres_cache_owner.clone();
    // The blocking operation retains the maintenance permit and cache
    // ownership even if cancelled. The published lease retains ownership too.
    tokio::task::spawn_blocking(move || {
        let _maintenance = maintenance;
        let _cache_lease = cache_lease;
        mmap::publish(prepared, &path, Some(&pool), cache_owner)
    })
    .await
    .map_err(checkpoint_error)?
    .map_err(checkpoint_error)
}

async fn open_checkpoint(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
    previous: Option<&BaseIndexHandle>,
) -> Result<Option<(BaseIndexHandle, SpaceSeq)>, PortError> {
    let scope = &watermark.scope;
    let seq = watermark.snapshot_seq;
    let record = store
        .trusted_checkpoint(
            scope,
            seq,
            u32::from(crate::mmap::FORMAT_VERSION),
            &crate::mmap::platform_abi(),
            &engine.cache_identity,
        )
        .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    let path = engine
        .cache_root
        .space_fast_index(store.generation(), &scope.space_id, seq);
    let identity = IndexIdentity {
        generation: store.generation(),
        scope: scope.clone(),
        seq,
    };
    let trust = MmapTrust {
        size: record.size_bytes,
        digest: *record.digest.as_bytes(),
        abi: record.platform_abi.clone(),
    };
    let cache_owner = engine.postgres_cache_owner.clone();
    let previous = previous.cloned();
    let pool = engine.pool.clone();
    let graph_seq = record.graph_seq;
    let settled_seq = watermark.graph_settled_seq;
    let opened = tokio::task::spawn_blocking(move || {
        let rebound = BaseIndexHandle::restore(&path, identity, trust, cache_owner)
            .map_err(checkpoint_error)?;
        let base = previous
            .filter(|handle| handle.same_writer_file(&rebound))
            .unwrap_or(rebound);
        base.register_for_erasure(&pool);
        let valid = graph_seq <= settled_seq && base.open(&pool).is_ok();
        Ok::<_, PortError>(valid.then_some(base))
    })
    .await
    .map_err(checkpoint_error)??;
    let Some(base) = opened else {
        store.forget_checkpoint(&record).await?;
        return Ok(None);
    };
    Ok(Some((base, graph_seq)))
}

async fn publish_cut(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    slot: &Arc<SpaceSlot>,
    watermark: ProjectionWatermark,
    base: BaseIndexHandle,
    delta: L0Delta,
) -> Result<Arc<PublishedCut>, PortError> {
    slot.check_attached()?;
    let scope = &watermark.scope;
    base.register_for_erasure(&engine.pool);
    let active = store.generation() == engine.generation.load().store.generation();
    let live = if active {
        bind_lookup(engine, store, scope, &base, slot).await?
    } else {
        engine.live_handle(scope)?
    };
    let head = live.try_read()?.head();
    let fields = watermark
        .schema
        .as_ref()
        .map(|schema| decode(&schema.fields_msgpack))
        .transpose()?
        .unwrap_or_default();
    slot.check_attached()?;
    if active {
        slot.lookup_bound.store(true, Ordering::Release);
    }
    Ok(Arc::new(PublishedCut {
        handoff_graph_source: Weak::new(),
        slot: Arc::downgrade(slot),
        cut: SnapshotCut {
            scope: scope.clone(),
            generation: store.generation(),
            canonical_seq: head,
            projected_seq: watermark.projected_seq,
        },
        root_folder_id: watermark.root_folder_id.clone(),
        watermark,
        store: store.clone(),
        fields: Arc::new(fields),
        live,
        base,
        delta: Arc::new(delta),
    }))
}

async fn bind_lookup(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    base: &BaseIndexHandle,
    slot: &Arc<SpaceSlot>,
) -> Result<LiveSpaceHandle, PortError> {
    let lookup = Arc::new(DenseLookup {
        base: base.clone(),
        pool: engine.pool.clone(),
        slot: Arc::downgrade(slot),
        _cache_lease: store.cache_lease()?,
    });
    engine
        .canonical
        .admit_projection_space_with_lookup(&engine.projection_context(), scope, lookup)
        .await
}

/// A private worker has already validated this durable cut. Adopt its lookup
/// at the owning Space gate before exposing the cut to new readers.
pub(super) async fn bind_prefetched_cut(
    engine: &ProjectionEngine,
    slot: &Arc<SpaceSlot>,
    prefetched: &PublishedCut,
) -> Result<Arc<PublishedCut>, PortError> {
    slot.check_attached()?;
    engine.open_index_async(prefetched).await?;
    let live = bind_lookup(
        engine,
        &prefetched.store,
        &prefetched.cut.scope,
        &prefetched.base,
        slot,
    )
    .await?;
    slot.check_attached()?;
    let mut cut = prefetched.cut.clone();
    cut.canonical_seq = live.try_read()?.head();
    slot.lookup_bound.store(true, Ordering::Release);
    Ok(Arc::new(PublishedCut {
        handoff_graph_source: Weak::new(),
        slot: Arc::downgrade(slot),
        cut,
        watermark: prefetched.watermark.clone(),
        root_folder_id: prefetched.root_folder_id.clone(),
        store: prefetched.store.clone(),
        fields: Arc::clone(&prefetched.fields),
        live,
        base: prefetched.base.clone(),
        delta: Arc::clone(&prefetched.delta),
    }))
}

/// Select the durable generation under the publication gate. The activation
/// broadcast wakes each Space worker separately to admit its lookup.
pub(super) fn activate_generation(engine: &ProjectionEngine, next: &Arc<Generation>) {
    engine.generation.store(Arc::clone(next));
}

async fn discard_checkpoint(
    engine: &ProjectionEngine,
    store: &DerivedStore,
    scope: &HistoryScope,
    slot: &SpaceSlot,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    // A restored history can reuse the same pathname. Serialize the check
    // and unlink against publication by the replacement worker.
    let maintenance = Arc::clone(&engine.generation_cleanup).lock_owned().await;
    slot.check_attached()?;
    let path = engine
        .cache_root
        .space_fast_index(store.generation(), &scope.space_id, seq);
    tokio::task::spawn_blocking(move || {
        let _maintenance = maintenance;
        BaseIndexHandle::discard_unleased(&path).map_err(checkpoint_error)
    })
    .await
    .map_err(checkpoint_error)?
}

struct DenseLookup {
    base: BaseIndexHandle,
    pool: crate::mmap::MmapPool,
    slot: Weak<SpaceSlot>,
    // Canonical authorization can outlive its projector's serving generation.
    // Pin local files only, allowing the old PostgreSQL schema to be reclaimed.
    _cache_lease: Arc<std::fs::File>,
}

impl DenseLookup {
    fn open(&self) -> Option<Arc<crate::mmap::MappedFastIndex>> {
        match self.base.open(&self.pool) {
            Ok(map) => Some(map),
            Err(_) => {
                if let Some(slot) = self.slot.upgrade() {
                    slot.request_repair(&self.base);
                }
                None
            }
        }
    }
}

impl LiveDenseLookup for DenseLookup {
    fn generation(&self) -> Option<ProjectionGeneration> {
        Some(self.base.identity().generation)
    }

    fn published_seq(&self) -> Option<SpaceSeq> {
        Some(self.base.identity().seq)
    }

    fn slots(&self) -> u32 {
        self.open().map_or(0, |index| index.node_count())
    }

    fn dense_id(&self, note: &NoteId) -> Option<u32> {
        self.open()?.lookup(note)
    }
}

pub(super) fn check_stop(stop: &Cancellation) -> Result<(), PortError> {
    if stop.is_cancelled() {
        Err(notarium_canonical::codec::cancelled_not_committed(
            "projection_apply",
            "runtime stopped",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn is_history_mismatch(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch)
}

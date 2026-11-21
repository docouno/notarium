mod spill;

pub(crate) use spill::sweep_scratch_dir;

use serde::{Deserialize, Serialize};
use spill::{Key, Scratch};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::Arc,
};

use croaring::Bitmap;
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceId, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{Cancellation, PageLimit},
};

use crate::{
    derived::{
        CandidateLookupKey, DerivedMutation, DerivedStore, LinkAddress, LinkPosition,
        ProjectedFolderAlias, ProjectedLink, ProjectedNote, ProjectedNoteAlias,
        ProjectionWatermark,
    },
    graph::{GraphBuild, LeidenSnapshot},
    index::{GraphSections, IndexView, L0_BYTE_LIMIT, L0Delta},
    links::{
        AliasKey, CandidatePosition, CandidateQuery, FolderTopology, LinkFolder, LinkNote,
        NoteAliasPosition, ResolutionIndex, candidate_keys, resolve_link, source_link_row,
    },
};

use super::{
    apply::{CommandSink, check_stop},
    checkpoint_error, graph_settle,
    records::{FolderCatalog, NoteProjection, note_raw_fields},
};

const PAGE: u16 = 200;
const GRAPH_EDGE_PAGE: u16 = 1_024;

fn page() -> PageLimit {
    PageLimit::new(PAGE).expect("projection link page is bounded")
}

pub(super) fn build_topology(
    root: &FolderId,
    folders: &FolderCatalog,
    aliases: impl IntoIterator<Item = ProjectedFolderAlias>,
) -> Result<FolderTopology, PortError> {
    Ok(FolderTopology::build(
        root.clone(),
        folders.rows.values().map(|row| LinkFolder {
            id: row.folder_id.clone(),
            dense_id: row.dense_folder_id,
            parent: row.parent_folder_id.clone(),
            slug_fold: row.slug_fold.clone(),
            active: row.lifecycle == Lifecycle::Active,
        }),
        aliases,
    )?)
}

fn convert_note(row: &ProjectedNote) -> Result<LinkNote, PortError> {
    Ok(LinkNote {
        id: row.note_id.clone(),
        dense_id: row.dense_id,
        parent: row.parent_folder_id.clone(),
        slug_fold: row.slug_fold.clone(),
        title: row.title.clone(),
        created_at: row.created_at()?,
        raw_fields: note_raw_fields(row)?.unwrap_or_default(),
        visible: row.lifecycle == Lifecycle::Active && row.doc_class != DocClass::EncryptedNote,
    })
}

/// Cold build accumulates an index and source link targets while card rows are
/// staged. The runtime then drains resolved rows in bounded write pages.
#[cfg_attr(test, derive(Default))]
pub(super) struct ColdLinks {
    index: Scratch,
    after: Option<Key>,
}

impl ColdLinks {
    pub(super) fn new(scratch_dir: PathBuf, stop: Cancellation) -> Self {
        Self {
            index: Scratch::new(scratch_dir, stop),
            after: None,
        }
    }

    pub async fn add_batch(
        &mut self,
        rows: &[NoteProjection],
        folders: &FolderTopology,
    ) -> Result<Vec<DerivedMutation>, PortError> {
        let mut entries = Vec::with_capacity(rows.len() * 4);
        let mut mutations = Vec::with_capacity(rows.len() * 3);
        for projected in rows {
            let row = &projected.row;
            let note = convert_note(row)?;
            if row.lifecycle == Lifecycle::Active {
                entries.push((
                    Scratch::slot_key(&note.parent, &note.slug_fold),
                    Scratch::encode_value(&note.id)?,
                ));
            }
            for key in candidate_keys(&row.space_id, &note, folders) {
                entries.push((Scratch::candidate_key(&key), Scratch::encode_value(&key)?));
                mutations.push(DerivedMutation::UpsertCandidate(key));
            }
            if row.doc_class != DocClass::EncryptedNote && row.lifecycle != Lifecycle::Purged {
                for (ordinal, raw) in projected.links.iter().enumerate() {
                    let ordinal = checked_ordinal(ordinal)?;
                    entries.push((
                        Key::new(spill::COLD_LINK)
                            .number(note.dense_id)
                            .number(ordinal),
                        Scratch::encode_value(&(
                            note.dense_id,
                            &note.parent,
                            note.visible,
                            ordinal,
                            raw,
                        ))?,
                    ));
                }
            }
        }
        self.index.put_batch_async(entries).await?;
        Ok(mutations)
    }

    pub async fn add_note_alias(&mut self, alias: &ProjectedNoteAlias) -> Result<(), PortError> {
        self.index.alias_async(alias).await
    }

    pub async fn resolve_page(
        &mut self,
        space: &SpaceId,
        folders: &Arc<FolderTopology>,
    ) -> Result<Vec<DerivedMutation>, PortError> {
        let space = space.clone();
        let folders = Arc::clone(folders);
        let after = self.after.clone();
        let (mutations, next_after) = self
            .index
            .with_sync_read(move |sync_index| {
                let rows = sync_index.page::<(u32, FolderId, bool, u32, String)>(
                    Key::new(spill::COLD_LINK),
                    after.as_ref(),
                    PAGE,
                )?;
                let Some((last, _)) = rows.last() else {
                    return Ok((Vec::new(), None));
                };
                let next_after = Some(last.clone());
                let mut mutations = Vec::with_capacity(rows.len());
                for (_, (dense, parent, visible, ordinal, raw)) in rows {
                    let mut row = source_link_row(&space, dense, &parent, ordinal, raw, &folders);
                    if visible {
                        poll_sync(resolve_link(&mut row, &folders, sync_index))?;
                    }
                    mutations.push(DerivedMutation::UpsertLink(row));
                }
                Ok((mutations, next_after))
            })
            .await?;
        if let Some(last) = next_after {
            self.after = Some(last);
        }
        Ok(mutations)
    }
}

fn poll_sync<F: std::future::Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(output) => output,
        std::task::Poll::Pending => unreachable!("SyncScratch ResolutionIndex never suspends"),
    }
}

fn checked_ordinal(ordinal: usize) -> Result<u32, PortError> {
    u32::try_from(ordinal)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit).into())
}

#[derive(Serialize, Deserialize)]
struct ScratchSource {
    dense: u32,
    parent: Option<FolderId>,
    visible: bool,
    replace_links: bool,
    replace_candidates: bool,
}

struct CommandIndex<'a> {
    store: &'a DerivedStore,
    added: Scratch,
}

impl CommandIndex<'_> {
    async fn record_leaves(&mut self, leaves: Vec<String>) -> Result<(), PortError> {
        for leaf in leaves {
            self.added
                .put_async(Key::new(spill::LEAF).text(&leaf), &leaf)
                .await?;
        }
        Ok(())
    }
}

impl ResolutionIndex for CommandIndex<'_> {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        let want = usize::from(limit);
        let mem = self.added.candidates(query, after, limit).await?;
        let mut db = Vec::with_capacity(want);
        let mut cursor = after.cloned();
        let fetch_limit = limit.clamp(32, PAGE);
        while db.len() < want {
            let page = self
                .store
                .candidates(query, cursor.as_ref(), fetch_limit)
                .await?;
            let count = page.len();
            cursor = page.last().map(CandidatePosition::from);
            for row in page {
                if !self
                    .added
                    .contains_async(
                        Key::new(spill::CANDIDATES_REPLACED).number(row.target_dense_id),
                    )
                    .await?
                {
                    db.push(row);
                    if db.len() == want {
                        break;
                    }
                }
            }
            if count < usize::from(fetch_limit) {
                break;
            }
        }
        Ok(merge_sorted(mem, db, want, |row| {
            CandidatePosition::from(row)
        }))
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        let want = usize::from(limit);
        let mem = self
            .added
            .aliases(space, selector, leaf, after, limit)
            .await?;
        let db = self
            .store
            .aliases(space, selector, leaf, after, limit)
            .await?;
        Ok(merge_sorted(mem, db, want, |row| {
            NoteAliasPosition::from(row)
        }))
    }

    async fn slot_occupant(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        if let Some(note) = self.added.slot_occupant(space, parent, slug).await? {
            return Ok(Some(note));
        }
        let Some(note) = self.store.slot_occupant(space, parent, slug).await? else {
            return Ok(None);
        };
        Ok((!self
            .added
            .contains_async(Key::new(spill::SLOTS_REPLACED).text(note.as_str()))
            .await?)
            .then_some(note))
    }
}

fn merge_sorted<T, K: Ord>(
    left: Vec<T>,
    right: Vec<T>,
    limit: usize,
    key: impl Fn(&T) -> K,
) -> Vec<T> {
    let mut left = left.into_iter().peekable();
    let mut right = right.into_iter().peekable();
    let mut merged = Vec::with_capacity(limit);
    while merged.len() < limit {
        match (left.peek(), right.peek()) {
            (Some(l), Some(r)) => match key(l).cmp(&key(r)) {
                std::cmp::Ordering::Less => merged.push(left.next().unwrap()),
                std::cmp::Ordering::Greater => merged.push(right.next().unwrap()),
                std::cmp::Ordering::Equal => {
                    merged.push(left.next().unwrap());
                    let _ = right.next();
                }
            },
            (Some(_), None) => merged.push(left.next().unwrap()),
            (None, Some(_)) => merged.push(right.next().unwrap()),
            (None, None) => break,
        }
    }
    merged
}

pub(super) struct LinkStage<'a> {
    store: &'a DerivedStore,
    scratch: CommandIndex<'a>,
    scope: HistoryScope,
    before: &'a FolderTopology,
    folders: &'a FolderTopology,
    changes: LinkApply,
}

#[derive(Default)]
pub(super) struct LinkApply {
    pub outgoing: Bitmap,
    pub incoming: Bitmap,
    pub graph_changes: u32,
}

impl LinkApply {
    fn put(&mut self, old: Option<&ProjectedLink>, new: ProjectedLink) -> Option<DerivedMutation> {
        if old == Some(&new) {
            return None;
        }
        let before = old.and_then(|link| link.resolved_dense_id);
        if before != new.resolved_dense_id {
            self.changed_edges(new.src_dense_id, before, new.resolved_dense_id);
        }
        Some(DerivedMutation::UpsertLink(new))
    }

    fn remove(&mut self, old: ProjectedLink) -> DerivedMutation {
        if old.resolved_dense_id.is_some() {
            self.changed_edges(old.src_dense_id, old.resolved_dense_id, None);
        }
        DerivedMutation::DeleteLink(old.src_dense_id, old.link_ord)
    }

    fn changed_edges(&mut self, from: u32, old: Option<u32>, new: Option<u32>) {
        self.graph_changes = self
            .graph_changes
            .saturating_add(u32::from(old.is_some()) + u32::from(new.is_some()));
        self.outgoing.add(from);
        for endpoint in [old, new].into_iter().flatten() {
            self.incoming.add(endpoint);
        }
    }
}

impl<'a> LinkStage<'a> {
    pub(super) fn new(
        store: &'a DerivedStore,
        scope: HistoryScope,
        old_topology: &'a FolderTopology,
        topology: &'a FolderTopology,
        scratch_dir: PathBuf,
        stop: Cancellation,
    ) -> Self {
        Self {
            store,
            scratch: CommandIndex {
                store,
                added: Scratch::new(scratch_dir, stop),
            },
            scope,
            before: old_topology,
            folders: topology,
            changes: LinkApply::default(),
        }
    }

    pub(super) async fn first_note(&mut self, note: &NoteId) -> Result<bool, PortError> {
        self.scratch
            .added
            .insert_marker_async(Key::new(spill::SEEN).text(note.as_str()))
            .await
    }

    pub(super) async fn record_alias(
        &mut self,
        alias: &ProjectedNoteAlias,
    ) -> Result<(), PortError> {
        self.scratch
            .record_leaves(vec![
                alias.old_slug_fold.clone(),
                alias.old_title_norm.clone(),
            ])
            .await?;
        self.scratch.added.alias_async(alias).await
    }

    pub(super) async fn record_change(
        &mut self,
        before: Option<&ProjectedNote>,
        after: Option<&ProjectedNote>,
        raw_links: Option<&[String]>,
    ) -> Result<(), PortError> {
        let Some(identity) = before.or(after) else {
            return Ok(());
        };
        let space = &self.scope.space_id;
        if [before, after].into_iter().flatten().any(|row| {
            row.space_id != *space
                || row.note_id != identity.note_id
                || row.dense_id != identity.dense_id
        }) {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        let old = before.map(convert_note).transpose()?;
        let new = after.map(convert_note).transpose()?;
        let active_before = old
            .as_ref()
            .is_some_and(|note| note.visible && self.before.is_active(&note.parent));
        let active_after = new
            .as_ref()
            .is_some_and(|note| note.visible && self.folders.is_active(&note.parent));
        if active_before != active_after {
            self.changes.graph_changes = self.changes.graph_changes.saturating_add(1);
        }
        let old_keys = old
            .as_ref()
            .map(|note| candidate_keys(space, note, self.before))
            .unwrap_or_default();
        let new_keys = new
            .as_ref()
            .map(|note| candidate_keys(space, note, self.folders))
            .unwrap_or_default();
        let replace_candidates = old_keys != new_keys;
        let old_slot = active_slot(before, self.before);
        let new_slot = active_slot(after, self.folders);
        let replace_slot = old_slot != new_slot;
        let parent = after
            .filter(|row| {
                row.doc_class != DocClass::EncryptedNote && row.lifecycle != Lifecycle::Purged
            })
            .map(|row| row.parent_folder_id.clone());
        let replace_links = raw_links.is_some() || parent.is_none();
        if let Some(raw) = raw_links.filter(|_| parent.is_some()) {
            for (ordinal, target) in raw.iter().enumerate() {
                let ordinal = checked_ordinal(ordinal)?;
                self.scratch
                    .added
                    .put_async(
                        Key::new(spill::RAW)
                            .number(identity.dense_id)
                            .number(ordinal),
                        &(ordinal, target),
                    )
                    .await?;
            }
        }
        if replace_candidates {
            self.scratch
                .added
                .put_async(
                    Key::new(spill::CANDIDATES_REPLACED).number(identity.dense_id),
                    &(),
                )
                .await?;
            // Candidate identity, tier, folder and normalized spelling determine
            // these dependencies. Stable-ID references survive a title-only edit.
            let old_leaves: BTreeSet<_> = old_keys
                .iter()
                .map(|k| (k.tier, k.scope_folder_dense_id, &k.leaf_norm_key))
                .collect();
            let new_leaves: BTreeSet<_> = new_keys
                .iter()
                .map(|k| (k.tier, k.scope_folder_dense_id, &k.leaf_norm_key))
                .collect();
            let diff_leaves: Vec<String> = old_leaves
                .symmetric_difference(&new_leaves)
                .map(|(_, _, leaf)| (*leaf).clone())
                .collect();
            self.scratch.record_leaves(diff_leaves).await?;
            for (ordinal, key) in new_keys.iter().enumerate() {
                self.scratch.added.candidate_async(key).await?;
                self.scratch
                    .added
                    .put_async(
                        Key::new(spill::SOURCE_CANDIDATE)
                            .number(identity.dense_id)
                            .number(checked_ordinal(ordinal)?),
                        key,
                    )
                    .await?;
            }
        }
        if replace_slot {
            self.scratch
                .added
                .put_async(
                    Key::new(spill::SLOTS_REPLACED).text(identity.note_id.as_str()),
                    &(),
                )
                .await?;
            if let Some((folder, slug, note)) = new_slot {
                self.scratch.added.slot_async(folder, slug, note).await?;
            }
        }
        self.scratch
            .added
            .put_async(
                Key::new(spill::SOURCE).number(identity.dense_id),
                &ScratchSource {
                    dense: identity.dense_id,
                    parent,
                    visible: active_after,
                    replace_links,
                    replace_candidates,
                },
            )
            .await?;
        if active_before != active_after {
            self.alias_leaves(AliasDependencies::Note(&identity.note_id))
                .await?;
        }
        if replace_slot {
            for (folder, slug, _) in [old_slot, new_slot].into_iter().flatten() {
                self.alias_leaves(AliasDependencies::Slot(folder, slug))
                    .await?;
            }
        }
        Ok(())
    }

    async fn alias_leaves(&mut self, dependencies: AliasDependencies<'_>) -> Result<(), PortError> {
        let space = &self.scope.space_id;
        let mut after = None;
        loop {
            let rows = match dependencies {
                AliasDependencies::Note(note) => {
                    self.store
                        .link_aliases_for_note(space, note, after.as_ref(), page())
                        .await?
                }
                AliasDependencies::Slot(folder, slug) => {
                    self.store
                        .link_aliases_in_slot(space, folder, slug, after.as_ref(), page())
                        .await?
                }
            };
            let leaves: Vec<String> = rows
                .iter()
                .flat_map(|alias| [alias.old_slug_fold.clone(), alias.old_title_norm.clone()])
                .collect();
            self.scratch.record_leaves(leaves).await?;
            if rows.len() < usize::from(PAGE) {
                return Ok(());
            }
            after = rows.last().map(NoteAliasPosition::from);
        }
    }

    pub(super) async fn finish(
        mut self,
        sink: &mut CommandSink<'_>,
        stop: &Cancellation,
    ) -> Result<LinkApply, PortError> {
        let mut after = None;
        loop {
            let sources = self
                .scratch
                .added
                .page_async::<ScratchSource>(Key::new(spill::SOURCE), after.as_ref(), PAGE)
                .await?;
            let Some((key, _)) = sources.last() else {
                break;
            };
            after = Some(key.clone());
            for (_, source) in sources {
                check_stop(stop)?;
                if source.replace_candidates {
                    sink.push(vec![DerivedMutation::DeleteNoteCandidates(source.dense)])
                        .await?;
                    let mut cursor = None;
                    loop {
                        check_stop(stop)?;
                        let rows = self
                            .scratch
                            .added
                            .page_async::<CandidateLookupKey>(
                                Key::new(spill::SOURCE_CANDIDATE).number(source.dense),
                                cursor.as_ref(),
                                PAGE,
                            )
                            .await?;
                        let done = rows.len() < usize::from(PAGE);
                        cursor = rows.last().map(|(key, _)| key.clone());
                        sink.push(
                            rows.into_iter()
                                .map(|(_, row)| DerivedMutation::UpsertCandidate(row))
                                .collect(),
                        )
                        .await?;
                        if done {
                            break;
                        }
                    }
                }
                self.apply_source(source, sink, stop).await?;
            }
        }
        let mut after = None;
        loop {
            let leaves = self
                .scratch
                .added
                .page_async::<String>(Key::new(spill::LEAF), after.as_ref(), PAGE)
                .await?;
            let Some((last, _)) = leaves.last() else {
                break;
            };
            after = Some(last.clone());
            for (_, leaf) in leaves {
                self.watch(LinkAddress::Leaf(&leaf), sink, stop).await?;
            }
        }
        let addresses = if std::ptr::eq(self.before, self.folders) {
            Default::default()
        } else {
            self.before.changed_addresses(self.folders)
        };
        for prefix in &addresses.prefixes {
            self.watch(LinkAddress::Prefix(prefix), sink, stop).await?;
        }
        for folder in &addresses.sources {
            self.watch(LinkAddress::RelativeSource(folder), sink, stop)
                .await?;
        }

        Ok(self.changes)
    }

    async fn watch(
        &mut self,
        address: LinkAddress<'_>,
        sink: &mut CommandSink<'_>,
        stop: &Cancellation,
    ) -> Result<(), PortError> {
        let mut after = None;
        loop {
            check_stop(stop)?;
            let links = self
                .store
                .link_page(&self.scope.space_id, address, after.as_ref(), page())
                .await?;
            let count = links.len();
            after = links.last().map(LinkPosition::from);
            let mut previous = None;
            for old in links {
                if self
                    .scratch
                    .added
                    .contains_async(Key::new(spill::SOURCE).number(old.src_dense_id))
                    .await?
                    || !self
                        .scratch
                        .added
                        .insert_marker_async(
                            Key::new(spill::WATCHED)
                                .number(old.src_dense_id)
                                .number(old.link_ord),
                        )
                        .await?
                {
                    continue;
                }
                let may_emit = match previous {
                    Some((dense, active)) if dense == old.src_dense_id => active,
                    _ => {
                        self.store
                            .is_link_source_active(&self.scope.space_id, old.src_dense_id)
                            .await?
                    }
                };
                previous = Some((old.src_dense_id, may_emit));
                let new = if may_emit {
                    let mut row = old.clone();
                    resolve_link(&mut row, self.folders, &self.scratch).await?;
                    row
                } else {
                    // Keep source path metadata consistent with ColdLinks even when
                    // a trashed note cannot emit resolved edges.
                    source_link_row(
                        &self.scope.space_id,
                        old.src_dense_id,
                        &old.src_folder_id,
                        old.link_ord,
                        old.raw_target.clone(),
                        self.folders,
                    )
                };
                if let Some(mutation) = self.changes.put(Some(&old), new) {
                    sink.push(vec![mutation]).await?;
                }
            }
            if count < usize::from(PAGE) {
                return Ok(());
            }
        }
    }

    async fn apply_source(
        &mut self,
        source: ScratchSource,
        sink: &mut CommandSink<'_>,
        stop: &Cancellation,
    ) -> Result<(), PortError> {
        let ScratchSource {
            dense,
            parent,
            visible,
            replace_links,
            ..
        } = source;
        let raw_prefix = Key::new(spill::RAW).number(dense);
        let mut raw_after = None;
        let mut raw = VecDeque::new();
        let mut raw_done = !replace_links;
        let mut old = VecDeque::<ProjectedLink>::new();
        let mut old_after = None;
        let mut old_done = false;
        loop {
            check_stop(stop)?;
            if raw.is_empty() && !raw_done {
                let rows = self
                    .scratch
                    .added
                    .page_async::<(u32, String)>(raw_prefix.clone(), raw_after.as_ref(), PAGE)
                    .await?;
                raw_done = rows.is_empty();
                raw_after = rows.last().map(|(key, _)| key.clone());
                raw.extend(rows.into_iter().map(|(_, value)| value));
            }
            if old.is_empty() && !old_done {
                let rows = self
                    .store
                    .link_page(
                        &self.scope.space_id,
                        LinkAddress::Source(dense),
                        old_after.as_ref(),
                        page(),
                    )
                    .await?;
                old_done = rows.len() < usize::from(PAGE);
                old_after = rows.last().map(LinkPosition::from);
                old = rows.into();
            }
            if let Some((ordinal, _)) = raw.front() {
                let ordinal = *ordinal;
                if old.front().is_none_or(|old| old.link_ord >= ordinal) {
                    let (_, raw_target) = raw.pop_front().ok_or_else(invalid_edge)?;
                    let previous = old
                        .front()
                        .is_some_and(|row| row.link_ord == ordinal)
                        .then(|| old.pop_front())
                        .flatten();
                    self.apply_raw(
                        dense,
                        parent.as_ref(),
                        visible,
                        sink,
                        previous.as_ref(),
                        ordinal,
                        raw_target,
                    )
                    .await?;
                    continue;
                }
            }
            let Some(previous) = old.pop_front() else {
                return Ok(());
            };
            if !replace_links && parent.is_some() {
                self.apply_raw(
                    dense,
                    parent.as_ref(),
                    visible,
                    sink,
                    Some(&previous),
                    previous.link_ord,
                    previous.raw_target.clone(),
                )
                .await?;
            } else {
                sink.push(vec![self.changes.remove(previous)]).await?;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn apply_raw(
        &mut self,
        dense: u32,
        parent: Option<&FolderId>,
        visible: bool,
        sink: &mut CommandSink<'_>,
        previous: Option<&ProjectedLink>,
        ordinal: u32,
        raw: String,
    ) -> Result<(), PortError> {
        let parent = parent.ok_or_else(invalid_edge)?;
        let mut row = source_link_row(
            &self.scope.space_id,
            dense,
            parent,
            ordinal,
            raw,
            self.folders,
        );
        if visible {
            resolve_link(&mut row, self.folders, &self.scratch).await?;
        }
        if let Some(mutation) = self.changes.put(previous, row) {
            sink.push(vec![mutation]).await?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum AliasDependencies<'a> {
    Note(&'a NoteId),
    Slot(&'a FolderId, &'a str),
}

fn active_slot<'a>(
    row: Option<&'a ProjectedNote>,
    folders: &FolderTopology,
) -> Option<(&'a FolderId, &'a str, &'a NoteId)> {
    row.filter(|row| row.lifecycle == Lifecycle::Active && folders.is_active(&row.parent_folder_id))
        .map(|row| (&row.parent_folder_id, row.slug_fold.as_str(), &row.note_id))
}

pub(super) struct CheckpointGraph {
    pub sections: GraphSections,
    pub mutations: Vec<DerivedMutation>,
}

pub(super) async fn collect_graph_sections(
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
    notes: Vec<Option<NoteId>>,
    effective: Bitmap,
    previous: Option<&IndexView>,
    settle: bool,
    stop: &Cancellation,
) -> Result<CheckpointGraph, PortError> {
    let scope = &watermark.scope;
    let cut = watermark.projected_seq;
    let previous_settled = watermark.graph_settled_seq;
    let count = notes.len();
    let count_u32 = u32::try_from(count).map_err(|_| invalid_edge())?;
    let mut raw_edges: Vec<(u32, u32)> = Vec::new();
    let mut after = None;
    loop {
        check_stop(stop)?;
        let rows = store
            .graph_edges_page(scope, cut, None, after, GRAPH_EDGE_PAGE)
            .await?;
        raw_edges.reserve(rows.len());
        for &(source, _, target) in &rows {
            if source >= count_u32 || target >= count_u32 {
                return Err(invalid_edge());
            }
            raw_edges.push((source, target));
        }
        if rows.len() < usize::from(GRAPH_EDGE_PAGE) {
            break;
        }
        after = rows.last().map(|&(source, ordinal, _)| (source, ordinal));
    }
    let mut clusters = vec![None; count];
    let durable_seq = previous.and_then(IndexView::deferred_clusters).or_else(|| {
        (previous.is_none() && previous_settled != SpaceSeq::ZERO).then_some(previous_settled)
    });
    if let Some(seq) = durable_seq {
        let loaded = graph_settle::load_clusters(store, scope, seq, count_u32, None, stop).await?;
        for node in effective.iter() {
            clusters[node as usize] = loaded.cluster(node).cloned();
        }
    } else if let Some(previous) = previous {
        for node in effective.iter() {
            clusters[node as usize] = previous.cluster(node);
        }
    }
    let scope_owned = scope.clone();
    let cancel = stop.clone();
    tokio::task::spawn_blocking(move || {
        check_stop(&cancel)?;
        let mut graph = GraphSections {
            outgoing: vec![Vec::new(); count],
            incoming: vec![Vec::new(); count],
            clusters,
        };
        for (idx, (source, target)) in raw_edges.into_iter().enumerate() {
            if idx & 4095 == 0 {
                check_stop(&cancel)?;
            }
            graph.outgoing[source as usize].push(target);
            graph.incoming[target as usize].push(source);
        }
        for (idx, row) in graph
            .outgoing
            .iter_mut()
            .chain(&mut graph.incoming)
            .enumerate()
        {
            if idx & 1023 == 0 {
                check_stop(&cancel)?;
            }
            if row.len() > 1 {
                row.sort_unstable();
                row.dedup();
            }
        }
        if settle {
            let build = GraphBuild {
                notes: &notes,
                sections: &graph,
            };
            let snapshot = LeidenSnapshot::compute(&build, &scope_owned, &effective, &cancel)?;
            let mutations = graph_settle::cluster_mutations(&snapshot, &build, &scope_owned, cut)?;
            graph.clusters = snapshot.expanded();
            Ok(CheckpointGraph {
                sections: graph,
                mutations,
            })
        } else {
            Ok(CheckpointGraph {
                sections: graph,
                mutations: Vec::new(),
            })
        }
    })
    .await
    .map_err(checkpoint_error)?
}

pub(super) async fn reload_adjacency(
    store: &DerivedStore,
    scope: &HistoryScope,
    cut: SpaceSeq,
    delta: &mut L0Delta,
    touched: &LinkApply,
    previous_index: Option<&IndexView>,
) -> Result<bool, PortError> {
    if touched.outgoing.is_empty() && touched.incoming.is_empty() {
        return Ok(true);
    }
    if let Some(prev) = previous_index {
        let mut incoming_added: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        let mut incoming_removed: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for from in touched.outgoing.iter() {
            let available = L0_BYTE_LIMIT.saturating_sub(delta.approx_bytes());
            let Some(edges) =
                affected_neighbors(store, scope, cut, LinkAddress::Source(from), available).await?
            else {
                return Ok(false);
            };
            let mut prev_out: Vec<u32> = prev.outgoing(from).collect();
            prev_out.sort_unstable();
            prev_out.dedup();
            let mut i = 0;
            let mut j = 0;
            while i < prev_out.len() && j < edges.len() {
                match prev_out[i].cmp(&edges[j]) {
                    std::cmp::Ordering::Equal => {
                        i += 1;
                        j += 1;
                    }
                    std::cmp::Ordering::Less => {
                        incoming_removed.entry(prev_out[i]).or_default().push(from);
                        i += 1;
                    }
                    std::cmp::Ordering::Greater => {
                        incoming_added.entry(edges[j]).or_default().push(from);
                        j += 1;
                    }
                }
            }
            for &target in &prev_out[i..] {
                incoming_removed.entry(target).or_default().push(from);
            }
            for &target in &edges[j..] {
                incoming_added.entry(target).or_default().push(from);
            }
            delta.replace_adjacency(from, Some(edges), None);
            if delta.approx_bytes() >= L0_BYTE_LIMIT {
                return Ok(false);
            }
        }
        let targets: BTreeSet<u32> = incoming_added
            .keys()
            .chain(incoming_removed.keys())
            .copied()
            .collect();
        for target in targets {
            let added = incoming_added.remove(&target).unwrap_or_default();
            let removed = incoming_removed.remove(&target).unwrap_or_default();
            let est = 64 + (added.len() + removed.len()) * size_of::<u32>();
            if delta.approx_bytes().saturating_add(est) >= L0_BYTE_LIMIT {
                return Ok(false);
            }
            delta.apply_adjacency_delta(target, true, &added, &removed);
            if delta.approx_bytes() >= L0_BYTE_LIMIT {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    let affected = touched.outgoing.or(&touched.incoming);
    for dense in affected.iter() {
        let mut available = L0_BYTE_LIMIT.saturating_sub(delta.approx_bytes());
        let outgoing = if touched.outgoing.contains(dense) {
            let Some(edges) =
                affected_neighbors(store, scope, cut, LinkAddress::Source(dense), available)
                    .await?
            else {
                return Ok(false);
            };
            available = available.saturating_sub(64 + edges.capacity() * size_of::<u32>());
            Some(edges)
        } else {
            None
        };
        let incoming = if touched.incoming.contains(dense) {
            let Some(edges) =
                affected_neighbors(store, scope, cut, LinkAddress::Target(dense), available)
                    .await?
            else {
                return Ok(false);
            };
            Some(edges)
        } else {
            None
        };
        delta.replace_adjacency(dense, outgoing, incoming);
    }
    Ok(true)
}

async fn affected_neighbors(
    store: &DerivedStore,
    scope: &HistoryScope,
    cut: SpaceSeq,
    address: LinkAddress<'_>,
    available: usize,
) -> Result<Option<Vec<u32>>, PortError> {
    let Some(available) = available.checked_sub(64) else {
        return Ok(None);
    };
    // Include ordered-set scratch and the resulting CSR row in the budget.
    let limit = available / 32;
    let mut result = BTreeSet::new();
    let mut after = None;
    loop {
        let rows = store
            .graph_edges_page(scope, cut, Some(address), after, GRAPH_EDGE_PAGE)
            .await?;
        let outgoing = matches!(address, LinkAddress::Source(_));
        result.extend(
            rows.iter()
                .map(|&(source, _, target)| if outgoing { target } else { source }),
        );
        if result.len() > limit {
            return Ok(None);
        }
        if rows.len() < usize::from(GRAPH_EDGE_PAGE) {
            break;
        }
        after = rows.last().map(|&(source, ordinal, _)| (source, ordinal));
    }
    Ok(Some(result.into_iter().collect()))
}

fn invalid_edge() -> PortError {
    DomainError::validation(ValidationReason::InvalidState).into()
}

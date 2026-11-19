use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
        MemoryResolutionIndex, NoteAliasPosition, ResolutionIndex, candidate_keys, link_row,
        resolve_link, source_link_row,
    },
};

use super::{
    apply::{CommandSink, check_stop},
    checkpoint_error, graph_settle,
    records::{FolderCatalog, NoteProjection, note_raw_fields},
};

const PAGE: u16 = 200;

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
#[derive(Default)]
pub(super) struct ColdLinks {
    index: MemoryResolutionIndex,
    pending: VecDeque<(bool, ProjectedLink)>,
}

impl ColdLinks {
    pub fn add(
        &mut self,
        projected: &NoteProjection,
        folders: &FolderTopology,
    ) -> Result<Vec<DerivedMutation>, PortError> {
        let row = &projected.row;
        let note = convert_note(row)?;
        if row.lifecycle == Lifecycle::Active {
            self.index
                .put_slot(note.parent.clone(), note.slug_fold.clone(), note.id.clone());
        }
        let mut mutations = Vec::new();
        for key in candidate_keys(&row.space_id, &note, folders) {
            self.index.put_candidate(key.clone());
            mutations.push(DerivedMutation::UpsertCandidate(key));
        }
        if row.doc_class != DocClass::EncryptedNote && row.lifecycle != Lifecycle::Purged {
            for (ordinal, raw) in projected.links.iter().enumerate() {
                self.pending.push_back((
                    note.visible,
                    link_row(
                        &row.space_id,
                        &note,
                        checked_ordinal(ordinal)?,
                        raw.clone(),
                        folders,
                    ),
                ));
            }
        }
        Ok(mutations)
    }

    pub fn add_note_alias(&mut self, alias: ProjectedNoteAlias) {
        self.index.put_alias(alias);
    }

    pub async fn resolve_page(
        &mut self,
        folders: &FolderTopology,
    ) -> Result<Vec<DerivedMutation>, PortError> {
        let mut mutations = Vec::with_capacity(usize::from(PAGE).min(self.pending.len()));
        for _ in 0..PAGE {
            let Some((visible, mut row)) = self.pending.pop_front() else {
                break;
            };
            if visible {
                resolve_link(&mut row, folders, &self.index).await?;
            }
            mutations.push(DerivedMutation::UpsertLink(row));
        }
        Ok(mutations)
    }
}

fn checked_ordinal(ordinal: usize) -> Result<u32, PortError> {
    u32::try_from(ordinal)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit).into())
}

struct ScratchSource {
    parent: Option<FolderId>,
    visible: bool,
    raw_links: Option<Vec<String>>,
    replace_candidates: bool,
    replacement_candidates: Vec<CandidateLookupKey>,
}

/// In-memory overlay over `DerivedStore` for resolving incremental wikilink
/// updates within a single command without temporary SQL scratch tables.
struct MemoryLinkScratch<'a> {
    store: &'a DerivedStore,
    added: MemoryResolutionIndex,
    replaced_candidate_notes: BTreeSet<u32>,
    replaced_slot_notes: BTreeSet<NoteId>,
    added_slots: BTreeMap<(FolderId, String), NoteId>,
    sources: BTreeMap<u32, ScratchSource>,
    leaves: BTreeSet<String>,
    watched: BTreeMap<(u32, u32), ProjectedLink>,
    seen_notes: BTreeSet<NoteId>,
}

impl<'a> MemoryLinkScratch<'a> {
    fn new(store: &'a DerivedStore) -> Self {
        Self {
            store,
            added: MemoryResolutionIndex::default(),
            replaced_candidate_notes: BTreeSet::new(),
            replaced_slot_notes: BTreeSet::new(),
            added_slots: BTreeMap::new(),
            sources: BTreeMap::new(),
            leaves: BTreeSet::new(),
            watched: BTreeMap::new(),
            seen_notes: BTreeSet::new(),
        }
    }

    fn first_note(&mut self, note: &NoteId) -> bool {
        self.seen_notes.insert(note.clone())
    }

    fn record_alias(&mut self, alias: &ProjectedNoteAlias) {
        self.leaves.insert(alias.old_slug_fold.clone());
        self.leaves.insert(alias.old_title_norm.clone());
        self.added.put_alias(alias.clone());
    }

    fn record_leaves(&mut self, leaves: impl IntoIterator<Item = String>) {
        self.leaves.extend(leaves);
    }

    fn record_watch(&mut self, links: Vec<ProjectedLink>) {
        for link in links {
            if !self.sources.contains_key(&link.src_dense_id) {
                self.watched
                    .entry((link.src_dense_id, link.link_ord))
                    .or_insert(link);
            }
        }
    }
}

impl ResolutionIndex for MemoryLinkScratch<'_> {
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
                if !self.replaced_candidate_notes.contains(&row.target_dense_id) {
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
        if let Some(note) = self.added_slots.get(&(parent.clone(), slug.to_owned())) {
            return Ok(Some(note.clone()));
        }
        Ok(self
            .store
            .slot_occupant(space, parent, slug)
            .await?
            .filter(|note| !self.replaced_slot_notes.contains(note)))
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
    scratch: MemoryLinkScratch<'a>,
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
    ) -> Self {
        Self {
            store,
            scratch: MemoryLinkScratch::new(store),
            scope,
            before: old_topology,
            folders: topology,
            changes: LinkApply::default(),
        }
    }

    pub(super) fn first_note(&mut self, note: &NoteId) -> bool {
        self.scratch.first_note(note)
    }

    pub(super) fn record_alias(&mut self, alias: &ProjectedNoteAlias) {
        self.scratch.record_alias(alias);
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
        let raw_links = if parent.is_some() {
            if let Some(raw) = raw_links {
                checked_ordinal(raw.len())?;
                Some(raw.to_vec())
            } else {
                None
            }
        } else {
            Some(Vec::new())
        };
        if replace_candidates {
            self.scratch
                .replaced_candidate_notes
                .insert(identity.dense_id);
            self.scratch.record_leaves(
                old_keys
                    .iter()
                    .chain(&new_keys)
                    .map(|key| key.leaf_norm_key.clone()),
            );
            for key in &new_keys {
                self.scratch.added.put_candidate(key.clone());
            }
        }
        if replace_slot {
            self.scratch
                .replaced_slot_notes
                .insert(identity.note_id.clone());
            if let Some((folder, slug, note)) = new_slot {
                self.scratch
                    .added_slots
                    .insert((folder.clone(), slug.to_owned()), note.clone());
            }
        }
        self.scratch.sources.insert(
            identity.dense_id,
            ScratchSource {
                parent,
                visible: active_after,
                raw_links,
                replace_candidates,
                replacement_candidates: if replace_candidates {
                    new_keys
                } else {
                    Vec::new()
                },
            },
        );
        if replace_candidates {
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
            self.scratch.record_leaves(
                rows.iter()
                    .flat_map(|alias| [alias.old_slug_fold.clone(), alias.old_title_norm.clone()]),
            );
            if rows.len() < usize::from(PAGE) {
                return Ok(());
            }
            after = rows.last().map(NoteAliasPosition::from);
        }
    }

    pub(super) async fn finish(
        mut self,
        sink: &mut CommandSink<'_>,
        aliases: &[ProjectedNoteAlias],
        stop: &Cancellation,
    ) -> Result<LinkApply, PortError> {
        for alias in aliases {
            check_stop(stop)?;
            self.record_alias(alias);
        }
        let source_ids: Vec<u32> = self.scratch.sources.keys().copied().collect();
        for dense in source_ids {
            check_stop(stop)?;
            let replace_candidates = self.scratch.sources[&dense].replace_candidates;
            if replace_candidates {
                sink.push(vec![DerivedMutation::DeleteNoteCandidates(dense)])
                    .await?;
                let candidates = std::mem::take(
                    &mut self
                        .scratch
                        .sources
                        .get_mut(&dense)
                        .expect("source exists")
                        .replacement_candidates,
                );
                for batch in candidates.chunks(usize::from(PAGE)) {
                    check_stop(stop)?;
                    sink.push(
                        batch
                            .iter()
                            .cloned()
                            .map(DerivedMutation::UpsertCandidate)
                            .collect(),
                    )
                    .await?;
                }
                self.watch(LinkAddress::Target(dense), stop).await?;
            }
            self.apply_source(dense, sink, stop).await?;
        }

        let leaves: Vec<String> = std::mem::take(&mut self.scratch.leaves)
            .into_iter()
            .collect();
        for leaf in leaves {
            check_stop(stop)?;
            self.watch(LinkAddress::Leaf(&leaf), stop).await?;
        }
        let addresses = self.before.changed_addresses(self.folders);
        for prefix in &addresses.prefixes {
            self.watch(LinkAddress::Prefix(prefix), stop).await?;
        }
        for folder in &addresses.sources {
            self.watch(LinkAddress::RelativeSource(folder), stop)
                .await?;
        }

        let watched = std::mem::take(&mut self.scratch.watched);
        let mut active = BTreeMap::new();
        for old in watched.into_values() {
            check_stop(stop)?;
            let may_emit = if let Some(&may_emit) = active.get(&old.src_dense_id) {
                may_emit
            } else {
                let may_emit = self
                    .store
                    .is_link_source_active(&self.scope.space_id, old.src_dense_id)
                    .await?;
                active.insert(old.src_dense_id, may_emit);
                may_emit
            };
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
        Ok(self.changes)
    }

    async fn watch(
        &mut self,
        address: LinkAddress<'_>,
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
            self.scratch.record_watch(links);
            if count < usize::from(PAGE) {
                return Ok(());
            }
        }
    }

    async fn apply_source(
        &mut self,
        dense: u32,
        sink: &mut CommandSink<'_>,
        stop: &Cancellation,
    ) -> Result<(), PortError> {
        let parent = self.scratch.sources[&dense].parent.clone();
        let visible = self.scratch.sources[&dense].visible;
        let raw_links = std::mem::take(
            &mut self
                .scratch
                .sources
                .get_mut(&dense)
                .expect("source exists")
                .raw_links,
        );
        let mut old = VecDeque::<ProjectedLink>::new();
        let mut old_after = None;
        let mut old_done = false;
        let mut raw_iter = raw_links
            .as_ref()
            .map(|rows| rows.iter().enumerate().peekable());
        loop {
            check_stop(stop)?;
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
            if let Some(iter) = raw_iter.as_mut()
                && let Some(&(ordinal, _)) = iter.peek()
            {
                let ordinal = checked_ordinal(ordinal)?;
                if old.front().is_none_or(|old| old.link_ord >= ordinal) {
                    let (_, raw_target) = iter.next().ok_or_else(invalid_edge)?;
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
                        raw_target.clone(),
                    )
                    .await?;
                    continue;
                }
            }
            let Some(previous) = old.pop_front() else {
                return Ok(());
            };
            if raw_links.is_none() && parent.is_some() {
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
    let mut graph = GraphSections {
        outgoing: vec![Vec::new(); count],
        incoming: vec![Vec::new(); count],
        clusters: vec![None; count],
    };
    let mut after = None;
    loop {
        check_stop(stop)?;
        let rows = store
            .graph_edges_page(scope, cut, None, after, page())
            .await?;
        for &(source, _, target) in &rows {
            graph
                .outgoing
                .get_mut(source as usize)
                .ok_or_else(invalid_edge)?
                .push(target);
            graph
                .incoming
                .get_mut(target as usize)
                .ok_or_else(invalid_edge)?
                .push(source);
        }
        if rows.len() < usize::from(PAGE) {
            break;
        }
        after = rows.last().map(|&(source, ordinal, _)| (source, ordinal));
    }
    for row in graph.outgoing.iter_mut().chain(&mut graph.incoming) {
        row.sort_unstable();
        row.dedup();
    }
    let durable_seq = previous.and_then(IndexView::deferred_clusters).or_else(|| {
        (previous.is_none() && previous_settled != SpaceSeq::ZERO).then_some(previous_settled)
    });
    if let Some(seq) = durable_seq {
        let clusters = graph_settle::load_clusters(store, scope, seq, count as u32, None).await?;
        for node in effective.iter() {
            graph.clusters[node as usize] = clusters.cluster(node).cloned();
        }
    } else if let Some(previous) = previous {
        for node in effective.iter() {
            graph.clusters[node as usize] = previous.cluster(node);
        }
    }
    if settle {
        let scope = scope.clone();
        let cancel = stop.clone();
        return tokio::task::spawn_blocking(move || {
            let build = GraphBuild {
                notes: &notes,
                sections: &graph,
            };
            let snapshot = LeidenSnapshot::compute(&build, &scope, &effective, &cancel)?;
            let mutations = graph_settle::cluster_mutations(&snapshot, &build, &scope, cut)?;
            graph.clusters = snapshot.expanded();
            Ok(CheckpointGraph {
                sections: graph,
                mutations,
            })
        })
        .await
        .map_err(checkpoint_error)?;
    }
    Ok(CheckpointGraph {
        sections: graph,
        mutations: Vec::new(),
    })
}

pub(super) async fn reload_adjacency(
    store: &DerivedStore,
    scope: &HistoryScope,
    cut: SpaceSeq,
    delta: &mut L0Delta,
    touched: &LinkApply,
) -> Result<bool, PortError> {
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
            .graph_edges_page(scope, cut, Some(address), after, page())
            .await?;
        let outgoing = matches!(address, LinkAddress::Source(_));
        result.extend(
            rows.iter()
                .map(|&(source, _, target)| if outgoing { target } else { source }),
        );
        if result.len() > limit {
            return Ok(None);
        }
        if rows.len() < usize::from(PAGE) {
            break;
        }
        after = rows.last().map(|&(source, ordinal, _)| (source, ordinal));
    }
    Ok(Some(result.into_iter().collect()))
}

fn invalid_edge() -> PortError {
    DomainError::validation(ValidationReason::InvalidState).into()
}

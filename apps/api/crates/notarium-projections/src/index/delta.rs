use std::{collections::BTreeMap, sync::Arc, time::Instant};

use croaring::{Bitmap, Frozen};
use notarium_core::{
    ids::{ClusterId, FolderId, NoteId, SpaceSeq},
    model::Lifecycle,
    value::ScalarValue,
};

use super::{IndexError, IndexNote, NoteSortHeader, model::*};
use crate::graph::LeidenSnapshot;

#[derive(Clone)]
pub(crate) enum ClusterOverlay {
    Resident(Arc<LeidenSnapshot>, usize),
    Deferred(SpaceSeq),
}

#[derive(Clone)]
pub(super) struct ChangedNote {
    pub(super) id: NoteId,
    pub(super) header: NoteSortHeader,
    postings: Vec<Vec<u8>>,
    domains: Vec<Vec<u8>>,
    bytes: usize,
}

#[derive(Clone, Default)]
pub(super) struct SubtreeOverlay {
    pub(super) added: Bitmap,
    pub(super) removed: Bitmap,
}

impl SubtreeOverlay {
    fn bytes(&self) -> usize {
        128 + self.added.get_serialized_size_in_bytes::<Frozen>()
            + self.removed.get_serialized_size_in_bytes::<Frozen>()
    }

    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

/// Private mutable command delta. A cut retains it through an Arc before the
/// next command changes it. Heavy values and rarely-mutated side maps use
/// copy-on-write Arc sharing so sequential edits only clone touched keys.
#[derive(Clone, Default)]
pub struct L0Delta {
    pub(super) notes: BTreeMap<u32, Arc<ChangedNote>>,
    pub(super) note_lookup: Arc<BTreeMap<NoteId, u32>>,
    pub(super) replaced: Bitmap,
    pub(super) deleted: Bitmap,
    pub(super) folders: Arc<BTreeMap<u32, (FolderId, Lifecycle)>>,
    pub(super) folder_lookup: Arc<BTreeMap<FolderId, u32>>,
    pub(super) subtree_overrides: Arc<BTreeMap<u32, Arc<SubtreeOverlay>>>,
    pub(super) postings: BTreeMap<Vec<u8>, Arc<Bitmap>>,
    pub(super) bsi_live: BTreeMap<Vec<u8>, Arc<BTreeMap<u32, ScalarValue>>>,
    pub(super) outgoing: Arc<BTreeMap<u32, Arc<Vec<u32>>>>,
    pub(super) incoming: Arc<BTreeMap<u32, Arc<Vec<u32>>>>,
    pub(super) cluster_delta: Arc<BTreeMap<u32, Option<ClusterId>>>,
    pub(super) cluster_dirty: Bitmap,
    pub(super) clusters: Arc<BTreeMap<ClusterId, Arc<Bitmap>>>,
    pub(super) cluster_overlay: Option<ClusterOverlay>,
    pub(super) node_count: u32,
    pub(super) folder_count: u32,
    events: u32,
    approx_bytes: usize,
    last_change: Option<Instant>,
}

impl L0Delta {
    pub fn replace_note(&mut self, note: IndexNote<'_>) -> Result<(), IndexError> {
        let NotePostings { ordinary, scalars } = note.postings()?;
        self.remove_replacement(note.dense);
        self.replaced.add(note.dense);
        self.deleted.remove(note.dense);
        Arc::make_mut(&mut self.note_lookup).insert(note.id.clone(), note.dense);
        let mut bytes = 256 + 2 * note.id.as_str().len();
        let mut keys = Vec::with_capacity(ordinary.len());
        let mut domains = Vec::with_capacity(scalars.len());
        for key in ordinary {
            Arc::make_mut(self.postings.entry(key.clone()).or_default()).add(note.dense);
            bytes = bytes.saturating_add(192 + 2 * key.capacity());
            keys.push(key);
        }
        for (key, (_, scalar)) in scalars {
            Arc::make_mut(self.bsi_live.entry(key.clone()).or_default()).insert(note.dense, scalar);
            bytes = bytes.saturating_add(192 + 2 * key.capacity());
            domains.push(key);
        }
        self.notes.insert(
            note.dense,
            Arc::new(ChangedNote {
                id: note.id.clone(),
                header: note.header,
                postings: keys,
                domains,
                bytes,
            }),
        );
        self.node_count = self.node_count.max(note.dense + 1);
        self.approx_bytes = self.approx_bytes.saturating_add(bytes);
        self.last_change = Some(Instant::now());
        Ok(())
    }

    pub fn remove_note(&mut self, dense: u32) {
        self.remove_replacement(dense);
        self.replaced.add(dense);
        if self.deleted.add_checked(dense) {
            self.approx_bytes = self.approx_bytes.saturating_add(64);
        }
        self.node_count = self.node_count.max(dense.saturating_add(1));
        self.replace_adjacency(dense, Some(Vec::new()), Some(Vec::new()));
        self.replace_cluster(dense, None);
    }

    fn remove_replacement(&mut self, dense: u32) {
        // The new note image carries its current ancestry. A previous subtree
        // move must not override the membership of this replacement.
        if !self.subtree_overrides.is_empty()
            && self
                .subtree_overrides
                .values()
                .any(|o| o.added.contains(dense) || o.removed.contains(dense))
        {
            let mut bytes = self.approx_bytes;
            Arc::make_mut(&mut self.subtree_overrides).retain(|_, overlay_arc| {
                if !overlay_arc.added.contains(dense) && !overlay_arc.removed.contains(dense) {
                    return true;
                }
                let overlay = Arc::make_mut(overlay_arc);
                bytes = bytes.saturating_sub(overlay.bytes());
                overlay.added.remove(dense);
                overlay.removed.remove(dense);
                if overlay.is_empty() {
                    false
                } else {
                    bytes = bytes.saturating_add(overlay.bytes());
                    true
                }
            });
            self.approx_bytes = bytes;
        }

        if self.deleted.remove_checked(dense) {
            self.approx_bytes = self.approx_bytes.saturating_sub(64);
        }
        let Some(old) = self.notes.remove(&dense) else {
            return;
        };
        Arc::make_mut(&mut self.note_lookup).remove(&old.id);
        self.approx_bytes = self.approx_bytes.saturating_sub(old.bytes);
        for key in &old.postings {
            if let Some(bitmap_arc) = self.postings.get_mut(key) {
                let bitmap = Arc::make_mut(bitmap_arc);
                bitmap.remove(dense);
                if bitmap.is_empty() {
                    self.postings.remove(key);
                }
            }
        }
        for key in &old.domains {
            if let Some(values_arc) = self.bsi_live.get_mut(key) {
                let values = Arc::make_mut(values_arc);
                values.remove(&dense);
                if values.is_empty() {
                    self.bsi_live.remove(key);
                }
            }
        }
    }

    pub fn replace_folder(
        &mut self,
        dense: u32,
        id: &FolderId,
        lifecycle: Lifecycle,
    ) -> Result<(), IndexError> {
        let next = dense
            .checked_add(1)
            .ok_or(IndexError::InvalidInput("folder slot overflow"))?;
        let cost = 192 + 2 * id.as_str().len();
        if let Some((old, _)) =
            Arc::make_mut(&mut self.folders).insert(dense, (id.clone(), lifecycle))
        {
            Arc::make_mut(&mut self.folder_lookup).remove(&old);
            self.approx_bytes = self
                .approx_bytes
                .saturating_sub(192 + 2 * old.as_str().len());
        }
        Arc::make_mut(&mut self.folder_lookup).insert(id.clone(), dense);
        self.folder_count = self.folder_count.max(next);
        self.approx_bytes = self.approx_bytes.saturating_add(cost);
        self.last_change = Some(Instant::now());
        Ok(())
    }

    /// Apply one ancestor membership change for a complete, unchanged
    /// subtree. The rows can include notes with earlier L0 replacements.
    pub(crate) fn set_subtree_membership(&mut self, ancestor: u32, rows: &Bitmap, included: bool) {
        if rows.is_empty() {
            return;
        }
        let overlay = Arc::make_mut(
            Arc::make_mut(&mut self.subtree_overrides)
                .entry(ancestor)
                .or_default(),
        );
        let old_bytes = if overlay.is_empty() {
            0
        } else {
            overlay.bytes()
        };
        if included {
            overlay.added.or_inplace(rows);
            overlay.removed.andnot_inplace(rows);
        } else {
            overlay.removed.or_inplace(rows);
            overlay.added.andnot_inplace(rows);
        }
        overlay.added.run_optimize();
        overlay.removed.run_optimize();
        self.approx_bytes = self
            .approx_bytes
            .saturating_sub(old_bytes)
            .saturating_add(overlay.bytes());
        self.last_change = Some(Instant::now());
    }

    pub fn replace_adjacency(
        &mut self,
        node: u32,
        outgoing: Option<Vec<u32>>,
        incoming: Option<Vec<u32>>,
    ) {
        for (direction, old) in [
            (outgoing, &mut self.outgoing),
            (incoming, &mut self.incoming),
        ] {
            if let Some(mut edges) = direction {
                edges.sort_unstable();
                edges.dedup();
                let bytes = 64 + edges.capacity() * size_of::<u32>();
                if let Some(previous) = Arc::make_mut(old).insert(node, Arc::new(edges)) {
                    self.approx_bytes = self
                        .approx_bytes
                        .saturating_sub(64 + previous.capacity() * size_of::<u32>());
                }
                self.approx_bytes = self.approx_bytes.saturating_add(bytes);
            }
        }
        self.last_change = Some(Instant::now());
    }

    pub fn replace_cluster(&mut self, node: u32, cluster: Option<ClusterId>) {
        if let Some(Some(old)) =
            Arc::make_mut(&mut self.cluster_delta).insert(node, cluster.clone())
        {
            let clusters = Arc::make_mut(&mut self.clusters);
            if let Some(bitmap_arc) = clusters.get_mut(&old) {
                let bitmap = Arc::make_mut(bitmap_arc);
                bitmap.remove(node);
                if bitmap.is_empty() {
                    clusters.remove(&old);
                }
            }
        }
        if self.cluster_dirty.add_checked(node) {
            self.approx_bytes = self.approx_bytes.saturating_add(256);
        }
        if let Some(id) = cluster {
            Arc::make_mut(Arc::make_mut(&mut self.clusters).entry(id).or_default()).add(node);
        }
        self.last_change = Some(Instant::now());
    }

    pub(crate) fn settle_clusters(&mut self, snapshot: LeidenSnapshot, seq: SpaceSeq) {
        let bytes = snapshot.estimated_bytes();
        self.approx_bytes = self
            .approx_bytes
            .saturating_sub(self.cluster_dirty.cardinality() as usize * 256);
        if let Some(ClusterOverlay::Resident(_, old_bytes)) = self.cluster_overlay.take() {
            self.approx_bytes = self.approx_bytes.saturating_sub(old_bytes);
        }
        if !self.cluster_delta.is_empty() {
            self.cluster_delta = Arc::default();
        }
        self.cluster_dirty.clear();
        if !self.clusters.is_empty() {
            self.clusters = Arc::default();
        }
        self.cluster_overlay = if self.approx_bytes.saturating_add(bytes) <= L0_BYTE_LIMIT {
            self.approx_bytes += bytes;
            Some(ClusterOverlay::Resident(Arc::new(snapshot), bytes))
        } else {
            Some(ClusterOverlay::Deferred(seq))
        };
    }

    pub fn record_events(&mut self, count: u32) {
        if count != 0 {
            self.events = self.events.saturating_add(count);
            self.last_change = Some(Instant::now());
        }
    }

    pub fn is_empty(&self) -> bool {
        self.last_change.is_none()
    }

    pub fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    pub fn should_checkpoint(&self, now: Instant) -> bool {
        self.events >= L0_EVENT_LIMIT
            || self.approx_bytes >= L0_BYTE_LIMIT
            || self
                .last_change
                .is_some_and(|change| now.saturating_duration_since(change) >= L0_IDLE)
    }
}

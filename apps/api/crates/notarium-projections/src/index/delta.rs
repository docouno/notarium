use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Instant,
};

use croaring::{Bitmap, Frozen};
use notarium_core::{
    ids::{ClusterId, FolderId, NoteId, SpaceSeq},
    model::Lifecycle,
    value::ScalarValue,
};

use super::{IndexError, IndexNote, NoteSortHeader, model::*};
use crate::graph::LeidenSnapshot;

/// Maximum notes buffered in the mutable tip before sealing into an immutable
/// `Arc<L0Layer>`. Keeps copy-on-write clone cost per edit strictly O(1).
const TIP_FLUSH_NOTES: usize = 128;
const TIP_FLUSH_BYTES: usize = 256 * 1024;

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

/// Adjacency override for one node: either a complete replacement list or an
/// incremental add/remove delta layered over the base checkpoint (avoids
/// reloading 50k-edge hubs on single-link edits).
#[derive(Clone)]
pub(super) enum EdgeOverlay {
    Replace(Arc<Vec<u32>>),
    Delta {
        added: BTreeSet<u32>,
        removed: BTreeSet<u32>,
    },
}

impl EdgeOverlay {
    fn approx_bytes(&self) -> usize {
        match self {
            Self::Replace(edges) => 64 + edges.capacity() * size_of::<u32>(),
            Self::Delta { added, removed } => {
                64 + (added.len() + removed.len()) * (size_of::<u32>() + 24)
            }
        }
    }
}

/// One bounded temporal layer of structural note edits followed by optional
/// subtree membership overrides. Once sealed into `L0Delta::layers`, a layer
/// is never cloned again across subsequent sequential edits.
#[derive(Clone, Default)]
pub(super) struct L0Layer {
    pub(super) notes: BTreeMap<u32, Arc<ChangedNote>>,
    pub(super) note_lookup: BTreeMap<NoteId, u32>,
    pub(super) replaced: Bitmap,
    pub(super) subtree_overrides: BTreeMap<u32, SubtreeOverlay>,
    pub(super) postings: BTreeMap<Vec<u8>, Bitmap>,
    pub(super) bsi_live: BTreeMap<Vec<u8>, BTreeMap<u32, ScalarValue>>,
    pub(super) approx_bytes: usize,
}

impl L0Layer {
    fn is_empty(&self) -> bool {
        self.notes.is_empty() && self.replaced.is_empty() && self.subtree_overrides.is_empty()
    }

    fn should_seal(&self) -> bool {
        self.notes.len() >= TIP_FLUSH_NOTES || self.approx_bytes >= TIP_FLUSH_BYTES
    }
}

/// Private mutable command delta. A cut retains it through an Arc before the
/// next command changes it. Note/posting mutations accumulate in a bounded
/// mutable `tip` layer and periodically seal into `layers` (`Arc<Vec<Arc<L0Layer>>>`),
/// giving amortized O(1) copy-on-write cloning across sequential edits.
#[derive(Clone, Default)]
pub struct L0Delta {
    pub(super) layers: Arc<Vec<Arc<L0Layer>>>,
    pub(super) tip: L0Layer,
    /// Union of `replaced` across `layers` and `tip` for O(1) base fast-path checks.
    pub(super) all_replaced: Bitmap,
    /// Current live deleted mask (notes removed and not subsequently re-added).
    pub(super) deleted: Bitmap,
    pub(super) folders: Arc<BTreeMap<u32, (FolderId, Lifecycle)>>,
    pub(super) folder_lookup: Arc<BTreeMap<FolderId, u32>>,
    pub(super) outgoing: Arc<BTreeMap<u32, EdgeOverlay>>,
    pub(super) incoming: Arc<BTreeMap<u32, EdgeOverlay>>,
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
    pub(super) fn iter_layers_newest_first(&self) -> impl Iterator<Item = &L0Layer> {
        std::iter::once(&self.tip).chain(self.layers.iter().rev().map(Arc::as_ref))
    }

    pub(super) fn iter_layers_oldest_first(&self) -> impl Iterator<Item = &L0Layer> {
        self.layers
            .iter()
            .map(Arc::as_ref)
            .chain(std::iter::once(&self.tip))
    }

    fn seal_tip(&mut self) {
        if self.tip.is_empty() {
            return;
        }
        let sealed = std::mem::take(&mut self.tip);
        Arc::make_mut(&mut self.layers).push(Arc::new(sealed));
    }

    fn ensure_tip_accepts_notes(&mut self) {
        // Keep the layer invariant: every layer applies `notes/replaced` BEFORE
        // `subtree_overrides`. If `tip` already carries a subtree move, seal it
        // first so subsequent note edits sit in a newer layer above the move.
        if !self.tip.subtree_overrides.is_empty() || self.tip.should_seal() {
            self.seal_tip();
        }
    }

    pub fn replace_note(&mut self, note: IndexNote<'_>) -> Result<(), IndexError> {
        let NotePostings { ordinary, scalars } = note.postings()?;
        self.ensure_tip_accepts_notes();
        self.remove_replacement_from_tip(note.dense);
        self.tip.replaced.add(note.dense);
        self.all_replaced.add(note.dense);
        if self.deleted.remove_checked(note.dense) {
            self.approx_bytes = self.approx_bytes.saturating_sub(64);
        }
        self.tip.note_lookup.insert(note.id.clone(), note.dense);
        let mut bytes = 256 + 2 * note.id.as_str().len();
        let mut keys = Vec::with_capacity(ordinary.len());
        let mut domains = Vec::with_capacity(scalars.len());
        for key in ordinary {
            self.tip
                .postings
                .entry(key.clone())
                .or_default()
                .add(note.dense);
            bytes = bytes.saturating_add(192 + 2 * key.capacity());
            keys.push(key);
        }
        for (key, (_, scalar)) in scalars {
            self.tip
                .bsi_live
                .entry(key.clone())
                .or_default()
                .insert(note.dense, scalar);
            bytes = bytes.saturating_add(192 + 2 * key.capacity());
            domains.push(key);
        }
        self.tip.notes.insert(
            note.dense,
            Arc::new(ChangedNote {
                id: note.id.clone(),
                header: note.header,
                postings: keys,
                domains,
                bytes,
            }),
        );
        self.tip.approx_bytes = self.tip.approx_bytes.saturating_add(bytes);
        self.node_count = self.node_count.max(note.dense + 1);
        self.approx_bytes = self.approx_bytes.saturating_add(bytes);
        self.last_change = Some(Instant::now());
        if self.tip.should_seal() {
            self.seal_tip();
        }
        Ok(())
    }

    pub fn remove_note(&mut self, dense: u32) {
        self.ensure_tip_accepts_notes();
        self.remove_replacement_from_tip(dense);
        self.tip.replaced.add(dense);
        self.all_replaced.add(dense);
        if self.deleted.add_checked(dense) {
            self.approx_bytes = self.approx_bytes.saturating_add(64);
        }
        self.node_count = self.node_count.max(dense.saturating_add(1));
        self.replace_adjacency(dense, Some(Vec::new()), Some(Vec::new()));
        self.replace_cluster(dense, None);
    }

    fn remove_replacement_from_tip(&mut self, dense: u32) {
        let Some(old) = self.tip.notes.remove(&dense) else {
            return;
        };
        self.tip.note_lookup.remove(&old.id);
        self.tip.approx_bytes = self.tip.approx_bytes.saturating_sub(old.bytes);
        self.approx_bytes = self.approx_bytes.saturating_sub(old.bytes);
        for key in &old.postings {
            if let Some(bitmap) = self.tip.postings.get_mut(key) {
                bitmap.remove(dense);
                if bitmap.is_empty() {
                    self.tip.postings.remove(key);
                }
            }
        }
        for key in &old.domains {
            if let Some(values) = self.tip.bsi_live.get_mut(key) {
                values.remove(&dense);
                if values.is_empty() {
                    self.tip.bsi_live.remove(key);
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
        let overlay = self.tip.subtree_overrides.entry(ancestor).or_default();
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
        let new_bytes = overlay.bytes();
        self.tip.approx_bytes = self
            .tip
            .approx_bytes
            .saturating_sub(old_bytes)
            .saturating_add(new_bytes);
        self.approx_bytes = self
            .approx_bytes
            .saturating_sub(old_bytes)
            .saturating_add(new_bytes);
        self.last_change = Some(Instant::now());
    }

    pub fn replace_adjacency(
        &mut self,
        node: u32,
        outgoing: Option<Vec<u32>>,
        incoming: Option<Vec<u32>>,
    ) {
        for (direction, map) in [
            (outgoing, &mut self.outgoing),
            (incoming, &mut self.incoming),
        ] {
            if let Some(mut edges) = direction {
                edges.sort_unstable();
                edges.dedup();
                let next = EdgeOverlay::Replace(Arc::new(edges));
                let next_bytes = next.approx_bytes();
                if let Some(previous) = Arc::make_mut(map).insert(node, next) {
                    self.approx_bytes = self.approx_bytes.saturating_sub(previous.approx_bytes());
                }
                self.approx_bytes = self.approx_bytes.saturating_add(next_bytes);
            }
        }
        self.last_change = Some(Instant::now());
    }

    /// Incrementally adds/removes edges on `node` without reloading its full
    /// adjacency list (prevents hub amplification on high-degree targets).
    pub(crate) fn apply_adjacency_delta(
        &mut self,
        node: u32,
        incoming: bool,
        added: &[u32],
        removed: &[u32],
    ) {
        if added.is_empty() && removed.is_empty() {
            return;
        }
        let map = if incoming {
            &mut self.incoming
        } else {
            &mut self.outgoing
        };
        let table = Arc::make_mut(map);
        let old_bytes = table.get(&node).map_or(0, EdgeOverlay::approx_bytes);
        match table.get_mut(&node) {
            Some(EdgeOverlay::Replace(existing)) => {
                let mut vec = (**existing).clone();
                if !removed.is_empty() {
                    vec.retain(|edge| !removed.contains(edge));
                }
                vec.extend_from_slice(added);
                vec.sort_unstable();
                vec.dedup();
                *existing = Arc::new(vec);
            }
            Some(EdgeOverlay::Delta {
                added: a,
                removed: r,
            }) => {
                for &edge in removed {
                    // Always tombstone in `r` so a base edge cannot resurrect
                    // across `delete -> re-add -> delete`.
                    a.remove(&edge);
                    r.insert(edge);
                }
                for &edge in added {
                    r.remove(&edge);
                    a.insert(edge);
                }
            }
            None => {
                let mut a = BTreeSet::new();
                let mut r = BTreeSet::new();
                for &edge in removed {
                    r.insert(edge);
                }
                for &edge in added {
                    r.remove(&edge);
                    a.insert(edge);
                }
                table.insert(
                    node,
                    EdgeOverlay::Delta {
                        added: a,
                        removed: r,
                    },
                );
            }
        }
        let new_bytes = table.get(&node).map_or(0, EdgeOverlay::approx_bytes);
        self.approx_bytes = self
            .approx_bytes
            .saturating_sub(old_bytes)
            .saturating_add(new_bytes);
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
        self.last_change = Some(Instant::now());
    }

    pub fn record_events(&mut self, count: u32) {
        if count != 0 {
            self.events = self.events.saturating_add(count);
            self.last_change = Some(Instant::now());
        }
    }

    pub fn is_empty(&self) -> bool {
        self.last_change.is_none() && self.cluster_overlay.is_none()
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

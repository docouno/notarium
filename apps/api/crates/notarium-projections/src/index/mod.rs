//! Compact index writer, immutable mapped reads, and bounded in-memory deltas.

mod builder;
mod delta;
pub(crate) mod model;
mod predicates;

pub use builder::{FastIndexBuilder, GraphSections};
pub use delta::L0Delta;
#[cfg(feature = "test-support")]
pub use model::L0_IDLE;
pub use model::{IndexNote, L0_BYTE_LIMIT, L0_EVENT_LIMIT, NoteSortHeader, PostingKey};
#[cfg(feature = "test-support")]
pub use predicates::FilterCandidates;

use std::{io, sync::Arc};

use croaring::Bitmap;
use notarium_core::{
    DomainError, DomainResult,
    ids::{ClusterId, FolderId, NoteId, ProjectionGeneration},
    model::DenseNodeId,
    value::{ScalarValue, Timestamp},
};

#[cfg(any(test, feature = "test-support"))]
use notarium_core::model::Lifecycle;

#[cfg(any(test, feature = "test-support"))]
pub use crate::mmap::{
    BaseIndexHandle, IndexIdentity, MappedFastIndex, MmapPool, TrustedCheckpoint,
};
#[cfg(not(any(test, feature = "test-support")))]
use crate::mmap::{IndexIdentity, MappedFastIndex};

use delta::{ChangedNote, ClusterOverlay, EdgeOverlay};
use model::{
    BsiKind, FIELD_SCALAR, TAG_NAMESPACE, bucket_key, bucket_marker, field_prefix, simple_scalar,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("checkpoint I/O failed")]
    Io(#[from] io::Error),
    #[error("invalid checkpoint input: {0}")]
    InvalidInput(&'static str),
    #[error("untrusted checkpoint: {0}")]
    Untrusted(&'static str),
}

pub struct IndexView {
    base: Arc<MappedFastIndex>,
    l0: Arc<L0Delta>,
}

impl IndexView {
    pub fn new(base: Arc<MappedFastIndex>, l0: Arc<L0Delta>) -> Self {
        Self { base, l0 }
    }

    pub fn identity(&self) -> &IndexIdentity {
        self.base.identity()
    }

    pub fn generation(&self) -> ProjectionGeneration {
        self.identity().generation
    }

    pub fn dense(&self, index: u32) -> DenseNodeId {
        DenseNodeId::new(self.generation(), index)
    }

    pub fn node_count(&self) -> u32 {
        self.base.node_count().max(self.l0.node_count)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn folder_count(&self) -> u32 {
        self.base.folder_count().max(self.l0.folder_count)
    }

    fn l0_note(&self, index: u32) -> Option<&ChangedNote> {
        for layer in self.l0.iter_layers_newest_first() {
            if layer.replaced.contains(index) {
                return layer.notes.get(&index).map(Arc::as_ref);
            }
        }
        None
    }

    pub fn dense_id(&self, note: &NoteId) -> Option<u32> {
        for layer in self.l0.iter_layers_newest_first() {
            if let Some(&dense) = layer.note_lookup.get(note) {
                // Verify this slot wasn't deleted or overwritten by a newer layer.
                return (self.l0_note(dense).is_some_and(|n| &n.id == note)).then_some(dense);
            }
        }
        self.base
            .lookup(note)
            .filter(|index| !self.l0.all_replaced.contains(*index))
    }

    pub fn dense_id_str(&self, note: &str) -> Option<u32> {
        if !self.l0.all_replaced.is_empty() {
            for layer in self.l0.iter_layers_newest_first() {
                if let Some((&dense, _)) =
                    layer.notes.iter().find(|(_, row)| row.id.as_str() == note)
                {
                    return (self.l0_note(dense).is_some_and(|n| n.id.as_str() == note))
                        .then_some(dense);
                }
            }
        }
        self.base
            .lookup_str(note)
            .filter(|index| !self.l0.all_replaced.contains(*index))
    }

    pub fn note_id(&self, note: DenseNodeId) -> DomainResult<NoteId> {
        let index = note.index(self.generation())?;
        if self.l0.all_replaced.contains(index) {
            return self
                .l0_note(index)
                .map(|row| row.id.clone())
                .ok_or(DomainError::ResourceNotFound);
        }
        self.base.note_id(index)
    }

    pub fn note_id_str(&self, index: u32) -> Option<&str> {
        if self.l0.all_replaced.contains(index) {
            return self.l0_note(index).map(|row| row.id.as_str());
        }
        self.base.note_id_str(index)
    }

    pub fn note_header(&self, index: u32) -> Option<NoteSortHeader> {
        if self.l0.all_replaced.contains(index) {
            return self.l0_note(index).map(|row| row.header);
        }
        self.base.note_header(index)
    }

    pub(crate) fn updated_at_prefix(&self, index: u32) -> Option<(i64, u16)> {
        if self.l0.all_replaced.contains(index) {
            return self.l0_note(index).map(|row| row.header.updated_prefix());
        }
        self.base.updated_at_prefix(index)
    }

    pub fn updated_at(&self, index: u32) -> Option<Timestamp> {
        self.note_header(index)?.updated_at()
    }

    pub fn dense_folder_id(&self, folder: &FolderId) -> Option<u32> {
        self.l0.folder_lookup.get(folder).copied().or_else(|| {
            self.base
                .dense_folder_id(folder)
                .filter(|index| !self.l0.folders.contains_key(index))
        })
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn folder_id_str(&self, index: u32) -> Option<&str> {
        self.l0
            .folders
            .get(&index)
            .map(|(id, _)| id.as_str())
            .or_else(|| self.base.folder_id_str(index))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn folder_lifecycle(&self, index: u32) -> Option<Lifecycle> {
        self.l0
            .folders
            .get(&index)
            .map(|(_, lifecycle)| *lifecycle)
            .or_else(|| self.base.folder_lifecycle(index))
    }

    pub fn tags_bucketed(&self) -> bool {
        self.base
            .has_posting(&bucket_marker(&[TAG_NAMESPACE]), false)
    }

    pub fn posting(&self, key: &PostingKey) -> Result<Bitmap, IndexError> {
        if let PostingKey::ClusterMembers(cluster) = key {
            let mut main = match &self.l0.cluster_overlay {
                Some(ClusterOverlay::Resident(snapshot, _)) => {
                    snapshot.members.get(cluster).cloned().unwrap_or_default()
                }
                Some(ClusterOverlay::Deferred(_)) => Bitmap::new(),
                None => self.base.bitmap(&key.encode(), false)?,
            };
            main.andnot_inplace(&self.l0.cluster_dirty);
            if let Some(live) = self.l0.clusters.get(cluster) {
                main.or_inplace(live);
            }
            main.andnot_inplace(&self.l0.deleted);
            return Ok(main);
        }
        if let PostingKey::FolderSubtree(folder) = key {
            let encoded = key.encode();
            let mut posting = self.base.bitmap(&encoded, false)?;
            for layer in self.l0.iter_layers_oldest_first() {
                if !layer.replaced.is_empty() {
                    posting.andnot_inplace(&layer.replaced);
                }
                if let Some(added) = layer.postings.get(&encoded) {
                    posting.or_inplace(added);
                }
                if let Some(overlay) = layer.subtree_overrides.get(folder) {
                    posting.or_inplace(&overlay.added);
                    posting.andnot_inplace(&overlay.removed);
                }
            }
            return Ok(posting);
        }
        if let PostingKey::Tag(tag) = key
            && self.tags_bucketed()
        {
            let prefix = [TAG_NAMESPACE];
            let slot = bucket_key(&prefix, tag.as_bytes());
            let mut posting = self.base_posting(&slot, false)?;
            let encoded = key.encode();
            posting.or_inplace(&self.l0_posting(&encoded));
            return Ok(posting);
        }
        self.ordinary_posting(&key.encode())
    }

    /// Intersects `target` in place with `key`, avoiding full-bitmap clones
    /// when `L0Delta` has no overrides for `key`.
    pub(crate) fn and_posting_inplace(
        &self,
        target: &mut Bitmap,
        key: &PostingKey,
    ) -> Result<(), IndexError> {
        if target.is_empty() {
            return Ok(());
        }
        if matches!(
            key,
            PostingKey::ClusterMembers(_) | PostingKey::FolderSubtree(_)
        ) || (matches!(key, PostingKey::Tag(_)) && self.tags_bucketed())
        {
            let set = self.posting(key)?;
            target.and_inplace(&set);
            return Ok(());
        }
        let encoded = key.encode();
        let l0_hits = if self.l0.all_replaced.is_empty() {
            None
        } else {
            let hits = self.l0_posting_in(&encoded, target);
            (!hits.is_empty()).then_some(hits)
        };
        if let Some(view) = self.base.bitmap_view(&encoded, false)? {
            if !self.l0.all_replaced.is_empty() {
                target.andnot_inplace(&self.l0.all_replaced);
            }
            target.and_inplace(&view);
        } else {
            target.clear();
        }
        if let Some(hits) = l0_hits {
            target.or_inplace(&hits);
        }
        Ok(())
    }

    /// Subtracts `key` from `target` in place directly against the mapped
    /// `BitmapView` when possible.
    pub(crate) fn andnot_posting_inplace(
        &self,
        target: &mut Bitmap,
        key: &PostingKey,
    ) -> Result<(), IndexError> {
        if target.is_empty() {
            return Ok(());
        }
        if matches!(key, PostingKey::Tag(_)) && self.tags_bucketed() {
            return Err(IndexError::InvalidInput(
                "cannot subtract bucketed tag posting",
            ));
        }
        if matches!(
            key,
            PostingKey::ClusterMembers(_) | PostingKey::FolderSubtree(_)
        ) {
            let set = self.posting(key)?;
            target.andnot_inplace(&set);
            return Ok(());
        }
        let encoded = key.encode();
        if let Some(view) = self.base.bitmap_view(&encoded, false)? {
            if self.l0.all_replaced.is_empty() {
                target.andnot_inplace(&view);
            } else {
                let mut base_in = view.and(target);
                base_in.andnot_inplace(&self.l0.all_replaced);
                target.andnot_inplace(&base_in);
            }
        }
        if !self.l0.all_replaced.is_empty() {
            let l0_hits = self.l0_posting_in(&encoded, target);
            if !l0_hits.is_empty() {
                target.andnot_inplace(&l0_hits);
            }
        }
        Ok(())
    }

    pub(super) fn posting_in(
        &self,
        key: &PostingKey,
        universe: &Bitmap,
    ) -> Result<Bitmap, IndexError> {
        if matches!(
            key,
            PostingKey::ClusterMembers(_) | PostingKey::FolderSubtree(_)
        ) || (matches!(key, PostingKey::Tag(_)) && self.tags_bucketed())
        {
            return self.posting(key).map(|set| set.and(universe));
        }
        self.ordinary_posting_in(&key.encode(), universe)
    }

    fn l0_posting(&self, key: &[u8]) -> Bitmap {
        let mut out = Bitmap::new();
        if self.l0.all_replaced.is_empty() {
            return out;
        }
        let multi_layer = !self.l0.layers.is_empty();
        let mut shadowed = Bitmap::new();
        for layer in self.l0.iter_layers_newest_first() {
            if let Some(p) = layer.postings.get(key) {
                if !multi_layer || shadowed.is_empty() {
                    out.or_inplace(p);
                } else {
                    out.or_inplace(&p.andnot(&shadowed));
                }
            }
            if multi_layer {
                shadowed.or_inplace(&layer.replaced);
            }
        }
        out
    }

    pub(super) fn l0_posting_in(&self, key: &[u8], universe: &Bitmap) -> Bitmap {
        let mut out = Bitmap::new();
        if self.l0.all_replaced.is_empty() || universe.is_empty() {
            return out;
        }
        let multi_layer = !self.l0.layers.is_empty();
        let mut shadowed = Bitmap::new();
        for layer in self.l0.iter_layers_newest_first() {
            if let Some(p) = layer.postings.get(key) {
                let mut hits = p.and(universe);
                if multi_layer && !shadowed.is_empty() {
                    hits.andnot_inplace(&shadowed);
                }
                out.or_inplace(&hits);
            }
            if multi_layer {
                shadowed.or_inplace(&layer.replaced);
            }
        }
        out
    }

    fn ordinary_posting(&self, key: &[u8]) -> Result<Bitmap, IndexError> {
        let mut posting = self.base_posting(key, false)?;
        if !self.l0.all_replaced.is_empty() {
            let live = self.l0_posting(key);
            if !live.is_empty() {
                posting.or_inplace(&live);
            }
        }
        Ok(posting)
    }

    pub(super) fn ordinary_posting_in(
        &self,
        key: &[u8],
        universe: &Bitmap,
    ) -> Result<Bitmap, IndexError> {
        let mut posting = self.base_posting_in(key, false, universe)?;
        if !self.l0.all_replaced.is_empty() {
            let live = self.l0_posting_in(key, universe);
            if !live.is_empty() {
                posting.or_inplace(&live);
            }
        }
        Ok(posting)
    }

    fn base_posting(&self, key: &[u8], bsi: bool) -> Result<Bitmap, IndexError> {
        Ok(self
            .base
            .bitmap_view(key, bsi)?
            .map_or_else(Bitmap::new, |view| {
                if self.l0.all_replaced.is_empty() {
                    view.to_bitmap()
                } else {
                    view.andnot(&self.l0.all_replaced)
                }
            }))
    }

    pub(super) fn base_posting_in(
        &self,
        key: &[u8],
        bsi: bool,
        universe: &Bitmap,
    ) -> Result<Bitmap, IndexError> {
        Ok(self
            .base
            .bitmap_view(key, bsi)?
            .map_or_else(Bitmap::new, |view| {
                let mut result = view.and(universe);
                if !self.l0.all_replaced.is_empty() {
                    result.andnot_inplace(&self.l0.all_replaced);
                }
                result
            }))
    }

    /// Direct scalar columns can be grouped using bitsets. Return None for
    /// buckets or other scalar types, which require exact values from cards.
    pub fn direct_scalar_values(
        &self,
        field: &str,
        capacity: usize,
    ) -> Result<Option<Vec<ScalarValue>>, IndexError> {
        use builder::{BSI_EXISTS, bsi_entry};
        for kind in [BsiKind::Number, BsiKind::Date, BsiKind::Timestamp] {
            let domain = kind.prefix(field);
            if self.base.has_posting(&bsi_entry(&domain, BSI_EXISTS), true)
                || self
                    .l0
                    .iter_layers_newest_first()
                    .any(|layer| layer.bsi_live.contains_key(&domain))
            {
                return Ok(None);
            }
        }
        let prefix = field_prefix(FIELD_SCALAR, field);
        if self.base.has_posting(&bucket_marker(&prefix), false) {
            return Ok(None);
        }
        let mut keys = std::collections::BTreeSet::new();
        if !self.base.visit_posting_keys(&prefix, |key| {
            keys.insert(key.to_vec());
            keys.len() <= capacity
        }) {
            return Ok(None);
        }
        for layer in self.l0.iter_layers_newest_first() {
            for (key, _) in layer
                .postings
                .range(prefix.clone()..)
                .take_while(|(key, _)| key.starts_with(&prefix))
            {
                keys.insert(key.clone());
                if keys.len() > capacity {
                    return Ok(None);
                }
            }
        }
        let mut values = Vec::new();
        for key in keys {
            if !self.ordinary_posting(&key)?.is_empty() {
                let value = simple_scalar(&key[prefix.len()..])
                    .ok_or(IndexError::Untrusted("invalid direct scalar posting"))?;
                values.push(value);
            }
        }
        if !self
            .posting(&PostingKey::FieldNull(field.to_owned()))?
            .is_empty()
        {
            if values.len() == capacity {
                return Ok(None);
            }
            values.push(ScalarValue::Null);
        }
        Ok(Some(values))
    }

    pub fn outgoing(&self, index: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.neighbors(index, false)
    }

    pub fn incoming(&self, index: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.neighbors(index, true)
    }

    fn neighbors(&self, index: u32, incoming: bool) -> impl Iterator<Item = u32> + Send + '_ {
        let edges = if incoming {
            &self.l0.incoming
        } else {
            &self.l0.outgoing
        };
        match edges.get(&index) {
            Some(EdgeOverlay::Replace(vec)) => NeighborIter::Replace(vec.iter().copied()),
            Some(EdgeOverlay::Delta { added, removed }) => NeighborIter::Delta {
                base: self.base.neighbors(incoming, index).iter().peekable(),
                added: added.iter().copied().peekable(),
                removed,
            },
            None => NeighborIter::Base(self.base.neighbors(incoming, index).iter()),
        }
    }
}

enum NeighborIter<'a> {
    Replace(std::iter::Copied<std::slice::Iter<'a, u32>>),
    Base(std::slice::Iter<'a, [u8; 4]>),
    Delta {
        base: std::iter::Peekable<std::slice::Iter<'a, [u8; 4]>>,
        added: std::iter::Peekable<std::iter::Copied<std::collections::btree_set::Iter<'a, u32>>>,
        removed: &'a std::collections::BTreeSet<u32>,
    },
}

impl Iterator for NeighborIter<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        match self {
            Self::Replace(iter) => iter.next(),
            Self::Base(iter) => iter.next().copied().map(u32::from_le_bytes),
            Self::Delta {
                base,
                added,
                removed,
            } => {
                while base
                    .peek()
                    .is_some_and(|raw| removed.contains(&u32::from_le_bytes(**raw)))
                {
                    base.next();
                }
                let next_base = base.peek().map(|raw| u32::from_le_bytes(**raw));
                let next_added = added.peek().copied();
                match (next_base, next_added) {
                    (Some(b), Some(a)) if b < a => {
                        base.next();
                        Some(b)
                    }
                    (Some(b), Some(a)) if a < b => added.next(),
                    (Some(_), Some(_)) => {
                        base.next();
                        added.next()
                    }
                    (Some(b), None) => {
                        base.next();
                        Some(b)
                    }
                    (None, Some(_)) => added.next(),
                    (None, None) => None,
                }
            }
        }
    }
}

/// Zero-allocation cluster key unifying 16-byte mmap cluster IDs and borrowed
/// in-memory `ClusterId` values without heap allocation per node.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum ClusterKey<'a> {
    Bytes([u8; 16]),
    Borrowed(&'a ClusterId),
}

impl<'a> ClusterKey<'a> {
    pub(crate) fn from_borrowed(id: &'a ClusterId) -> Self {
        if let Some(bytes) = decode_v1_cluster_bytes(id) {
            Self::Bytes(bytes)
        } else {
            Self::Borrowed(id)
        }
    }

    pub(crate) fn into_cluster_id(self) -> ClusterId {
        match self {
            Self::Bytes(bytes) => ClusterId::from_bytes(bytes),
            Self::Borrowed(id) => id.clone(),
        }
    }
}

fn decode_v1_cluster_bytes(id: &ClusterId) -> Option<[u8; 16]> {
    let hex_str = id.as_str().strip_prefix(ClusterId::PREFIX)?;
    let raw = hex_str.as_bytes();
    if raw.len() != 32 {
        return None;
    }
    let nibble = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 16];
    for (slot, pair) in out.iter_mut().zip(raw.as_chunks::<2>().0) {
        *slot = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

impl IndexView {
    pub(crate) fn cluster_key(&self, index: u32) -> Option<ClusterKey<'_>> {
        if self.l0.deleted.contains(index) {
            return None;
        }
        if let Some(overridden) = self.l0.cluster_delta.get(&index) {
            return overridden.as_ref().map(ClusterKey::from_borrowed);
        }
        match &self.l0.cluster_overlay {
            Some(ClusterOverlay::Resident(snapshot, _)) => {
                snapshot.cluster(index).map(ClusterKey::from_borrowed)
            }
            Some(ClusterOverlay::Deferred(_)) => None,
            None => self.base.cluster_bytes(index).map(ClusterKey::Bytes),
        }
    }

    pub fn cluster(&self, index: u32) -> Option<ClusterId> {
        self.cluster_key(index).map(ClusterKey::into_cluster_id)
    }

    pub(crate) fn deferred_clusters(&self) -> Option<notarium_core::ids::SpaceSeq> {
        match self.l0.cluster_overlay.as_ref() {
            Some(ClusterOverlay::Deferred(seq)) => Some(*seq),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;

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

use delta::ClusterOverlay;
use model::{BsiKind, FIELD_SCALAR, bucket_marker, field_prefix, simple_scalar};
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

    pub fn dense_id(&self, note: &NoteId) -> Option<u32> {
        self.l0.note_lookup.get(note).copied().or_else(|| {
            self.base
                .lookup(note)
                .filter(|index| !self.l0.replaced.contains(*index))
        })
    }

    pub fn note_id(&self, note: DenseNodeId) -> DomainResult<&NoteId> {
        let index = note.index(self.generation())?;
        if self.l0.replaced.contains(index) {
            return self
                .l0
                .notes
                .get(&index)
                .map(|row| &row.id)
                .ok_or(DomainError::ResourceNotFound);
        }
        self.base.note_id(index)
    }

    pub fn note_id_str(&self, index: u32) -> Option<&str> {
        if self.l0.replaced.contains(index) {
            return self.l0.notes.get(&index).map(|row| row.id.as_str());
        }
        self.base.note_id_str(index)
    }

    pub fn note_header(&self, index: u32) -> Option<NoteSortHeader> {
        if self.l0.replaced.contains(index) {
            return self.l0.notes.get(&index).map(|row| row.header);
        }
        self.base.note_header(index)
    }

    pub(crate) fn updated_at_prefix(&self, index: u32) -> Option<(i64, u16)> {
        if self.l0.replaced.contains(index) {
            return self
                .l0
                .notes
                .get(&index)
                .map(|row| row.header.updated_prefix());
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
        let mut posting = self.ordinary_posting(&key.encode())?;
        if let PostingKey::FolderSubtree(folder) = key
            && let Some(overlay) = self.l0.subtree_overrides.get(folder)
        {
            posting.or_inplace(&overlay.added);
            posting.andnot_inplace(&overlay.removed);
        }
        Ok(posting)
    }

    fn ordinary_posting(&self, key: &[u8]) -> Result<Bitmap, IndexError> {
        let mut posting = self.base_posting(key, false)?;
        if let Some(override_set) = self.l0.postings.get(key) {
            posting.or_inplace(override_set);
        }
        Ok(posting)
    }

    fn base_posting(&self, key: &[u8], bsi: bool) -> Result<Bitmap, IndexError> {
        Ok(self
            .base
            .bitmap_view(key, bsi)?
            .map_or_else(Bitmap::new, |view| {
                if self.l0.replaced.is_empty() {
                    view.to_bitmap()
                } else {
                    view.andnot(&self.l0.replaced)
                }
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
                || self.l0.bsi_live.contains_key(&domain)
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
        for (key, _) in self
            .l0
            .postings
            .range(prefix.clone()..)
            .take_while(|(key, _)| key.starts_with(&prefix))
        {
            keys.insert(key.clone());
            if keys.len() > capacity {
                return Ok(None);
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
        let overlay = edges.get(&index);
        let base = if overlay.is_some() {
            &[][..]
        } else {
            self.base.neighbors(incoming, index)
        };
        overlay
            .into_iter()
            .flatten()
            .copied()
            .chain(base.iter().copied().map(u32::from_le_bytes))
    }

    pub fn cluster(&self, index: u32) -> Option<ClusterId> {
        if self.l0.deleted.contains(index) {
            return None;
        }
        self.l0
            .cluster_delta
            .get(&index)
            .cloned()
            .unwrap_or_else(|| match &self.l0.cluster_overlay {
                Some(ClusterOverlay::Resident(snapshot, _)) => snapshot.cluster(index).cloned(),
                Some(ClusterOverlay::Deferred(_)) => None,
                None => self.base.cluster(index),
            })
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

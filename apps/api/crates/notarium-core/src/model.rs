use crate::{DomainError, DomainResult, error::ValidationReason, ids::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
pub struct HistoryScope {
    pub space_id: SpaceId,
    pub incarnation: HistoryIncarnation,
}
impl HistoryScope {
    /// Call only after admission to this Space, before comparing any sequence.
    pub fn check(&self, expected: &Self) -> DomainResult<()> {
        if self.space_id != expected.space_id {
            return Err(DomainError::ResourceNotFound);
        }
        if self.incarnation != expected.incarnation {
            return Err(DomainError::validation(
                ValidationReason::HistoryIncarnationMismatch,
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NoteRef {
    pub space_id: SpaceId,
    pub note_id: NoteId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FolderRef {
    pub space_id: SpaceId,
    pub folder_id: FolderId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PathTarget {
    pub space_id: SpaceId,
    pub parent: Option<FolderId>,
    pub component: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Lifecycle {
    Active,
    Trashed,
    Purged,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SnapshotCut {
    pub scope: HistoryScope,
    pub generation: ProjectionGeneration,
    pub canonical_seq: SpaceSeq,
    pub projected_seq: SpaceSeq,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DenseNodeId {
    generation: ProjectionGeneration,
    index: u32,
}
impl DenseNodeId {
    pub const fn new(generation: ProjectionGeneration, index: u32) -> Self {
        Self { generation, index }
    }
    pub fn index(self, generation: ProjectionGeneration) -> DomainResult<u32> {
        if generation != self.generation {
            return Err(DomainError::validation(
                ValidationReason::GenerationMismatch,
            ));
        }
        Ok(self.index)
    }
}

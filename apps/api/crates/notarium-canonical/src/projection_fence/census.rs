//! Synthetic scale fixture for the production compact visibility backing.

use super::{
    AbilityId, Arc, DocClass, FenceMemoryUsage, FolderId, FolderRow, Lifecycle, LiveDenseLookup,
    LiveState, NoteId, NoteRow, PortError, SpaceRecord, not_ready,
};

/// An isolated backing for an allocation census. This fixture does not create
/// an owner grant or participate in delivery of any canonical data.
#[doc(hidden)]
pub struct FenceCensusFixture(LiveState);

impl FenceCensusFixture {
    pub fn new(record: SpaceRecord, lookup: Arc<dyn LiveDenseLookup>) -> Result<Self, PortError> {
        Ok(Self(LiveState::new(record, Some(lookup))?))
    }

    pub fn apply_folder(
        &mut self,
        id: FolderId,
        parent: Option<FolderId>,
    ) -> Result<(), PortError> {
        self.0.apply_folder(FolderRow {
            id,
            parent,
            lifecycle: Lifecycle::Active,
            write_locked: false,
            is_project: false,
        })
    }

    pub fn apply_note(
        &mut self,
        id: NoteId,
        parent: FolderId,
        class: DocClass,
        ability: Option<AbilityId>,
    ) -> Result<(), PortError> {
        self.0.apply_note(NoteRow {
            id,
            parent: Some(parent),
            class,
            lifecycle: Lifecycle::Active,
            ability,
        })
    }

    pub fn update_lookup(&mut self, lookup: Arc<dyn LiveDenseLookup>) -> Result<(), PortError> {
        if !self.0.update_lookup(lookup)? {
            return Err(not_ready());
        }
        Ok(())
    }

    pub fn memory_usage(&self) -> FenceMemoryUsage {
        self.0.memory_usage()
    }
}

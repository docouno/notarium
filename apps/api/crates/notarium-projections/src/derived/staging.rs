use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::NoteId,
};

use super::{
    DerivedMutation, ProjectedChatRef, StageKey, invalid_row, records::encode,
    write::encrypted_payload_empty,
};

pub(crate) const MAX_STAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STAGE_ROWS: usize = 8_192;

/// Accumulates up to one bounded page of derived mutations for multi-page
/// Cold Seed staging. Ordinary incremental commands commit directly without
/// roundtripping through `projection_apply_pages`.
#[derive(Default)]
pub(crate) struct StageBuffer {
    mutations: Vec<DerivedMutation>,
    approx_bytes: usize,
    checks: StageChecks,
}

impl StageBuffer {
    pub(crate) fn is_empty(&self) -> bool {
        self.mutations.is_empty()
    }

    pub(crate) fn push(
        &mut self,
        key: &StageKey,
        mutation: &DerivedMutation,
    ) -> Result<bool, PortError> {
        if self.mutations.len() >= MAX_STAGE_ROWS {
            return Ok(false);
        }
        let approx = approx_mutation_bytes(mutation);
        if !self.mutations.is_empty() && self.approx_bytes.saturating_add(approx) > MAX_STAGE_BYTES
        {
            return Ok(false);
        }
        self.checks.record(key, mutation)?;
        self.approx_bytes = self.approx_bytes.saturating_add(approx);
        self.mutations.push(mutation.clone());
        Ok(true)
    }

    pub(super) fn finish(self) -> Result<StagePage, PortError> {
        let payload = encode(&self.mutations)?;
        Ok(StagePage {
            payload,
            checks: self.checks,
        })
    }
}

pub(crate) fn approx_mutation_bytes(mutation: &DerivedMutation) -> usize {
    const OVERHEAD: usize = 160;
    match mutation {
        DerivedMutation::UpsertNote(row) => {
            OVERHEAD
                + row.slug.len()
                + row.slug_fold.len()
                + row.title.len()
                + row.title_fold.len()
                + row.preview.len()
                + row.tags_msgpack.len()
                + row.view_blocks_msgpack.len()
                + row.raw_fields_msgpack.len()
                + row.header_diagnostic_msgpack.len()
                + row.evaluated_fields_msgpack.len()
                + row.diagnostics_msgpack.len()
        }
        DerivedMutation::UpsertFolder(row) => {
            OVERHEAD
                + row.slug.len()
                + row.slug_fold.len()
                + row.display_name.len()
                + row.norm_path_prefix.as_ref().map_or(0, String::len)
                + row.display_path_prefix.len()
                + row.project_slug.as_ref().map_or(0, String::len)
        }
        DerivedMutation::UpsertNoteAlias(row) => {
            OVERHEAD + row.old_slug_fold.len() + row.old_title_norm.len()
        }
        DerivedMutation::UpsertFolderAlias(row) => OVERHEAD + row.old_slug_fold.len(),
        DerivedMutation::UpsertViewDescriptor(row) => {
            OVERHEAD
                + row.state.len()
                + row.view_kind.as_ref().map_or(0, String::len)
                + row.compiled_msgpack.as_ref().map_or(0, Vec::len)
                + row.diagnostics_msgpack.len()
        }
        DerivedMutation::UpsertViewRank(row) => {
            OVERHEAD
                + row.group_key_hex.len()
                + row.group_key_msgpack.len()
                + row.sort_rank_lexo.len()
        }
        DerivedMutation::UpsertCandidate(row) => OVERHEAD + row.leaf_norm_key.len(),
        DerivedMutation::UpsertLink(row) => {
            OVERHEAD + row.raw_target.len() + row.dir_norm_prefix.len() + row.leaf_norm_key.len()
        }
        DerivedMutation::UpsertCluster(row) => {
            OVERHEAD + row.members_roaring.len() + row.inter_edges_msgpack.len()
        }
        DerivedMutation::UpsertChatThread(_)
        | DerivedMutation::UpsertChatRef(_)
        | DerivedMutation::DeleteNoteCandidates(_)
        | DerivedMutation::DeleteNoteLinks(_)
        | DerivedMutation::DeleteLink(..)
        | DerivedMutation::DeleteDescriptors(_)
        | DerivedMutation::DeleteRank(..)
        | DerivedMutation::DeleteClusters
        | DerivedMutation::InvalidateCheckpointClusters
        | DerivedMutation::PurgeNote(_)
        | DerivedMutation::RedactChatEntry(..) => OVERHEAD,
    }
}

#[derive(Default)]
pub(super) struct StageChecks {
    pub(super) destructive: bool,
    pub(super) notes: BTreeSet<NoteId>,
    pub(super) references: Vec<ProjectedChatRef>,
}

impl StageChecks {
    fn record(&mut self, key: &StageKey, mutation: &DerivedMutation) -> Result<(), PortError> {
        match mutation {
            DerivedMutation::UpsertNote(row) => {
                if row.space_id != key.scope.space_id
                    || (row.doc_class == DocClass::EncryptedNote && !encrypted_payload_empty(row)?)
                {
                    return Err(invalid_row());
                }
                self.notes.insert(row.note_id.clone());
            }
            DerivedMutation::UpsertViewDescriptor(row) => {
                if row.space_id != key.scope.space_id {
                    return Err(invalid_row());
                }
                self.notes.insert(row.view_note_id.clone());
            }
            DerivedMutation::UpsertChatRef(reference) => {
                self.references.push(reference.clone());
            }
            DerivedMutation::PurgeNote(_) | DerivedMutation::RedactChatEntry(..) => {
                self.destructive = true;
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) struct StagePage {
    pub(super) payload: Vec<u8>,
    pub(super) checks: StageChecks,
}

impl StagePage {
    pub(super) fn single(key: &StageKey, mutation: &DerivedMutation) -> Result<Self, PortError> {
        let mut checks = StageChecks::default();
        checks.record(key, mutation)?;
        let payload = encode(&[mutation])?;
        Ok(Self { payload, checks })
    }
}

pub(super) fn invalid_limit() -> PortError {
    DomainError::validation(ValidationReason::InvalidLimit).into()
}

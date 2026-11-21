use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::FolderId,
};

use crate::index::{IndexView, L0Delta, PostingKey};

use super::{checkpoint_error, records::FolderCatalog};

/// A folder move between active ancestors preserves each note's own parent,
/// class and lifecycle. Only the old and new ancestor chains gain or lose
/// subtree members. Their counts move with the already projected subtree.
pub(super) fn apply_active_move(
    old_folders: &FolderCatalog,
    folders: &mut FolderCatalog,
    changed_folders: &[FolderId],
    index: &IndexView,
    delta: &mut L0Delta,
) -> Result<bool, PortError> {
    let [moved] = changed_folders else {
        return Ok(false);
    };
    let Some((old, new)) = old_folders.rows.get(moved).zip(folders.rows.get(moved)) else {
        return Ok(false);
    };
    if old.parent_folder_id.is_none()
        || new.parent_folder_id.is_none()
        || old.parent_folder_id == new.parent_folder_id
        || old.dense_folder_id != new.dense_folder_id
    {
        return Ok(false);
    }

    let before = old_folders.location(moved)?;
    let after = folders.location(moved)?;
    if before.trashed || after.trashed {
        return Ok(false);
    }
    let members = index
        .posting(&PostingKey::FolderSubtree(old.dense_folder_id))
        .map_err(checkpoint_error)?;
    let count = old.active_note_count;
    let old_ancestors: BTreeSet<_> = before.ids.iter().skip(1).collect();
    let new_ancestors: BTreeSet<_> = after.ids.iter().skip(1).collect();
    for (ancestors, include) in [
        (old_ancestors.difference(&new_ancestors), false),
        (new_ancestors.difference(&old_ancestors), true),
    ] {
        for ancestor in ancestors.copied() {
            let row = folders
                .rows
                .get_mut(ancestor)
                .ok_or(DomainError::ResourceNotFound)?;
            row.active_note_count = if include {
                row.active_note_count.checked_add(count)
            } else {
                row.active_note_count.checked_sub(count)
            }
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            delta.set_subtree_membership(row.dense_folder_id, &members, include);
        }
    }
    Ok(true)
}

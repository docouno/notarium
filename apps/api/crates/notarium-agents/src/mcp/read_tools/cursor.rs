use super::super::invalid;
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, PrincipalId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    query::KeysetCursor,
};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

const CURSOR_PREFIX: &str = "notes_";
const CURSOR_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_CURSORS: usize = 512;
const MAX_CURSORS_PER_PRINCIPAL: usize = 64;

/// A continuation can point past a row that was omitted by an egress fence.
/// Keep both storage cursor positions server-side so their contents stay private.
#[derive(Default)]
pub(in super::super) struct NoteCursors {
    entries: Mutex<VecDeque<CursorEntry>>,
}

struct CursorEntry {
    id: u128,
    principal: PrincipalId,
    opened: Instant,
    cursor: NoteContinuation,
}

#[derive(Clone)]
pub(super) struct NoteContinuation {
    pub folder: FolderRef,
    pub scope: HistoryScope,
    pub fingerprint: ContentDigest,
    pub notes: Option<KeysetCursor>,
    pub folders: Option<FolderId>,
    pub folders_cut: Option<SpaceSeq>,
    pub total: Option<u64>,
}

impl NoteCursors {
    pub(super) fn insert(
        &self,
        principal: PrincipalId,
        cursor: NoteContinuation,
    ) -> Result<String, PortError> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| invalid(ValidationReason::InvalidState))?;
        let id = u128::from_be_bytes(bytes);
        let mut entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        entries.retain(|entry| entry.opened.elapsed() < CURSOR_TTL);
        if entries.iter().any(|entry| entry.id == id) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let mut owned = entries
            .iter()
            .filter(|entry| entry.principal == principal)
            .count();
        while owned >= MAX_CURSORS_PER_PRINCIPAL {
            if let Some(pos) = entries
                .iter()
                .position(|entry| entry.principal == principal)
            {
                entries.remove(pos);
                owned -= 1;
            } else {
                break;
            }
        }
        if entries.len() == MAX_CURSORS {
            entries.pop_front();
        }
        entries.push_back(CursorEntry {
            id,
            principal,
            opened: Instant::now(),
            cursor,
        });
        Ok(format!("{CURSOR_PREFIX}{id:032x}"))
    }

    pub(super) fn open(
        &self,
        principal: &PrincipalId,
        token: &str,
    ) -> Result<NoteContinuation, PortError> {
        let stale = || invalid(ValidationReason::CursorStale);
        let key = token.strip_prefix(CURSOR_PREFIX).ok_or_else(stale)?;
        if key.len() != 32 {
            return Err(stale());
        }
        let id = u128::from_str_radix(key, 16).map_err(|_| stale())?;
        let entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        entries
            .iter()
            .find(|entry| {
                entry.id == id
                    && &entry.principal == principal
                    && entry.opened.elapsed() < CURSOR_TTL
            })
            .map(|entry| entry.cursor.clone())
            .ok_or_else(stale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::ids::{HistoryIncarnation, SpaceId};

    #[test]
    fn continuation_replays_only_against_the_registering_instance() {
        let cursors = NoteCursors::default();
        let space_id = SpaceId::from_bytes([1; 16]);
        let scope = HistoryScope {
            space_id: space_id.clone(),
            incarnation: HistoryIncarnation::from_bytes([2; 16]),
        };
        let folder = FolderRef {
            space_id,
            folder_id: FolderId::from_bytes([3; 16]),
        };
        let child = FolderId::from_bytes([4; 16]);
        let principal = PrincipalId::from_bytes([9; 16]);
        let token = cursors
            .insert(
                principal.clone(),
                NoteContinuation {
                    folder: folder.clone(),
                    scope: scope.clone(),
                    fingerprint: ContentDigest::from_bytes([5; 32]),
                    notes: None,
                    folders: Some(child.clone()),
                    folders_cut: None,
                    total: None,
                },
            )
            .unwrap();

        assert!(!token.contains(child.as_str()));
        assert!(cursors.open(&principal, &format!("{token}0")).is_err());
        assert!(NoteCursors::default().open(&principal, &token).is_err());
        for _ in 0..2 {
            let cursor = cursors.open(&principal, &token).unwrap();
            assert_eq!(cursor.folder, folder);
            assert_eq!(cursor.folders.as_ref(), Some(&child));
        }

        // Per-principal quota prevents one noisy principal from evicting another,
        // and cross-principal cursor lookups fail uniformly with CursorStale.
        let noisy = PrincipalId::from_bytes([10; 16]);
        assert!(matches!(
            cursors.open(&noisy, &token),
            Err(PortError::Domain(
                notarium_core::DomainError::ValidationFailed { diagnostic }
            )) if diagnostic.reason == ValidationReason::CursorStale
        ));
        for _ in 0..(MAX_CURSORS_PER_PRINCIPAL * 2) {
            let _ = cursors
                .insert(
                    noisy.clone(),
                    NoteContinuation {
                        folder: folder.clone(),
                        scope: scope.clone(),
                        fingerprint: ContentDigest::from_bytes([6; 32]),
                        notes: None,
                        folders: None,
                        folders_cut: None,
                        total: None,
                    },
                )
                .unwrap();
        }
        assert!(cursors.open(&principal, &token).is_ok());
    }
}

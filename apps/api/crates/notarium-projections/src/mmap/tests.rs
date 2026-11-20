use std::{fs, num::NonZeroUsize, path::PathBuf};

use notarium_core::{
    classes::DocClass,
    ids::{FolderId, HistoryIncarnation, NoteId, SpaceId},
    value::Timestamp,
};

use super::*;
use crate::index::{FastIndexBuilder, IndexNote, NoteSortHeader};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut suffix = [0; 16];
        getrandom::fill(&mut suffix).unwrap();
        Self(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("notarium-checkpoint-{}", hex::encode(suffix))),
        )
    }

    fn publish(&self) -> (BaseIndexHandle, TrustedCheckpoint) {
        let identity = IndexIdentity {
            generation: ProjectionGeneration::new(7).unwrap(),
            scope: HistoryScope {
                space_id: SpaceId::from_bytes([1; 16]),
                incarnation: HistoryIncarnation::from_bytes([2; 16]),
            },
            seq: SpaceSeq::new(6).unwrap(),
        };
        let mut builder = FastIndexBuilder::default();
        builder
            .add_folder(0, &FolderId::from_bytes([3; 16]), Lifecycle::Active)
            .unwrap();
        let time = Timestamp::parse("2020-01-01T00:00:00Z").unwrap();
        builder
            .add_note(IndexNote {
                dense: 0,
                id: &NoteId::from_bytes([4; 16]),
                header: NoteSortHeader::new(time, time, 0, DocClass::UserDoc, Lifecycle::Active),
                ancestors: &[],
                trashed_ancestor: false,
                fields: &Default::default(),
                tags: &["tag".to_owned()],
                ability: None,
            })
            .unwrap();
        builder
            .publish(&self.0.join("private").join("fast_index_6.mmap"), identity)
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn overwrite_unmapped(path: &Path, bytes: &[u8]) {
    remove_readonly(path).unwrap();
    fs::write(path, bytes).unwrap();
    let mut mode = fs::metadata(path).unwrap().permissions();
    mode.set_readonly(true);
    fs::set_permissions(path, mode).unwrap();
}

fn fix_footer(bytes: &mut [u8]) {
    let footer = bytes.len() - format::DIGEST_SIZE;
    let hash = blake3::hash(&bytes[..footer]);
    bytes[footer..].copy_from_slice(hash.as_bytes());
}

#[test]
fn altered_or_forged_file_is_rejected_before_frozen() {
    let scratch = Fixture::new();
    let (handle, trusted) = scratch.publish();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let bytes = fs::read(handle.path()).unwrap();
    let mut corrupt = bytes.clone();
    raw::FROZEN_CALLS.set(0);

    // A modified, correctly aligned arena and a freshly recomputed footer are
    // insufficient to establish that the file came from the local serializer.
    let arena_start = u64_at(
        &bytes,
        format::HEADER_SIZE + (SectionKind::BitmapArena as usize - 1) * 32 + 8,
    )
    .unwrap() as usize;
    corrupt[arena_start] ^= 0x01;
    overwrite_unmapped(handle.path(), &corrupt);
    assert!(matches!(
        handle.open(&pool),
        Err(IndexError::Untrusted("invalid checkpoint checksum"))
    ));
    fix_footer(&mut corrupt);
    overwrite_unmapped(handle.path(), &corrupt);
    assert!(matches!(
        handle.open(&pool),
        Err(IndexError::Untrusted(
            "checkpoint does not match writer digest"
        ))
    ));
    assert_eq!(pool.live_mmap_count(), 0);
    assert_eq!(raw::FROZEN_CALLS.get(), 0);

    let mut wrong_abi = trusted;
    wrong_abi.abi.push_str(";changed");
    assert!(
        BaseIndexHandle::restore(handle.path(), handle.identity().clone(), wrong_abi, None)
            .is_err()
    );
    overwrite_unmapped(handle.path(), &bytes);
    let map = handle.open(&pool).unwrap();
    assert_eq!(map.bitmap(&[1], false).unwrap().cardinality(), 1);
    assert_eq!(raw::FROZEN_CALLS.get(), 1);
}

#[test]
fn inconsistent_section_offsets_and_lengths_fail_even_with_a_matching_test_digest() {
    let scratch = Fixture::new();
    let (handle, _) = scratch.publish();
    let bytes = fs::read(handle.path()).unwrap();
    let sections = u32_at(&bytes, 56).unwrap() as usize;
    for section in 0..sections {
        for delta in [8, 16] {
            let field = format::HEADER_SIZE + section * 32 + delta;
            let mut forged = bytes.clone();
            let replacement = if delta == 8 {
                u64_at(&bytes, field).unwrap() + 1
            } else {
                u64::MAX
            };
            forged[field..field + 8].copy_from_slice(&replacement.to_le_bytes());
            fix_footer(&mut forged);
            let digest = blake3::hash(&forged);
            assert!(
                format::decode(
                    &forged,
                    handle.identity(),
                    forged.len() as u64,
                    digest.as_bytes()
                )
                .is_err()
            );
        }
    }
}

#[test]
fn file_name_is_immutable_and_missing_files_have_no_mapping() {
    let scratch = Fixture::new();
    let (handle, _) = scratch.publish();
    let still_published =
        FastIndexBuilder::default().publish(handle.path(), handle.identity().clone());
    assert!(
        matches!(still_published, Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists)
    );
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let found = handle.open(&pool).unwrap();
    assert_eq!(found.node_count(), 1);
    drop(found);
    pool.evict(&handle);
    BaseIndexHandle::discard_unleased(handle.path()).unwrap();
    assert!(
        matches!(handle.open(&pool), Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::NotFound)
    );
}

#[cfg(unix)]
#[test]
fn invalidated_history_can_reuse_path_without_old_lease_deleting_it() {
    let scratch = Fixture::new();
    let (old, _) = scratch.publish();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let old_map = old.open(&pool).unwrap();
    old.retire(&pool);
    old.invalidate(&pool).unwrap();
    assert!(matches!(old.open(&pool), Err(IndexError::Untrusted(_))));
    assert_eq!(old_map.node_count(), 1);

    let mut identity = old.identity().clone();
    identity.scope.incarnation = HistoryIncarnation::from_bytes([9; 16]);
    let path = old.path().to_owned();
    let (new, _) = FastIndexBuilder::default()
        .publish(&path, identity)
        .unwrap();
    old.invalidate(&pool).unwrap();
    drop(old_map);
    drop(old);

    assert_eq!(new.open(&pool).unwrap().node_count(), 0);
    assert!(path.is_file());
}

#[cfg(unix)]
#[test]
fn delayed_retirement_only_unlinks_its_original_vnode() {
    let scratch = Fixture::new();
    let (retired, _) = scratch.publish();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let retained = retired.open(&pool).unwrap();
    retired.retire(&pool);
    let path = retired.path().to_owned();
    let mut identity = retired.identity().clone();
    identity.scope.incarnation = HistoryIncarnation::from_bytes([9; 16]);

    // Startup/restore has revoked old readers and may reclaim this path even
    // when a revoked request still pins its original mapped vnode.
    BaseIndexHandle::discard_unleased(&path).unwrap();
    let (replacement, _) = FastIndexBuilder::default()
        .publish(&path, identity)
        .unwrap();
    drop(retired);
    drop(retained);

    assert_eq!(replacement.open(&pool).unwrap().node_count(), 0);
    assert!(path.exists());
}

#[test]
fn pending_repair_can_reauthenticate_the_unchanged_file() {
    let scratch = Fixture::new();
    let (old, record) = scratch.publish();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let retained = old.open(&pool).unwrap();
    assert!(old.request_repair());
    assert!(old.repair_pending());
    assert!(matches!(old.open(&pool), Err(IndexError::Untrusted(_))));

    let reauthenticated =
        BaseIndexHandle::restore(old.path(), old.identity().clone(), record, None).unwrap();
    assert!(!old.shares_lease(&reauthenticated));
    assert_eq!(retained.node_count(), 1);
    assert_eq!(reauthenticated.open(&pool).unwrap().node_count(), 1);
    drop(old);
    drop(retained);
    assert!(reauthenticated.path().is_file());
}

#[test]
fn retirement_reaches_registered_and_late_leases_of_the_same_vnode() {
    let scratch = Fixture::new();
    let (first, record) = scratch.publish();
    let first_pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let second_pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    first.register_for_erasure(&first_pool);
    let retained = first.open(&first_pool).unwrap();
    let path = first.path().to_owned();
    let identity = first.identity().clone();

    let second = BaseIndexHandle::restore(&path, identity.clone(), record.clone(), None).unwrap();
    second.register_for_erasure(&second_pool);
    assert!(!first.shares_lease(&second));
    assert_eq!(second.open(&second_pool).unwrap().node_count(), 1);
    second.retire(&second_pool);
    assert_eq!(first_pool.live_mmap_count(), 1);
    assert_eq!(second_pool.live_mmap_count(), 0);
    drop(second);

    let late = BaseIndexHandle::restore(&path, identity, record, None).unwrap();
    late.register_for_erasure(&second_pool);
    assert_eq!(late.open(&second_pool).unwrap().node_count(), 1);
    assert_eq!(second_pool.live_mmap_count(), 0);
    drop(first);
    drop(retained);
    assert!(path.is_file());
    drop(late);
    assert!(!path.exists());
}

#[test]
fn unpublished_reclamation_defers_to_the_identity_and_live_lease() {
    let scratch = Fixture::new();
    let (base, _) = scratch.publish();
    let pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    let path = base.path().to_owned();
    let identity = base.identity().clone();
    let mut foreign = identity.clone();
    foreign.scope.incarnation = HistoryIncarnation::from_bytes([9; 16]);
    assert!(!BaseIndexHandle::discard_unleased_matching(&path, &foreign).unwrap());
    base.register_for_erasure(&pool);
    assert!(!BaseIndexHandle::discard_unleased_matching(&path, &identity).unwrap());
    assert!(path.is_file());
    drop(base);
    assert!(BaseIndexHandle::discard_unleased_matching(&path, &identity).unwrap());
    assert!(!path.exists());
    assert!(BaseIndexHandle::discard_unleased_matching(&path, &identity).unwrap());
}

#[test]
fn registered_purge_unlinks_after_both_reopened_file_leases_end() {
    let scratch = Fixture::new();
    let (old, trusted) = scratch.publish();
    let path = old.path().to_owned();
    let identity = old.identity().clone();
    let previous_pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    old.register_for_erasure(&previous_pool);
    let retained = old.open(&previous_pool).unwrap();

    let reopened = BaseIndexHandle::restore(&path, identity.clone(), trusted, None).unwrap();
    let new_pool = MmapPool::new(NonZeroUsize::new(1).unwrap());
    reopened.register_for_erasure(&new_pool);
    let latest = reopened.open(&new_pool).unwrap();
    BaseIndexHandle::purge_registered(
        path.parent().unwrap(),
        identity.generation,
        &identity.scope,
        identity.seq.checked_next().unwrap(),
    )
    .unwrap();
    assert!(old.open(&previous_pool).is_err());
    assert!(reopened.open(&new_pool).is_err());
    // On Unix and Windows (FILE_SHARE_DELETE + rename-to-tombstone), purge
    // removes the canonical directory entry immediately while existing mappings
    // remain valid until dropped. On other targets, unlink waits for release.
    #[cfg(any(unix, windows))]
    assert!(!path.exists());
    drop(old);
    drop(reopened);
    drop(latest);
    #[cfg(not(any(unix, windows)))]
    assert!(path.is_file());
    drop(retained);
    assert!(!path.exists());
}

#[test]
fn orphan_cleanup_cannot_unlink_the_same_name_in_a_restored_history() {
    let scratch = Fixture::new();
    let (old, _) = scratch.publish();
    let path = old.path().to_owned();
    let old_identity = old.identity().clone();
    BaseIndexHandle::discard_unleased(&path).unwrap();
    let mut restored = old_identity.clone();
    restored.scope.incarnation = HistoryIncarnation::from_bytes([9; 16]);
    let (replacement, _) = FastIndexBuilder::default()
        .publish(&path, restored.clone())
        .unwrap();
    drop(replacement);

    BaseIndexHandle::discard_unleased_matching(&path, &old_identity).unwrap();
    assert!(path.is_file());
    BaseIndexHandle::discard_unleased_matching(&path, &restored).unwrap();
    assert!(!path.exists());
}

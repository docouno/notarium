use std::{fs, os::unix::fs::symlink};

use notarium_canonical::blobs::{encode_zstd_level3, local::LocalBlobStore};
use notarium_core::ids::ContentDigest;

use crate::support::{TempDataRoot, sample_space_id};

#[test]
fn every_local_blob_component_requires_a_real_directory_or_file() {
    let raw = b"canonical blob";
    let frame = encode_zstd_level3(raw).unwrap();
    let digest = ContentDigest::from_bytes(*blake3::hash(raw).as_bytes());
    let space = sample_space_id(5);
    for warm_cache in [true, false] {
        for component in 0..4 {
            let temp = TempDataRoot::new("cas-components");
            let root = temp.data_root();
            let store = LocalBlobStore::open(&root).unwrap();
            let pending = store
                .stage_physical_file(&space, digest, raw.len() as u64, &frame)
                .unwrap();
            store.flush_dir_syncs(&pending).unwrap();
            if !warm_cache {
                store.clear_cached_dirs();
            }
            let blob = root.blob(&space, digest);
            let name = blob.ancestors().nth(component).unwrap();
            let original = name.with_extension("original");
            fs::rename(name, &original).unwrap();
            symlink(original.file_name().unwrap(), name).unwrap();

            assert!(
                store
                    .read_verified(&space, digest, raw.len() as u64)
                    .is_err()
            );
            assert!(store.has_physical_file(&space, digest).is_err());
            assert!(
                store
                    .stage_physical_file(&space, digest, raw.len() as u64, &frame)
                    .is_err()
            );
            assert!(store.delete_physical_file(&space, digest).is_err());

            fs::remove_file(name).unwrap();
            fs::rename(original, name).unwrap();
            assert_eq!(
                store
                    .read_verified(&space, digest, raw.len() as u64)
                    .unwrap(),
                raw
            );
        }
    }
}

#[test]
fn deferred_publication_retains_its_directory_and_rejects_a_replaced_binding() {
    let temp = TempDataRoot::new("cas-directory-barrier");
    let root = temp.data_root();
    let store = LocalBlobStore::open(&root).unwrap();
    let raw = b"deferred blob";
    let frame = encode_zstd_level3(raw).unwrap();
    let digest = ContentDigest::from_bytes(*blake3::hash(raw).as_bytes());
    let space = sample_space_id(6);
    let (pending, staged) = store
        .stage_physical_file_deferred(&space, digest, raw.len() as u64, &frame)
        .unwrap();
    let blob = root.blob(&space, digest);
    let shard = blob.parent().unwrap();
    let original = shard.with_extension("original");
    fs::rename(shard, &original).unwrap();
    fs::create_dir(shard).unwrap();
    staged.unwrap().rename_into_place().unwrap();
    assert!(!blob.exists());
    assert_eq!(
        fs::read(original.join(blob.file_name().unwrap())).unwrap(),
        frame
    );
    assert!(store.flush_dir_syncs(&pending).is_err());
}

#[test]
fn bootstrap_rejects_linked_staging_and_quarantine_directories() {
    for name in [".staging", ".quarantine"] {
        let temp = TempDataRoot::new("cas-bootstrap-directories");
        let root = temp.data_root();
        let blobs = root.root().join("blobs");
        fs::create_dir_all(blobs.join("diagnostic")).unwrap();
        symlink("diagnostic", blobs.join(name)).unwrap();
        assert!(LocalBlobStore::open(&root).is_err());
    }
}

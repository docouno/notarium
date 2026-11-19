use super::*;
use notarium_core::epoch::DataRoot;
use std::{
    fs,
    time::{Duration, UNIX_EPOCH},
};
use tempfile::TempDir;

const NOTE: &str = "note.md";
const OPERATION: &str = "0202020202020202";

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    vault: PathBuf,
    data: DataRoot,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        // macOS exposes the system temp directory through /var.
        let root = fs::canonicalize(temp.path()).unwrap();
        let vault = root.join("vault");
        #[cfg(not(windows))]
        fs::create_dir(&vault).unwrap();
        #[cfg(windows)]
        create_owner_only_test_vault(&root, OsStr::new("vault")).unwrap();
        let data = DataRoot::new(root.join("private"));
        Self {
            _temp: temp,
            root,
            vault,
            data,
        }
    }

    fn open(&self) -> ValidatedRoots {
        ValidatedRoots::open(&self.data, Some(&self.vault)).unwrap()
    }

    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.vault.join(name), bytes).unwrap();
    }

    fn edit_by_replacing(&self, name: &str, bytes: &[u8]) {
        let staged = self.vault.join("editor.tmp");
        fs::write(&staged, bytes).unwrap();
        fs::rename(staged, self.vault.join(name)).unwrap();
    }
}

fn path() -> &'static Path {
    Path::new(NOTE)
}

fn slot() -> PathBuf {
    VaultDir::operation_slot(path(), OPERATION).unwrap()
}

#[test]
fn overlapping_or_missing_roots_do_not_create_private_data() {
    let fixture = Fixture::new();
    let nested = DataRoot::new(fixture.vault.join("private/inside"));
    assert!(ValidatedRoots::open(&nested, Some(&fixture.vault)).is_err());
    assert!(!fixture.vault.join("private").exists());

    assert!(ValidatedRoots::open(&fixture.data, Some(&fixture.vault.join("missing"))).is_err());
    assert!(!fixture.data.root().exists());

    let private = DataRoot::new(&fixture.root);
    assert!(ValidatedRoots::open(&private, Some(&fixture.vault)).is_err());
    assert!(ValidatedRoots::open(&private, Some(&fixture.root)).is_err());
}

#[test]
fn held_roots_detect_replacement_and_sidecar_lock_is_exclusive() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let lock = roots.acquire_sidecar_lock().unwrap();
    assert_eq!(
        roots.acquire_sidecar_lock().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(lock);
    assert!(roots.acquire_sidecar_lock().is_ok());

    #[cfg(unix)]
    {
        fs::rename(&fixture.vault, fixture.root.join("retired")).unwrap();
        fs::create_dir(&fixture.vault).unwrap();
        assert!(roots.verify_current().is_err());
    }
}

#[cfg(unix)]
#[test]
fn private_root_rejects_replaceable_ancestor_and_accepts_sticky_temp() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let shared = fixture.root.join("shared");
    fs::create_dir(&shared).unwrap();
    let data = DataRoot::new(shared.join(".local/share/notarium"));
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    let denied = ValidatedRoots::open(&data, Some(&fixture.vault)).unwrap_err();
    assert_eq!(denied.kind(), io::ErrorKind::PermissionDenied);
    assert!(!shared.join(".local").exists());

    fs::set_permissions(&shared, fs::Permissions::from_mode(0o1777)).unwrap();
    let roots = ValidatedRoots::open(&data, Some(&fixture.vault)).unwrap();
    assert_eq!(roots.data_root(), &data);
    assert_eq!(
        fs::metadata(data.root()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(roots.acquire_sidecar_lock().is_ok());
}

#[cfg(unix)]
#[test]
fn insecure_data_root_and_vault_links_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let fixture = Fixture::new();
    fs::create_dir(fixture.data.root()).unwrap();
    fs::set_permissions(fixture.data.root(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        ValidatedRoots::open(&fixture.data, Some(&fixture.vault))
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied,
    );
    assert_eq!(
        fs::metadata(fixture.data.root())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    fs::remove_dir(fixture.data.root()).unwrap();

    symlink(&fixture.vault, fixture.root.join("alias")).unwrap();
    assert!(ValidatedRoots::open(&fixture.data, Some(&fixture.root.join("alias"))).is_err());
    assert!(!fixture.data.root().exists());

    let roots = fixture.open();
    assert_eq!(
        fs::metadata(fixture.data.root())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let vault = roots.vault().unwrap();
    let secret = fixture.data.root().join("secret");
    fs::write(&secret, b"private").unwrap();
    symlink(&secret, fixture.vault.join("link.md")).unwrap();
    symlink(fixture.data.root(), fixture.vault.join("child")).unwrap();
    fs::hard_link(&secret, fixture.vault.join("hard.md")).unwrap();
    assert_eq!(
        vault.entry_kind(Path::new("link.md")).unwrap(),
        Some(EntryKind::Special)
    );
    assert!(vault.read(Path::new("link.md"), 99).is_err());
    assert_eq!(
        vault.entry_kind_exact(Path::new("link.md")).unwrap(),
        Some(EntryKind::Special)
    );
    assert!(vault.read(Path::new("hard.md"), 99).is_err());
    assert!(vault.read(Path::new("child/secret"), 99).is_err());
    assert!(vault.entry_kind_exact(Path::new("child/secret")).is_err());
    assert!(vault.create_dir_all(Path::new("child/new")).is_err());
    assert!(vault.create_dir_all(Path::new("../outside")).is_err());
    assert!(vault.create_dir_all(Path::new("valid/./child")).is_err());
    assert!(vault.read(Path::new("note.md/."), 32).is_err());
    assert!(!fixture.data.root().join("new").exists());
    assert_eq!(fs::read(secret).unwrap(), b"private");
}

#[test]
fn exact_entry_checks_the_leaf_and_every_parent_spelling() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    fs::create_dir(fixture.vault.join("Drafts")).unwrap();
    fixture.write("Drafts/Note.md", b"content");
    fixture.write("Alpha.md", b"root content");

    #[cfg(windows)]
    {
        // Default NTFS lookup reaches those objects despite the wrong spelling.
        assert!(fixture.vault.join("drafts/note.md").is_file());
        assert!(fixture.vault.join("alpha.md").is_file());
    }
    assert_eq!(
        vault.entry_kind_exact(Path::new("Drafts/Note.md")).unwrap(),
        Some(EntryKind::File)
    );
    assert_eq!(
        vault.entry_kind_exact(Path::new("Drafts")).unwrap(),
        Some(EntryKind::Directory)
    );
    assert_eq!(
        vault.entry_kind_exact(Path::new("drafts/Note.md")).unwrap(),
        None
    );
    assert_eq!(
        vault.entry_kind_exact(Path::new("Drafts/note.md")).unwrap(),
        None
    );
    assert_eq!(vault.entry_kind_exact(Path::new("alpha.md")).unwrap(), None);
    assert_eq!(
        vault.entry_kind_exact(Path::new("Alpha.md")).unwrap(),
        Some(EntryKind::File)
    );
}

#[cfg(unix)]
#[test]
fn exact_entry_does_not_treat_denied_traversal_as_absence() {
    use std::os::unix::fs::PermissionsExt;

    if rustix::process::geteuid().as_raw() == 0 {
        return;
    }
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let denied = fixture.vault.join("Denied");
    fs::create_dir(&denied).unwrap();
    fixture.write("Denied/note.md", b"content");
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
    let result = vault.entry_kind_exact(Path::new("Denied/note.md"));
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn equal_size_identity_and_mtime_still_compare_file_bytes() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();

    let write = |bytes: &[u8]| {
        fixture.write(NOTE, bytes);
        fs::File::options()
            .write(true)
            .open(fixture.vault.join(NOTE))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(10_000)))
            .unwrap();
        vault.read(path(), 10).unwrap().unwrap().stamp
    };
    let first = write(b"one");
    let second = write(b"two");
    assert_eq!(first.identity, second.identity);
    assert_eq!(first.mtime_ns, second.mtime_ns);
    assert_eq!(first.size, second.size);
    assert_ne!(first.digest, second.digest);
}

#[test]
fn no_replace_protects_concurrent_create_and_portable_name_collisions() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let staged = vault.stage(path(), &slot, b"canonical").unwrap();
    let outcome = vault
        .publish_after_check(path(), &slot, None, &staged, PublishMode::Regular, || {
            fixture.write(NOTE, b"user-created");
        })
        .unwrap();
    assert!(matches!(outcome, Publication::Conflict));
    assert_eq!(
        vault.read(path(), 32).unwrap().unwrap().bytes,
        b"user-created"
    );
    assert_eq!(vault.read(&slot, 32).unwrap().unwrap().bytes, b"canonical");

    fs::remove_file(fixture.vault.join(NOTE)).unwrap();
    fixture.write("Note.md", b"neighbor");
    let outcome = vault.publish(path(), &slot, None, &staged, PublishMode::Regular);
    assert!(matches!(outcome, Ok(Publication::Conflict) | Err(_)));
    assert_eq!(
        vault.read(Path::new("Note.md"), 32).unwrap().unwrap().bytes,
        b"neighbor"
    );
}

#[test]
fn replacement_preserves_bytes_saved_after_the_last_check() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    fixture.write(NOTE, b"original");
    let expected = vault.read(path(), 32).unwrap().unwrap().stamp;
    let slot = slot();
    let staged = vault.stage(path(), &slot, b"canonical").unwrap();

    let outcome = vault
        .publish_after_check(
            path(),
            &slot,
            Some(&expected),
            &staged,
            PublishMode::Regular,
            || {
                fixture.edit_by_replacing(NOTE, b"external");
            },
        )
        .unwrap();
    assert!(matches!(outcome, Publication::Conflict));
    #[cfg(unix)]
    {
        assert_eq!(vault.read(path(), 32).unwrap().unwrap().bytes, b"canonical");
        assert_eq!(vault.read(&slot, 32).unwrap().unwrap().bytes, b"external");
        assert_retained(vault, &slot, &expected, b"external");
    }
    #[cfg(windows)]
    {
        assert_eq!(vault.read(path(), 32).unwrap().unwrap().bytes, b"external");
        assert_eq!(vault.read(&slot, 32).unwrap().unwrap().bytes, b"canonical");
        assert!(
            vault
                .read(&VaultDir::displaced_slot(&slot).unwrap(), 32)
                .unwrap()
                .is_none()
        );
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn cleanup_of_verified_capture_preserves_a_later_save() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    fixture.write(NOTE, b"original");
    let expected = vault.read(path(), 32).unwrap().unwrap().stamp;
    let slot = slot();
    let staged = vault.stage(path(), &slot, b"canonical").unwrap();

    let Publication::Applied {
        published,
        displaced: Some(displaced),
    } = vault
        .publish(
            path(),
            &slot,
            Some(&expected),
            &staged,
            PublishMode::Regular,
        )
        .unwrap()
    else {
        panic!("original inode was not captured");
    };
    assert_eq!(published.identity, staged.identity);
    assert_eq!(displaced.stamp.identity, expected.identity);
    fixture.edit_by_replacing(NOTE, b"later");
    assert!(matches!(
        vault
            .clean_capture(&displaced.path, &displaced.stamp)
            .unwrap(),
        CaptureCleanup::Removed
    ));
    assert!(vault.read(&displaced.path, 32).unwrap().is_none());
    assert_eq!(vault.read(path(), 32).unwrap().unwrap().bytes, b"later");
}

#[test]
fn withdrawing_after_a_concurrent_save_preserves_the_third_object() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    fixture.write(NOTE, b"original");
    let expected = vault.read(path(), 32).unwrap().unwrap().stamp;
    let outcome = vault
        .withdraw_after_check(path(), &slot(), &expected, || {
            fixture.edit_by_replacing(NOTE, b"external");
        })
        .unwrap();
    assert!(matches!(outcome, Withdrawal::Conflict));
    assert!(vault.read(path(), 32).unwrap().is_none());
    assert_eq!(vault.read(&slot(), 32).unwrap().unwrap().bytes, b"external");
    assert_retained(vault, &slot(), &expected, b"external");
}

#[cfg(unix)]
#[test]
fn cleanup_retains_an_inode_with_an_open_editor_writer() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    fixture.write(NOTE, b"original");
    let mut editor = fs::File::options()
        .write(true)
        .open(fixture.vault.join(NOTE))
        .unwrap();
    let expected = vault.read(path(), 32).unwrap().unwrap().stamp;
    let slot = slot();
    let staged = vault.stage(path(), &slot, b"canonical").unwrap();

    let Publication::Applied {
        displaced: Some(capture),
        ..
    } = vault
        .publish(
            path(),
            &slot,
            Some(&expected),
            &staged,
            PublishMode::Regular,
        )
        .unwrap()
    else {
        panic!("original inode was not captured");
    };
    let parked = assert_retained(vault, &capture.path, &capture.stamp, b"original");
    editor.write_all(b"external").unwrap();
    drop(editor);
    assert_eq!(
        assert_retained(vault, &capture.path, &capture.stamp, b"external"),
        parked
    );
    assert_eq!(
        vault.recovered_capture(&capture.path).unwrap(),
        Some(parked)
    );
    assert_eq!(vault.read(path(), 32).unwrap().unwrap().bytes, b"canonical");
}

#[test]
fn conversion_has_no_plaintext_copy_and_checks_atomic_support() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    vault.probe_conversion(path(), "0101010101010101").unwrap();
    assert!(vault.list(Path::new("")).unwrap().is_empty());
    fixture.write(NOTE, b"plaintext example");
    let expected = vault.read(path(), 32).unwrap().unwrap().stamp;
    let staged = vault.stage(path(), &slot(), b"ciphertext example").unwrap();

    let Publication::Applied { displaced, .. } = vault
        .publish(
            path(),
            &slot(),
            Some(&expected),
            &staged,
            PublishMode::Conversion,
        )
        .unwrap()
    else {
        panic!("conversion could not publish");
    };
    assert_eq!(
        vault.read(path(), 32).unwrap().unwrap().bytes,
        b"ciphertext example"
    );
    if let Some(displaced) = displaced {
        // A successful Unix exchange keeps the one old inode until the
        // journal acknowledges publication. No backup copies were produced.
        assert_eq!(displaced.stamp.identity, expected.identity);
        #[cfg(target_os = "macos")]
        {
            let parked = assert_retained(
                vault,
                &displaced.path,
                &displaced.stamp,
                b"plaintext example",
            );
            assert_eq!(
                vault.recovered_capture(&displaced.path).unwrap(),
                Some(parked)
            );
        }
        #[cfg(not(target_os = "macos"))]
        assert!(matches!(
            vault
                .clean_capture(&displaced.path, &displaced.stamp)
                .unwrap(),
            CaptureCleanup::Removed
        ));
    }
    assert_eq!(vault.list(Path::new("")).unwrap().len(), 1);
}

#[test]
fn cleanup_parks_a_raced_slot_before_deciding_what_to_remove() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let expected = vault.stage(path(), &slot, b"expected").unwrap();
    let cleanup = vault
        .clean_capture_after_observation(&slot, &expected, || {
            let path = fixture.vault.join(&slot);
            fs::rename(&path, fixture.vault.join("external-original")).unwrap();
            fs::write(path, b"substitute").unwrap();
        })
        .unwrap();
    let CaptureCleanup::Retained { path } = cleanup else {
        panic!("a different inode must remain available");
    };
    assert!(path.starts_with(fixture.data.root()));
    assert_eq!(fs::read(&path).unwrap(), b"substitute");
    assert_eq!(
        fs::read(fixture.vault.join("external-original")).unwrap(),
        b"expected"
    );
    assert!(vault.read(&slot, 32).unwrap().is_none());
    drop(roots);

    let roots = fixture.open();
    let reopened = roots.vault().unwrap();
    assert_eq!(
        reopened.recovered_capture(&slot).unwrap(),
        Some(path.clone())
    );
    assert_eq!(
        assert_retained(reopened, &slot, &expected, b"substitute"),
        path
    );
}

#[test]
fn parked_capture_replays_after_the_original_parent_changes_case() {
    let fixture = Fixture::new();
    let old_dir = fixture.vault.join("Drafts");
    let new_dir = fixture.vault.join("drafts");
    let intermediate = fixture.vault.join("renaming");
    fs::create_dir(&old_dir).unwrap();
    let target = Path::new("Drafts/note.md");
    let slot = VaultDir::operation_slot(target, OPERATION).unwrap();
    let unparked = VaultDir::operation_slot(target, "0303030303030303").unwrap();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let expected = vault.stage(target, &slot, b"before").unwrap();
    let unparked_stamp = vault.stage(target, &unparked, b"still shared").unwrap();
    fs::write(fixture.vault.join(&slot), b"edited").unwrap();
    let parked = assert_retained(vault, &slot, &expected, b"edited");
    assert!(parked.starts_with(fixture.data.root()));

    drop(roots);
    fs::rename(&old_dir, &intermediate).unwrap();
    fs::rename(&intermediate, &new_dir).unwrap();
    let unrelated = new_dir.join(slot.file_name().unwrap());
    let still_shared = new_dir.join(unparked.file_name().unwrap());
    fs::write(&unrelated, b"unrelated").unwrap();

    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    if old_dir.is_dir() {
        // On a case-insensitive volume, ordinary reads still reject aliases.
        assert_eq!(
            vault.open_dir(Path::new("Drafts")).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
    }
    assert!(matches!(
        vault.clean_capture(&unparked, &unparked_stamp).unwrap(),
        CaptureCleanup::Retained { path } if path == fixture.vault.join(&unparked)
    ));
    assert_eq!(
        vault.recovered_capture(&slot).unwrap(),
        Some(parked.clone())
    );
    assert_eq!(assert_retained(vault, &slot, &expected, b"edited"), parked);
    assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated");
    assert_eq!(fs::read(&still_shared).unwrap(), b"still shared");
}

#[test]
fn a_capture_moved_after_precheck_is_absent_without_a_disposal_witness() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let expected = vault.stage(path(), &slot, b"moved by editor").unwrap();
    let relocated = fixture.vault.join("relocated");

    let result = vault
        .clean_capture_after_observation(&slot, &expected, || {
            fs::rename(fixture.vault.join(&slot), &relocated).unwrap();
        })
        .unwrap();

    assert!(matches!(result, CaptureCleanup::Absent));
    assert!(vault.recovered_capture(&slot).unwrap().is_none());
    assert_eq!(fs::read(&relocated).unwrap(), b"moved by editor");
}

#[test]
fn parked_capture_replays_after_the_original_parent_is_replaced() {
    let fixture = Fixture::new();
    let old_dir = fixture.vault.join("Drafts");
    let relocated = fixture.vault.join("relocated");
    let new_dir = relocated.join("Drafts");
    fs::create_dir(&old_dir).unwrap();
    fs::create_dir(&relocated).unwrap();
    let target = Path::new("Drafts/note.md");
    let slot = VaultDir::operation_slot(target, OPERATION).unwrap();
    let unparked = VaultDir::operation_slot(target, "0303030303030303").unwrap();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let expected = vault.stage(target, &slot, b"before").unwrap();
    let unparked_stamp = vault.stage(target, &unparked, b"still shared").unwrap();
    fs::write(fixture.vault.join(&slot), b"edited").unwrap();
    let parked = assert_retained(vault, &slot, &expected, b"edited");
    assert!(parked.starts_with(fixture.data.root()));

    drop(roots);
    fs::rename(&old_dir, &new_dir).unwrap();
    let still_shared = new_dir.join(unparked.file_name().unwrap());
    let check_replay = || {
        let roots = fixture.open();
        let vault = roots.vault().unwrap();
        assert!(vault.entry_kind_exact(&unparked).is_err());
        assert_eq!(
            vault.recovered_capture(&slot).unwrap(),
            Some(parked.clone())
        );
        assert_eq!(assert_retained(vault, &slot, &expected, b"edited"), parked);
        assert!(vault.recovered_capture(&unparked).unwrap().is_none());
        assert!(matches!(
            vault.clean_capture(&unparked, &unparked_stamp).unwrap(),
            CaptureCleanup::Retained { path } if path == fixture.vault.join(&unparked)
        ));
        assert_eq!(fs::read(&still_shared).unwrap(), b"still shared");
    };

    fs::write(&old_dir, b"unrelated file").unwrap();
    check_replay();
    assert_eq!(fs::read(&old_dir).unwrap(), b"unrelated file");

    #[cfg(unix)]
    {
        fs::remove_file(&old_dir).unwrap();
        // The target has the former basename and the exact shared inode. A
        // basename or content check alone would not reject this indirection.
        std::os::unix::fs::symlink(&new_dir, &old_dir).unwrap();
        check_replay();
        assert_eq!(fs::read_link(&old_dir).unwrap(), new_dir);

        if rustix::process::geteuid().as_raw() != 0 {
            use std::os::unix::fs::PermissionsExt;

            fs::remove_file(&old_dir).unwrap();
            fs::create_dir(&old_dir).unwrap();
            fs::set_permissions(&old_dir, fs::Permissions::from_mode(0o000)).unwrap();
            check_replay();
            fs::set_permissions(&old_dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
}

fn assert_retained(vault: &VaultDir, slot: &Path, expected: &FileStamp, bytes: &[u8]) -> PathBuf {
    let CaptureCleanup::Retained { path } = vault.clean_capture(slot, expected).unwrap() else {
        panic!("unverified capture was removed");
    };
    assert!(path.is_absolute());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    path
}

#[cfg(unix)]
#[test]
fn private_storage_rejects_an_existing_v1_symlink() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let fixture = Fixture::new();
    fs::create_dir(fixture.data.root()).unwrap();
    fs::set_permissions(fixture.data.root(), fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&fixture.vault, fixture.data.root().join("v1")).unwrap();
    assert!(ValidatedRoots::open(&fixture.data, Some(&fixture.vault)).is_err());
    assert!(fs::read_dir(&fixture.vault).unwrap().next().is_none());
    assert!(!fixture.data.sidecar_lock().exists());
}

#[cfg(unix)]
#[test]
fn private_storage_rejects_symlinks_in_each_sqlite_entry() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let roots = fixture.open();
    let v1 = roots.data_root().root().join("v1");
    let outside = fixture.vault.join("existing");
    fs::write(&outside, b"original").unwrap();
    for name in super::roots::STORAGE_FILES {
        let path = v1.join(name);
        symlink(&outside, &path).unwrap();
        assert!(roots.verify_current().is_err(), "{name}");
        assert!(
            ValidatedRoots::open(&fixture.data, Some(&fixture.vault)).is_err(),
            "{name}"
        );
        fs::remove_file(path).unwrap();
    }
    assert_eq!(fs::read(&outside).unwrap(), b"original");
}

#[test]
fn private_storage_rejects_hard_links_and_nonfiles() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let v1 = roots.data_root().root().join("v1");
    let outside = fixture.vault.join("external");
    fs::write(&outside, b"original").unwrap();
    let wal = v1.join("control.sqlite-wal");
    fs::hard_link(&outside, &wal).unwrap();
    assert!(roots.verify_current().is_err());
    fs::remove_file(wal).unwrap();
    let owner_lock = v1.join("canonical-owner.lock");
    fs::create_dir(&owner_lock).unwrap();
    assert!(roots.verify_current().is_err());
    fs::remove_dir(owner_lock).unwrap();
    assert!(roots.verify_current().is_ok());
    assert_eq!(fs::read(&outside).unwrap(), b"original");
}

#[cfg(windows)]
#[test]
fn windows_rejects_hard_links_even_when_the_alias_is_inside_the_vault() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let secret = fixture.data.root().join("secret");
    fs::write(&secret, b"private").unwrap();
    fs::hard_link(&secret, fixture.vault.join("hard.md")).unwrap();
    assert!(vault.read(Path::new("hard.md"), 99).is_err());
    assert_eq!(fs::read(secret).unwrap(), b"private");
}

#[cfg(windows)]
#[test]
fn inherited_owner_only_dacls_pass_private_file_validation() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let v1 = roots.data_root().root().join("v1");
    for name in super::roots::STORAGE_FILES {
        fs::write(v1.join(name), b"inherited owner-only DACL").unwrap();
    }
    fs::write(fixture.data.sidecar_lock(), []).unwrap();
    roots.verify_current().unwrap();
    assert!(fixture.open().acquire_sidecar_lock().is_ok());
}

#[cfg(windows)]
#[test]
fn owner_only_directories_reject_same_volume_moved_sqlite_and_lock_files_with_broad_acl() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let v1 = roots.data_root().root().join("v1");
    for name in super::roots::STORAGE_FILES
        .iter()
        .map(|name| v1.join(name))
        .chain(std::iter::once(fixture.data.sidecar_lock()))
    {
        let sibling = fixture.vault.join("broad-acl");
        fs::write(&sibling, b"unchanged").unwrap();
        grant_everyone_read(&sibling);
        fs::rename(&sibling, &name).unwrap();
        assert_eq!(
            ValidatedRoots::open(&fixture.data, Some(&fixture.vault))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            roots.verify_current().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            roots.acquire_sidecar_lock().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(fs::read(&name).unwrap(), b"unchanged");
        fs::remove_file(name).unwrap();
    }
    assert!(roots.acquire_sidecar_lock().is_ok());
}

#[cfg(windows)]
#[test]
fn windows_keeps_a_capture_with_an_open_writer_in_its_original_slot() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let stamp = vault.stage(path(), &slot, b"before").unwrap();
    let full = fixture.vault.join(&slot);
    grant_everyone_read(&full);
    let mut writer = fs::OpenOptions::new().write(true).open(&full).unwrap();

    assert_eq!(assert_retained(vault, &slot, &stamp, b"before"), full);
    writer.write_all(b"edited").unwrap();
    writer.sync_all().unwrap();
    assert_eq!(fs::read(full).unwrap(), b"edited");
    assert!(vault.recovered_capture(&slot).unwrap().is_none());
}

#[cfg(windows)]
#[test]
fn windows_keeps_broad_acl_captures_and_unproved_subtrees_in_the_vault() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let stamp = vault.stage(path(), &slot, b"preserve").unwrap();
    let full = fixture.vault.join(&slot);
    grant_everyone_read(&full);
    fs::write(&full, b"modified").unwrap();
    assert_eq!(assert_retained(vault, &slot, &stamp, b"modified"), full);
    assert!(vault.recovered_capture(&slot).unwrap().is_none());

    let tree_slot = VaultDir::operation_slot(Path::new("package"), "0303030303030303").unwrap();
    let tree = fixture.vault.join(&tree_slot);
    fs::create_dir(&tree).unwrap();
    fs::write(tree.join("member.md"), b"preserve subtree").unwrap();
    grant_everyone_read(&tree.join("member.md"));
    assert_eq!(vault.retain_tree(&tree_slot).unwrap(), tree);
    assert!(vault.recovered_capture(&tree_slot).unwrap().is_none());
    assert_eq!(
        fs::read(tree.join("member.md")).unwrap(),
        b"preserve subtree"
    );
}

#[cfg(windows)]
#[test]
fn windows_busy_historical_parent_keeps_the_capture_unconfirmed() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ};

    let fixture = Fixture::new();
    let folder = fixture.vault.join("history");
    fs::create_dir(&folder).unwrap();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let target = Path::new("history/note.md");
    let slot = VaultDir::operation_slot(target, OPERATION).unwrap();
    let expected = vault.stage(target, &slot, b"retained").unwrap();
    let old = fixture.vault.join(&slot);
    let moved = fixture.vault.join("moved");
    fs::rename(&old, &moved).unwrap();
    let reader = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&folder)
        .unwrap();

    assert!(matches!(
        vault.clean_capture(&slot, &expected).unwrap(),
        CaptureCleanup::Retained { path } if path == old
    ));
    assert_eq!(fs::read(&moved).unwrap(), b"retained");
    drop(reader);
    assert!(matches!(
        vault.clean_capture(&slot, &expected).unwrap(),
        CaptureCleanup::Absent
    ));
}

#[cfg(windows)]
#[test]
fn windows_disposes_of_a_verified_matching_shared_capture_without_changing_its_acl() {
    let fixture = Fixture::new();
    let roots = fixture.open();
    let vault = roots.vault().unwrap();
    let slot = slot();
    let stamp = vault.stage(path(), &slot, b"displaced").unwrap();
    let full = fixture.vault.join(&slot);
    grant_everyone_read(&full);
    let mut reader = fs::File::open(&full).unwrap();

    assert!(matches!(
        vault.clean_capture(&slot, &stamp).unwrap(),
        CaptureCleanup::Removed
    ));
    assert!(
        fs::read_dir(&fixture.vault)
            .unwrap()
            .all(|entry| entry.unwrap().file_name() != slot.as_os_str())
    );
    let mut original = String::new();
    reader.read_to_string(&mut original).unwrap();
    assert_eq!(original, "displaced");
    assert!(vault.recovered_capture(&slot).unwrap().is_none());
}

#[cfg(windows)]
fn grant_everyone_read(path: &Path) {
    let root = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows has SystemRoot"));
    let status = std::process::Command::new(root.join("System32/icacls.exe"))
        .arg(path)
        .args(["/grant", "*S-1-1-0:(R)"])
        .status()
        .expect("Windows includes icacls");
    assert!(status.success());
}

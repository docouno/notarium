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
        fs::create_dir(&vault).unwrap();
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
    assert!(vault.read(Path::new("hard.md"), 99).is_err());
    assert!(vault.read(Path::new("child/secret"), 99).is_err());
    assert!(vault.create_dir_all(Path::new("child/new")).is_err());
    assert!(vault.create_dir_all(Path::new("../outside")).is_err());
    assert!(vault.create_dir_all(Path::new("valid/./child")).is_err());
    assert!(vault.read(Path::new("note.md/."), 32).is_err());
    assert!(!fixture.data.root().join("new").exists());
    assert_eq!(fs::read(secret).unwrap(), b"private");
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

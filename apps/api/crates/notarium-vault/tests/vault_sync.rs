use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    ids::{
        CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, InstallationId,
        LeaseEpoch, NoteId, PrincipalId, RequestId, SpaceId, SpaceSeq,
    },
    model::HistoryScope,
    ports::{
        CallBudget, CreateNote, DeleteDisposition, DeleteNote, MintAndPurge, Mutation,
        NoteWritePort, Preconditions, RenameFolder, SpaceContext,
    },
    receipt::CommandIdentity,
};
use notarium_vault::{
    carrier,
    filesystem::ValidatedRoots,
    sync::{SyncPhase, VaultConfig, VaultStatus, VaultSupervisor},
};
use tempfile::TempDir;
use tokio::sync::watch;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    roots: Arc<ValidatedRoots>,
    scope: HistoryScope,
    store: CanonicalStore,
    runtime: CanonicalRuntime,
}

impl Fixture {
    async fn open() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("markdown");
        fs::create_dir(&root).unwrap();
        let data = DataRoot::new(temp.path().join("private"));
        let roots = Arc::new(ValidatedRoots::open(&data, Some(&root)).unwrap());
        let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
            InstallationId::from_bytes([10; 16]),
            data,
        ))
        .await
        .unwrap();
        let record = store
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([11; 16]),
                incarnation: HistoryIncarnation::from_bytes([12; 16]),
                root_folder_id: FolderId::from_bytes([13; 16]),
                kind: SpaceKind::Personal,
                slug: "fixture".into(),
                owner: principal(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        Self {
            _temp: temp,
            root,
            roots,
            scope: record.scope,
            store,
            runtime,
        }
    }

    fn start(&self) -> VaultSupervisor {
        self.start_with_collaboration(None)
    }

    fn start_with_collaboration(
        &self,
        live_collaboration: Option<Arc<dyn notarium_core::ports::LiveCollabInterceptor>>,
    ) -> VaultSupervisor {
        VaultSupervisor::start(
            self.roots.clone(),
            self.store.clone(),
            VaultConfig {
                context: context(&self.scope),
                owned_abilities: Vec::new(),
                live_collaboration,
                replace_binding: false,
            },
        )
        .unwrap()
    }

    async fn create(&self, slug: &str, value: u8) -> NoteId {
        let note = NoteId::from_bytes([value; 16]);
        self.store
            .create_note(
                context(&self.scope),
                Mutation {
                    identity: identity(&self.scope, value),
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note.clone(),
                        parent: None,
                        slug: slug.into(),
                        class: DocClass::UserDoc,
                        carrier: "# Start\n\nInitial words.\n".into(),
                    },
                },
            )
            .await
            .unwrap();
        note
    }
}

fn principal() -> PrincipalId {
    PrincipalId::from_bytes([14; 16])
}

fn context(scope: &HistoryScope) -> SpaceContext {
    SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            principal(),
            GrantId::from_bytes([15; 16]),
            BTreeMap::from([(
                scope.space_id.clone(),
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: DocClass::all(),
                    write_classes: DocClass::all(),
                    project_root: None,
                },
            )]),
            false,
        )),
        scope.clone(),
        CallBudget {
            request: RequestId::from_bytes([16; 16]),
            cancellation: Default::default(),
            remaining: Duration::from_secs(15),
        },
    )
    .unwrap()
}

fn identity(scope: &HistoryScope, tag: u8) -> CommandIdentity {
    CommandIdentity {
        scope: scope.clone(),
        actor: principal(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    }
}

fn disk_id(path: &Path) -> Option<NoteId> {
    carrier::inspect(&fs::read_to_string(path).ok()?)
        .ok()?
        .asserted_id
}

async fn ready(
    receiver: &mut watch::Receiver<VaultStatus>,
    predicate: impl Fn(&VaultStatus) -> bool,
) -> VaultStatus {
    let status = tokio::time::timeout(
        Duration::from_secs(90),
        receiver.wait_for(|status| {
            matches!(status.phase, SyncPhase::Failed | SyncPhase::Stopped)
                || (status.phase == SyncPhase::Watching && predicate(status))
        }),
    )
    .await
    .expect("vault did not settle")
    .unwrap()
    .clone();
    assert_eq!(status.phase, SyncPhase::Watching, "{status:?}");
    status
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copy_and_move_use_disk_identity_and_offline_purge_never_remints() {
    let fixture = Fixture::open().await;
    let original = fixture.create("alpha", 17).await;
    let supervisor = fixture.start();
    let mut status = supervisor.status();
    let alpha = fixture.root.join("alpha.md");
    ready(&mut status, |_| disk_id(&alpha) == Some(original.clone())).await;

    let copy = fixture.root.join("copy.md");
    fs::copy(&alpha, &copy).unwrap();
    ready(&mut status, |_| {
        disk_id(&copy).is_some_and(|id| id != original)
    })
    .await;
    let copy_id = disk_id(&copy).unwrap();

    let moved = fixture.root.join("renamed.md");
    fs::rename(&alpha, &moved).unwrap();
    ready(&mut status, |state| {
        state.cursor.get() >= 3 && disk_id(&moved) == Some(original.clone())
    })
    .await;
    assert_eq!(disk_id(&copy), Some(copy_id));
    let validated = fixture
        .store
        .read_vault_note(&context(&fixture.scope), &original)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(validated.slug, "renamed");

    #[cfg(target_os = "linux")]
    let moved = {
        let case = fixture.root.join("Renamed.md");
        let before = status.borrow().cursor;
        fs::rename(&moved, &case).unwrap();
        ready(&mut status, |state| state.cursor > before).await;
        let current = fixture
            .store
            .read_vault_note(&context(&fixture.scope), &original)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.slug, "Renamed");
        assert_eq!(disk_id(&case), Some(original.clone()));
        case
    };

    let bytes = fs::read_to_string(&moved).unwrap();
    let mtime = fs::metadata(&moved).unwrap().modified().unwrap();
    let expected = fixture
        .store
        .vault_head(&context(&fixture.scope))
        .await
        .unwrap()
        .get()
        + 1;
    fs::write(&moved, bytes.replace("Initial words.", "Changed words.")).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&moved)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    ready(&mut status, |state| state.cursor.get() >= expected).await;
    let after = fixture
        .store
        .read_vault_note(&context(&fixture.scope), &original)
        .await
        .unwrap()
        .unwrap();
    assert!(after.carrier.contains("Changed words."));
    supervisor.shutdown().await.unwrap();

    let offline = fixture.root.join("offline-move.md");
    fs::rename(&moved, &offline).unwrap();
    fixture
        .store
        .delete_note(
            context(&fixture.scope),
            Mutation {
                identity: identity(&fixture.scope, 18),
                preconditions: Preconditions {
                    revision: Some(after.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: original.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();

    let supervisor = fixture.start();
    let mut status = supervisor.status();
    ready(&mut status, |_| !offline.exists()).await;
    fs::write(&offline, bytes).unwrap();
    let settled = ready(&mut status, |state| {
        state
            .conflicts
            .iter()
            .any(|issue| issue.path == "offline-move.md")
    })
    .await;
    assert!(offline.exists(), "{settled:?}");
    let ctx = context(&fixture.scope);
    assert!(
        fixture
            .store
            .read_vault_note(&ctx, &original)
            .await
            .unwrap()
            .is_none()
    );
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    assert!(
        fixture
            .store
            .vault_observation_at(&ctx, &binding, "offline-move.md")
            .await
            .unwrap()
            .is_none()
    );
    supervisor.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diverged_ciphertext_keeps_both_complete_carriers() {
    use notarium_core::ports::{ExternalObservation, ExternalObservationResult, ObservedContent};
    const FIRST_ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    const OTHER_ARMOR: &str = include_str!("fixtures/offline-conflict.asc");
    fn encrypted(title: &str, armor: &str) -> String {
        format!(
            "---\nclass: encrypted-note\n---\n# {title}\n\n\x60\x60\x60age\n{armor}\x60\x60\x60\n"
        )
    }

    let fixture = Fixture::open().await;
    let note = NoteId::from_bytes([72; 16]);
    let initial = fixture
        .store
        .create_note(
            context(&fixture.scope),
            Mutation {
                identity: identity(&fixture.scope, 72),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "cipher".into(),
                    class: DocClass::EncryptedNote,
                    carrier: encrypted("Base", FIRST_ARMOR),
                },
            },
        )
        .await
        .unwrap();
    let supervisor = fixture.start();
    let mut status = supervisor.status();
    let main = fixture.root.join("cipher.md");
    ready(&mut status, |_| disk_id(&main) == Some(note.clone())).await;
    supervisor.shutdown().await.unwrap();

    let from_disk = carrier::materialize(
        &encrypted("Disk edition", OTHER_ARMOR),
        DocClass::EncryptedNote,
        &note,
    )
    .unwrap();
    fs::write(&main, &from_disk).unwrap();
    let from_canonical = encrypted("Canonical edition", FIRST_ARMOR);
    let result = fixture
        .store
        .accept_external_observation(
            context(&fixture.scope),
            Mutation {
                identity: identity(&fixture.scope, 73),
                preconditions: Preconditions {
                    revision: Some(initial.value.revision.clone()),
                    ..Default::default()
                },
                input: ExternalObservation {
                    note: note.clone(),
                    observed_digest: ContentDigest::from_bytes(
                        *blake3::hash(from_canonical.as_bytes()).as_bytes(),
                    ),
                    base_revision: initial.value.revision,
                    disk_identity: ContentDigest::from_bytes([73; 32]),
                    content: ObservedContent::Carrier(from_canonical.clone()),
                },
            },
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(committed) = result else {
        panic!("expected a separate canonical revision: {result:?}");
    };
    let conflict = fixture.root.join(
        carrier::conflict_filename("cipher", &committed.value.revision)
            .unwrap()
            .as_str(),
    );

    let supervisor = fixture.start();
    let mut status = supervisor.status();
    ready(&mut status, |state| {
        state
            .conflicts
            .iter()
            .any(|issue| issue.reason == notarium_vault::ConflictReason::CiphertextConflict)
    })
    .await;
    assert_eq!(fs::read_to_string(&conflict).unwrap(), from_disk);
    assert_eq!(
        fs::read_to_string(&main).unwrap(),
        carrier::materialize(&from_canonical, DocClass::EncryptedNote, &note).unwrap()
    );
    let invalid = fixture.root.join("invalid.md");
    let before = fixture
        .store
        .vault_head(&context(&fixture.scope))
        .await
        .unwrap();
    fs::write(&invalid, encrypted("Invalid", "not valid age\n")).unwrap();
    ready(&mut status, |state| {
        state.conflicts.iter().any(|issue| {
            issue.path == "invalid.md"
                && issue.reason == notarium_vault::ConflictReason::InvalidCarrier
        })
    })
    .await;
    assert_eq!(
        fixture
            .store
            .vault_head(&context(&fixture.scope))
            .await
            .unwrap(),
        before
    );
    let directories = status.borrow().work.enumerated_directories;
    supervisor.reconcile().await.unwrap();
    ready(&mut status, |state| {
        state.work.enumerated_directories > directories
    })
    .await;
    assert_eq!(fs::read_to_string(&conflict).unwrap(), from_disk);
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 3);
    supervisor.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_room_keeps_the_filename_until_its_pin_is_released() {
    use std::sync::atomic::{AtomicBool, Ordering};

    use notarium_core::ports::{
        FilenamePin, InterceptedMutation, InterceptionResult, LiveCollabInterceptor, PortFuture,
        RenameNote, RollbackReservation,
    };

    struct Room(AtomicBool);
    impl LiveCollabInterceptor for Room {
        fn filename_pin(&self, _ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin> {
            Box::pin(async move {
                Ok(if self.0.load(Ordering::Acquire) {
                    FilenamePin::Pinned {
                        note,
                        filename: "pinned.md".into(),
                        lease: LeaseEpoch::new(1).unwrap(),
                    }
                } else {
                    FilenamePin::Unpinned
                })
            })
        }

        fn intercept(&self, _request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
            panic!("the fixture only supplies a filename pin to the vault")
        }

        fn reserve_rollback(
            &self,
            _ctx: SpaceContext,
            _note: NoteId,
            _identity: CommandIdentity,
        ) -> PortFuture<'_, RollbackReservation> {
            panic!("the fixture does not issue rollback")
        }
    }

    let fixture = Fixture::open().await;
    let note = fixture.create("pinned", 51).await;
    let room = Arc::new(Room(AtomicBool::new(true)));
    let worker = fixture.start_with_collaboration(Some(room.clone()));
    let mut status = worker.status();
    let old = fixture.root.join("pinned.md");
    let new = fixture.root.join("after-pin.md");
    ready(&mut status, |_| disk_id(&old) == Some(note.clone())).await;

    let committed = fixture
        .store
        .rename_note(
            context(&fixture.scope),
            Mutation {
                identity: identity(&fixture.scope, 52),
                preconditions: Preconditions::default(),
                input: RenameNote {
                    note: note.clone(),
                    slug: "after-pin".into(),
                    title: None,
                },
            },
        )
        .await
        .unwrap();
    ready(&mut status, |state| state.cursor >= committed.receipt.seq()).await;
    assert_eq!(disk_id(&old), Some(note.clone()));
    assert!(!new.exists());

    room.0.store(false, Ordering::Release);
    ready(&mut status, |_| {
        disk_id(&new) == Some(note.clone()) && !old.exists()
    })
    .await;
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_name_can_be_reused_after_the_old_folder_moves() {
    let fixture = Fixture::open().await;
    let original_folder = fixture.root.join("inbox");
    fs::create_dir(&original_folder).unwrap();
    let first = original_folder.join("first.md");
    fs::write(&first, "# First\n").unwrap();

    let worker = fixture.start();
    let mut state = worker.status();
    ready(&mut state, |_| disk_id(&first).is_some()).await;
    let first_note = disk_id(&first).unwrap();
    let ctx = context(&fixture.scope);
    let old_folder = fixture
        .store
        .read_vault_note(&ctx, &first_note)
        .await
        .unwrap()
        .unwrap()
        .parent;
    fixture
        .store
        .rename_folder(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 61),
                preconditions: Preconditions::default(),
                input: RenameFolder {
                    folder: old_folder.clone(),
                    name: "filed".into(),
                },
            },
        )
        .await
        .unwrap();
    let filed = fixture.root.join("filed").join("first.md");
    ready(&mut state, |_| {
        disk_id(&filed) == Some(first_note.clone()) && !first.exists()
    })
    .await;

    let second = original_folder.join("second.md");
    fs::write(&second, "# Second\n").unwrap();
    ready(&mut state, |_| disk_id(&second).is_some()).await;
    let second_note = fixture
        .store
        .read_vault_note(&ctx, &disk_id(&second).unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(second_note.parent, old_folder);
    assert_eq!(second_note.folders, ["inbox"]);
    assert_eq!(disk_id(&filed), Some(first_note));
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_conversion_replays_its_receipt_and_keeps_the_checked_path() {
    const ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    let fixture = Fixture::open().await;
    let old = fixture.create("checked-name", 41).await;
    let supervisor = fixture.start();
    let mut state = supervisor.status();
    let target = fixture.root.join("checked-name.md");
    ready(&mut state, |_| disk_id(&target) == Some(old.clone())).await;
    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    let new = NoteId::from_bytes([42; 16]);
    let request = Mutation {
        identity: identity(&fixture.scope, 42),
        preconditions: Preconditions {
            revision: Some(before.note.revision.clone()),
            ..Default::default()
        },
        input: MintAndPurge {
            old_note: old.clone(),
            expected_revision: before.note.revision,
            new_note: new.clone(),
            new_slug: Some("new-slug".into()),
            encrypted_carrier: format!(
                "---\nclass: encrypted-note\n---\n\x60\x60\x60age\n{ARMOR}\x60\x60\x60\n"
            ),
        },
    };
    let editor = fs::OpenOptions::new().write(true).open(&target).unwrap();
    let result = supervisor.mint_and_purge(request.clone()).await.unwrap();
    assert!(
        !result.published,
        "retained plaintext must keep completion pending"
    );
    assert_eq!(disk_id(&target), Some(new.clone()));
    let retained = ready(&mut state, |state| {
        state
            .conflicts
            .iter()
            .any(|issue| issue.path == "checked-name.md" && issue.preserved_path.is_some())
    })
    .await;
    let capture = retained
        .conflicts
        .iter()
        .find(|issue| issue.path == "checked-name.md")
        .and_then(|issue| issue.preserved_path.as_ref())
        .unwrap();
    assert!(
        fs::read_to_string(capture)
            .unwrap()
            .contains("Initial words.")
    );
    drop(editor);
    let repeated = supervisor.mint_and_purge(request).await.unwrap();
    assert!(repeated.published);
    assert!(!capture.exists());
    assert_eq!(
        result.committed.receipt.seq(),
        repeated.committed.receipt.seq()
    );
    assert_eq!(disk_id(&target), Some(new));
    assert!(!fixture.root.join("new-slug.md").exists());
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
    supervisor.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_sized_batch_does_not_scan_unrelated_subtrees() {
    const NOTES: u64 = 300;
    let fixture = Fixture::open().await;
    let folder = fixture.root.join("before");
    let unrelated = fixture.root.join("unrelated");
    fs::create_dir(&folder).unwrap();
    fs::create_dir(&unrelated).unwrap();
    for index in 0..80 {
        let branch = unrelated.join(format!("folder-{index}"));
        fs::create_dir(&branch).unwrap();
        fs::write(branch.join("asset.txt"), "unrelated payload").unwrap();
    }
    for index in 0..NOTES {
        fs::write(folder.join(format!("doc-{index}.md")), "# Before\n").unwrap();
    }

    let supervisor = fixture.start();
    let mut status = supervisor.status();
    let last = folder.join(format!("doc-{}.md", NOTES - 1));
    ready(&mut status, |state| {
        state.cursor.get() >= NOTES && disk_id(&last).is_some()
    })
    .await;
    let last_id = disk_id(&last).unwrap();
    // Let the creation echo clear before measuring checkout work.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = status.borrow().clone();
    let after_folder = fixture.root.join("after");
    if std::env::var_os("NOTARIUM_TEST_GIT_CHECKOUT").is_some() {
        real_checkout(&fixture, &folder, NOTES);
    } else {
        let git = fixture.root.join(".git");
        fs::create_dir(&git).unwrap();
        let lock = git.join("index.lock");
        fs::write(&lock, "").unwrap();
        fs::rename(&folder, &after_folder).unwrap();
        for index in 0..NOTES {
            let path = after_folder.join(format!("doc-{index}.md"));
            let old = fs::read_to_string(&path).unwrap();
            fs::write(path, old.replace("# Before", "# After")).unwrap();
        }
        fs::remove_file(lock).unwrap();
    }

    let after = ready(&mut status, |state| {
        state.cursor.get() >= before.cursor.get() + 2 * NOTES
    })
    .await;
    assert!(after.conflicts.is_empty(), "{after:?}");
    assert!(
        after.work.enumerated_directories - before.work.enumerated_directories <= 3,
        "{after:?}"
    );
    assert_eq!(
        disk_id(&after_folder.join(format!("doc-{}.md", NOTES - 1))),
        Some(last_id.clone())
    );
    let last_note = fixture
        .store
        .read_vault_note(&context(&fixture.scope), &last_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(last_note.folders, vec!["after"]);
    assert!(last_note.carrier.contains("# After"));
    eprintln!(
        "checkout work delta: files={NOTES}, checked={}, hashed={}, parsed={}, directories={}",
        after.work.path_checks - before.work.path_checks,
        after.work.hashed_files - before.work.hashed_files,
        after.work.parsed_carriers - before.work.parsed_carriers,
        after.work.enumerated_directories - before.work.enumerated_directories
    );
    supervisor.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
fn real_checkout(fixture: &Fixture, folder: &Path, notes: u64) {
    use std::process::Command;

    let git = |alternate: Option<&Path>, args: &[&str]| {
        let mut command = Command::new("git");
        command.arg("-C").arg(&fixture.root);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Vault Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Vault Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_DIR");
        if let Some(stage) = alternate {
            command.env("GIT_WORK_TREE", stage).env(
                "GIT_INDEX_FILE",
                fixture._temp.path().join("alternate.index"),
            );
        }
        let output = command.args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(None, &["init", "--initial-branch=original"]);
    git(None, &["add", "--", "before"]);
    git(None, &["commit", "-m", "Original Markdown paths"]);
    let alternate = fixture._temp.path().join("branch-files");
    fs::create_dir_all(alternate.join("after")).unwrap();
    for index in 0..notes {
        let name = format!("doc-{index}.md");
        let carrier = fs::read_to_string(folder.join(&name)).unwrap();
        fs::write(
            alternate.join("after").join(name),
            carrier.replace("# Before", "# After"),
        )
        .unwrap();
    }
    git(Some(&alternate), &["add", "--", "after"]);
    let tree = git(Some(&alternate), &["write-tree"]);
    let commit = git(
        None,
        &[
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            "Move and edit Markdown",
        ],
    );
    git(None, &["update-ref", "refs/heads/changed", &commit]);
    git(None, &["checkout", "changed"]);
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_conversion_replaces_plaintext_at_the_old_name_after_restart() {
    const ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    let fixture = Fixture::open().await;
    let old = fixture.create("private-note", 31).await;
    let supervisor = fixture.start();
    let mut state = supervisor.status();
    let target = fixture.root.join("private-note.md");
    ready(&mut state, |_| disk_id(&target) == Some(old.clone())).await;
    supervisor.shutdown().await.unwrap();

    let new = NoteId::from_bytes([32; 16]);
    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture.store.mint_and_purge(ctx, Mutation {
        identity: identity(&fixture.scope, 32),
        preconditions: Preconditions { revision: Some(before.note.revision.clone()), ..Default::default() },
        input: MintAndPurge {
            old_note: old.clone(), expected_revision: before.note.revision, new_note: new.clone(),
            new_slug: Some("encrypted-successor".into()),
            encrypted_carrier: format!("---\nclass: encrypted-note\n---\n# Private\n\n\x60\x60\x60age\n{ARMOR}\x60\x60\x60\n"),
        },
    }).await.unwrap();

    let supervisor = fixture.start();
    let mut state = supervisor.status();
    ready(&mut state, |_| disk_id(&target) == Some(new.clone())).await;
    let disk = fs::read_to_string(&target).unwrap();
    notarium_syntax::encrypted::validate(&disk).unwrap();
    assert!(!disk.contains("Initial words."));
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
    assert!(
        fixture
            .store
            .read_vault_note(&context(&fixture.scope), &old)
            .await
            .unwrap()
            .is_none()
    );
    supervisor.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

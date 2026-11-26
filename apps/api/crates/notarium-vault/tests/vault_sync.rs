use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, SqlBackendConfig,
};
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
    sync::{ConversionPublication, SyncPhase, VaultConfig, VaultStatus, VaultSupervisor},
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
        let mut config = CanonicalConfig::local_default(InstallationId::from_bytes([10; 16]), data);
        if let SqlBackendConfig::Sqlite { read_deadline, .. } = &mut config.sql {
            // These tests measure filesystem work and convergence. Keep a
            // slow shared runner's SQLite checkpoint out of that signal.
            *read_deadline = Duration::from_secs(2);
        }
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
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
async fn cold_case_only_folder_rename_keeps_the_folder_and_note_ids() {
    let fixture = Fixture::open().await;
    let old_folder = fixture.root.join("Folder");
    fs::create_dir(&old_folder).unwrap();
    let note_file = old_folder.join("note.md");
    fs::write(&note_file, "# Same folder\n").unwrap();
    let worker = fixture.start();
    let mut status = worker.status();
    ready(&mut status, |_| disk_id(&note_file).is_some()).await;
    let id = disk_id(&note_file).unwrap();
    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &id)
        .await
        .unwrap()
        .unwrap();
    let cutoff = fixture.store.vault_head(&ctx).await.unwrap();
    worker.shutdown().await.unwrap();

    let hop = fixture.root.join("spelling-change");
    let new_folder = fixture.root.join("folder");
    fs::rename(old_folder, &hop).unwrap();
    fs::rename(hop, &new_folder).unwrap();
    let worker = fixture.start();
    let mut status = worker.status();
    ready(&mut status, |state| state.cursor > cutoff).await;
    let after = fixture
        .store
        .read_vault_note(&ctx, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.parent, before.parent);
    assert_eq!(after.folders, ["folder"]);
    assert_eq!(disk_id(&new_folder.join("note.md")), Some(id));
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_reserved_path_does_not_stop_note_import() {
    let fixture = Fixture::open().await;
    let reserved_path = fixture.root.join(".notarium");
    fs::write(&reserved_path, b"user-owned entry").unwrap();
    let note = fixture.root.join("independent.md");
    fs::write(&note, "# Independent note\n").unwrap();

    let worker = fixture.start();
    let mut status = worker.status();
    let settled = ready(&mut status, |_| disk_id(&note).is_some()).await;
    assert!(
        settled
            .conflicts
            .iter()
            .any(|issue| { issue.path == ".notarium/fields/schema.yaml" }),
        "{settled:?}"
    );
    assert_eq!(fs::read(&reserved_path).unwrap(), b"user-owned entry");

    fs::remove_file(reserved_path).unwrap();
    ready(&mut status, |status| status.conflicts.is_empty()).await;
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canonical_edit_is_published_when_the_existing_file_becomes_readable() {
    use notarium_core::ports::{ExternalObservation, ExternalObservationResult, ObservedContent};
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::open().await;
    let note = fixture.create("temporarily-blocked", 108).await;
    let file = fixture.root.join("temporarily-blocked.md");
    let worker = fixture.start();
    let mut status = worker.status();
    ready(&mut status, |_| disk_id(&file) == Some(note.clone())).await;
    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &note)
        .await
        .unwrap()
        .unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&file).is_ok() {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        worker.shutdown().await.unwrap();
        fixture.runtime.shutdown().await.unwrap();
        return;
    }
    let body = "# Updated canonical note\n";
    let update = fixture
        .store
        .accept_external_observation(
            ctx,
            Mutation {
                identity: identity(&fixture.scope, 109),
                preconditions: Preconditions::default(),
                input: ExternalObservation {
                    note: note.clone(),
                    observed_digest: ContentDigest::from_bytes(
                        *blake3::hash(body.as_bytes()).as_bytes(),
                    ),
                    base_revision: before.note.revision,
                    disk_identity: ContentDigest::from_bytes([109; 32]),
                    content: ObservedContent::Carrier(body.into()),
                },
            },
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(updated) = update else {
        panic!("expected a canonical edit");
    };
    ready(&mut status, |value| {
        value.cursor >= updated.receipt.seq()
            && value
                .conflicts
                .iter()
                .any(|issue| issue.path == "temporarily-blocked.md")
    })
    .await;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    ready(&mut status, |value| {
        value.conflicts.is_empty()
            && fs::read_to_string(&file).is_ok_and(|text| text.contains(body))
    })
    .await;
    assert_eq!(disk_id(&file), Some(note));
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_keeps_an_unlocated_shared_capture_and_continues_importing() {
    use notarium_vault::filesystem::VaultDir;

    let fixture = Fixture::open().await;
    let worker = fixture.start();
    ready(&mut worker.status(), |_| true).await;
    worker.shutdown().await.unwrap();
    let ctx = context(&fixture.scope);
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let vault = fixture.roots.vault().unwrap();

    let old_parent = fixture.root.join("Drafts");
    let new_parent = fixture.root.join("drafts");
    fs::create_dir(&old_parent).unwrap();
    let target = Path::new("Drafts/note.md");
    let operation = ContentDigest::from_bytes([84; 32]);
    let slot = VaultDir::operation_slot(target, &operation.to_hex()).unwrap();
    let stamp = vault.stage(target, &slot, b"captured bytes").unwrap();
    let record = fixture
        .roots
        .data_root()
        .root()
        .join(format!("vault-notes-{}", binding.generation.to_hex()))
        .join(format!("{}.capture", operation.to_hex()));
    let file = fs::File::create(&record).unwrap();
    serde_json::to_writer(
        &file,
        &serde_json::json!({
            "operation": operation,
            "target": target,
            "slot": slot,
            "expected": stamp,
            "retained_at": fixture.root.join(&slot),
            "successor": null,
        }),
    )
    .unwrap();
    file.sync_all().unwrap();
    drop(file);
    let intermediate = fixture.root.join("renaming");
    fs::rename(old_parent, &intermediate).unwrap();
    fs::rename(&intermediate, &new_parent).unwrap();
    let note = fixture.root.join("independent.md");
    fs::write(&note, "# Independent note\n").unwrap();

    let worker = fixture.start();
    let status = ready(&mut worker.status(), |_| disk_id(&note).is_some()).await;
    assert!(
        status
            .conflicts
            .iter()
            .any(|issue| { issue.path == "Drafts/note.md" && issue.preserved_path.is_none() }),
        "{status:?}"
    );
    assert!(record.exists());
    assert_eq!(
        fs::read(new_parent.join(slot.file_name().unwrap())).unwrap(),
        b"captured bytes"
    );
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_replaces_a_proven_unapplied_stage_with_the_current_revision() {
    use notarium_core::ports::{ExternalObservation, ExternalObservationResult, ObservedContent};
    use notarium_vault::filesystem::VaultDir;

    let fixture = Fixture::open().await;
    let id = fixture.create("staged", 81).await;
    let worker = fixture.start();
    let mut status = worker.status();
    let name = Path::new("staged.md");
    let path = fixture.root.join(name);
    ready(&mut status, |_| disk_id(&path) == Some(id.clone())).await;
    worker.shutdown().await.unwrap();

    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &id)
        .await
        .unwrap()
        .unwrap();
    let hash = |body: &str| ContentDigest::from_bytes(*blake3::hash(body.as_bytes()).as_bytes());
    let apply = |base, body: &'static str, tag| {
        let ctx = ctx.clone();
        let id = id.clone();
        let store = fixture.store.clone();
        let command = identity(&fixture.scope, tag);
        async move {
            let result = store
                .accept_external_observation(
                    ctx,
                    Mutation {
                        identity: command,
                        preconditions: Preconditions::default(),
                        input: ExternalObservation {
                            note: id,
                            observed_digest: hash(body),
                            base_revision: base,
                            disk_identity: ContentDigest::from_bytes([tag; 32]),
                            content: ObservedContent::Carrier(body.into()),
                        },
                    },
                )
                .await
                .unwrap();
            let ExternalObservationResult::Committed(receipt) = result else {
                panic!("expected a new revision: {result:?}");
            };
            receipt.value.revision
        }
    };
    let staged_body = "# Superseded preparation\n";
    let revision = apply(before.note.revision, staged_body, 82).await;
    let projected = carrier::materialize(staged_body, DocClass::UserDoc, &id).unwrap();
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let vault = fixture.roots.vault().unwrap();
    let expected = vault.read(name, 8192).unwrap().unwrap().stamp;
    let operation = ContentDigest::from_bytes([84; 32]);
    let slot = VaultDir::operation_slot(name, &operation.to_hex()).unwrap();
    let staged = vault.stage(name, &slot, projected.as_bytes()).unwrap();
    // Durable cut after staging and before the namespace operation.
    let intent = serde_json::json!({
        "scope": binding.scope,
        "generation": binding.generation,
        "id": operation,
        "target": name,
        "action": { "Publish": {
            "desired": { "note": id, "revision": revision,
                "carrier_digest": hash(staged_body), "disk_digest": hash(&projected) },
            "purpose": "Note", "expected": expected, "staged": staged, "retire": null,
            "abandoned": false,
        }}
    });
    let record = fixture
        .roots
        .data_root()
        .root()
        .join(format!("vault-notes-{}", binding.generation.to_hex()))
        .join(format!("{}.intent", operation.to_hex()));
    let file = fs::File::create(&record).unwrap();
    serde_json::to_writer(&file, &intent).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let latest = "# Current authorized revision\n";
    apply(revision, latest, 83).await;

    let worker = fixture.start();
    let mut status = worker.status();
    let target = carrier::materialize(latest, DocClass::UserDoc, &id).unwrap();
    ready(&mut status, |_| {
        fs::read_to_string(&path).is_ok_and(|bytes| bytes == target)
    })
    .await;
    assert!(!record.exists());
    assert!(!fixture.root.join(slot).exists());
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_acknowledges_an_applied_conversion_before_publishing_the_new_head() {
    use notarium_core::ports::{ExternalObservation, ExternalObservationResult, ObservedContent};
    use notarium_vault::filesystem::{Publication, PublishMode, VaultDir};

    const ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    let fixture = Fixture::open().await;
    let old = fixture.create("old-name", 91).await;
    let worker = fixture.start();
    let mut status = worker.status();
    let name = Path::new("old-name.md");
    let path = fixture.root.join(name);
    ready(&mut status, |_| disk_id(&path) == Some(old.clone())).await;
    worker.shutdown().await.unwrap();

    let ctx = context(&fixture.scope);
    let old_revision = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap()
        .note
        .revision;
    let successor = NoteId::from_bytes([92; 16]);
    let encrypted = |title| {
        format!(
            "---\nclass: encrypted-note\n---\n# {title}\n\n\x60\x60\x60age\n{ARMOR}\x60\x60\x60\n"
        )
    };
    let first = encrypted("Conversion");
    let converted = fixture
        .store
        .mint_and_purge(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 92),
                preconditions: Preconditions {
                    revision: Some(old_revision.clone()),
                    ..Default::default()
                },
                input: MintAndPurge {
                    old_note: old,
                    expected_revision: old_revision,
                    new_note: successor.clone(),
                    new_slug: Some("requested-name".into()),
                    encrypted_carrier: first.clone(),
                },
            },
        )
        .await
        .unwrap();
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let vault = fixture.roots.vault().unwrap();
    let expected = vault.read(name, 8192).unwrap().unwrap().stamp;
    let bytes = carrier::materialize(&first, DocClass::EncryptedNote, &successor).unwrap();
    let operation = ContentDigest::from_bytes([93; 32]);
    let slot = VaultDir::operation_slot(name, &operation.to_hex()).unwrap();
    let staged = vault.stage(name, &slot, bytes.as_bytes()).unwrap();
    let digest = |body: &str| ContentDigest::from_bytes(*blake3::hash(body.as_bytes()).as_bytes());
    let revision = converted.value.new_note.revision;
    let intent = serde_json::json!({
        "scope": binding.scope,
        "generation": binding.generation,
        "id": operation,
        "target": name,
        "action": { "Publish": {
            "desired": { "note": successor, "revision": revision,
                "carrier_digest": digest(&first), "disk_digest": digest(&bytes),
                "conversion_path": "requested-name.md" },
            "purpose": "Conversion", "expected": expected, "staged": staged,
            "retire": null, "abandoned": false,
        }}
    });
    let record = fixture
        .roots
        .data_root()
        .root()
        .join(format!("vault-notes-{}", binding.generation.to_hex()))
        .join(format!("{}.intent", operation.to_hex()));
    let file = fs::File::create(&record).unwrap();
    serde_json::to_writer(&file, &intent).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let published = vault
        .publish(
            name,
            &slot,
            Some(&expected),
            &staged,
            PublishMode::Conversion,
        )
        .unwrap();
    let Publication::Applied {
        displaced: Some(capture),
        ..
    } = published
    else {
        panic!("the fixture must stop after the filesystem exchange");
    };
    assert_eq!(disk_id(&path), Some(successor.clone()));

    let latest = encrypted("Current head");
    let update = fixture
        .store
        .accept_external_observation(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 94),
                preconditions: Preconditions::default(),
                input: ExternalObservation {
                    note: successor.clone(),
                    observed_digest: digest(&latest),
                    base_revision: revision,
                    disk_identity: operation,
                    content: ObservedContent::Carrier(latest.clone()),
                },
            },
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(update) = update else {
        panic!("the fixture must advance the encrypted head before recovery");
    };

    let worker = fixture.start();
    let mut status = worker.status();
    let target = carrier::materialize(&latest, DocClass::EncryptedNote, &successor).unwrap();
    let settled = ready(&mut status, |_| {
        fs::read_to_string(&path).is_ok_and(|bytes| bytes == target)
    })
    .await;
    assert!(settled.conflicts.is_empty(), "{settled:?}");
    assert!(!fixture.root.join("requested-name.md").exists());
    assert!(!record.exists());
    assert!(!fixture.root.join(capture.path).exists());
    assert!(
        fixture
            .store
            .vault_handoffs(&ctx, &binding)
            .await
            .unwrap()
            .is_empty()
    );
    let actual = fixture
        .store
        .vault_observation_for(&ctx, &binding, &successor)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual.revision, update.value.revision);
    worker.shutdown().await.unwrap();
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
async fn live_room_and_disk_edits_converge_on_the_same_file() {
    use notarium_canonical::{OpenCollabSession, RoomCommandSettlement};
    use notarium_core::ports::{
        FilenamePin, InterceptedMutation, InterceptedOutcome, InterceptedPayload,
        InterceptionResult, LiveCollabInterceptor, PortFuture, RollbackReservation,
    };

    struct Room(CanonicalStore, RoomCommandSettlement);
    impl LiveCollabInterceptor for Room {
        fn filename_pin(&self, _ctx: SpaceContext, _note: NoteId) -> PortFuture<'_, FilenamePin> {
            Box::pin(async { Ok(FilenamePin::Unpinned) })
        }

        fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
            Box::pin(async move {
                let InterceptedPayload::ExternalObservation {
                    observation,
                    vault_commit,
                    ..
                } = request.payload
                else {
                    panic!("the fixture only settles an external edit");
                };
                let result = self
                    .0
                    .commit_intercepted_external_observation(
                        request.context,
                        request.identity,
                        request.preconditions,
                        observation,
                        self.1.clone(),
                        vault_commit,
                    )
                    .await?;
                Ok(InterceptionResult::Applied(Box::new(
                    InterceptedOutcome::ExternalObservation(result),
                )))
            })
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
    let note = fixture.create("merged", 53).await;
    let file = fixture.root.join("merged.md");
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&file) == Some(note.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    let ctx = context(&fixture.scope);
    let head = fixture
        .store
        .read_vault_note(&ctx, &note)
        .await
        .unwrap()
        .unwrap();
    let active = fixture
        .store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: fixture.scope.clone(),
                note: note.clone(),
                owner_id: "vault-room".into(),
                expected_carrier_rev: head.note.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let disk_edit = fs::read_to_string(&file)
        .unwrap()
        .replace("Initial words.", "Disk edit.");
    fs::write(&file, &disk_edit).unwrap();
    let merged = "---\nstatus: room edit\n---\n# Start\n\nDisk edit.\n";
    let expected = carrier::materialize(merged, DocClass::UserDoc, &note).unwrap();
    let room = Arc::new(Room(
        fixture.store.clone(),
        RoomCommandSettlement {
            owner_id: active.owner_id.unwrap(),
            expected_lease: active.lease_epoch,
            expected_lineage: active.lineage_epoch,
            expected_base_rev: head.note.revision,
            final_carrier: merged.into(),
            yrs_snapshot: b"vault checkpoint".to_vec(),
            compacted_through_update_seq: None,
        },
    ));
    let worker = fixture.start_with_collaboration(Some(room));
    let state = ready(&mut worker.status(), |_| {
        fs::read_to_string(&file).is_ok_and(|text| text == expected)
    })
    .await;
    assert!(state.conflicts.is_empty());
    assert_eq!(disk_id(&file), Some(note));
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
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
    assert_eq!(result.publication, ConversionPublication::CleanupPending);
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
    assert_eq!(repeated.publication, ConversionPublication::Complete);
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
    let git = fixture.root.join(".git");
    fs::create_dir(&folder).unwrap();
    fs::create_dir(&unrelated).unwrap();
    fs::create_dir(&git).unwrap();
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
        let lock = git.join("index.lock");
        fs::write(&lock, "").unwrap();
        // Let the worker observe the lock before modifying the working tree.
        tokio::time::timeout(
            Duration::from_secs(10),
            status.wait_for(|state| state.phase == SyncPhase::WaitingForGit),
        )
        .await
        .expect("the worker must observe the Git lock")
        .unwrap();
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
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_purge_with_a_blocked_directory_allows_other_vault_paths() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::open().await;
    let old = fixture.create("purged", 117).await;
    let worker = fixture.start();
    let old_path = fixture.root.join("purged.md");
    ready(&mut worker.status(), |_| {
        disk_id(&old_path) == Some(old.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    let ctx = context(&fixture.scope);
    let prior_head = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 118),
                preconditions: Preconditions {
                    revision: Some(prior_head.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: old,
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    let projected_id = fixture.create("projected", 119).await;
    let projected = fixture.root.join("projected.md");
    let incoming = fixture.root.join("independent.md");
    fs::write(&incoming, "# Independent offline note\n").unwrap();
    let blocked = fixture.root.join("blocked");
    fs::create_dir(&blocked).unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(&blocked).is_ok() {
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
        fixture.runtime.shutdown().await.unwrap();
        return;
    }
    let worker = fixture.start();
    let mut status = worker.status();
    let observed = tokio::time::timeout(
        Duration::from_secs(5),
        status.wait_for(|_| {
            disk_id(&incoming).is_some() && disk_id(&projected) == Some(projected_id.clone())
        }),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let retained = !fixture
        .store
        .vault_handoffs(&ctx, &binding)
        .await
        .unwrap()
        .is_empty();
    let current = status.borrow().clone();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
    let acknowledged = tokio::time::timeout(Duration::from_secs(15), async {
        while !fixture
            .store
            .vault_handoffs(&ctx, &binding)
            .await
            .unwrap()
            .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .is_ok();
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
    assert!(observed, "unrelated notes did not converge: {current:?}");
    assert!(retained, "partial inventory acknowledged the pending purge");
    assert!(
        acknowledged,
        "purge was not acknowledged after native watch recovery"
    );
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreadable_markdown_does_not_acknowledge_ordinary_purge() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::open().await;
    let old = fixture.create("purged", 121).await;
    let path = fixture.root.join("purged.md");
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&path) == Some(old.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    // An editor already removed the ID. The inode witness must survive until
    // the sidecar can inspect and reconcile the residual Markdown.
    fs::write(&path, "# Start\n\nInitial words.\n").unwrap();
    assert_eq!(disk_id(&path), None);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&path).is_ok() {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fixture.runtime.shutdown().await.unwrap();
        return;
    }
    let ctx = context(&fixture.scope);
    let head = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 122),
                preconditions: Preconditions {
                    revision: Some(head.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: old.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    let independent = fixture.create("independent", 123).await;
    let worker = fixture.start();
    ready(&mut worker.status(), |status| {
        status
            .conflicts
            .iter()
            .any(|issue| issue.path == "purged.md")
            && disk_id(&fixture.root.join("independent.md")) == Some(independent.clone())
    })
    .await;
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let retained = fixture
        .store
        .vault_handoffs(&ctx, &binding)
        .await
        .unwrap()
        .iter()
        .any(|handoff| handoff.old_note == old);
    let moved = fixture.root.join("moved.md");
    fs::rename(&path, &moved).unwrap();
    fs::set_permissions(&moved, fs::Permissions::from_mode(0o600)).unwrap();
    ready(&mut worker.status(), |status| {
        status
            .conflicts
            .iter()
            .any(|issue| issue.path == "moved.md")
    })
    .await;
    let moved_observation = fixture
        .store
        .vault_observation_at(&ctx, &binding, "moved.md")
        .await
        .unwrap();
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
    assert!(
        retained,
        "purge witness was dropped while its file remained unreadable"
    );
    assert!(moved_observation.is_none());
    assert!(disk_id(&moved).is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_canonical_edit_resumes_when_parent_is_writable() {
    use notarium_core::ports::{ExternalObservation, ExternalObservationResult, ObservedContent};
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::open().await;
    let folder = fixture.root.join("folder");
    fs::create_dir(&folder).unwrap();
    let file = folder.join("blocked.md");
    fs::write(&file, "# Original content\n").unwrap();
    let worker = fixture.start();
    let mut status = worker.status();
    ready(&mut status, |_| disk_id(&file).is_some()).await;
    let note = disk_id(&file).unwrap();
    let ctx = context(&fixture.scope);
    let before = fixture
        .store
        .read_vault_note(&ctx, &note)
        .await
        .unwrap()
        .unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    let probe = folder.join(".permission-probe");
    if fs::write(&probe, b"probe").is_ok() {
        fs::remove_file(&probe).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
        worker.shutdown().await.unwrap();
        fixture.runtime.shutdown().await.unwrap();
        return;
    }
    assert!(fs::read(&file).is_ok());
    let body = "# Revised canonical content\n";
    let update = fixture
        .store
        .accept_external_observation(
            ctx,
            Mutation {
                identity: identity(&fixture.scope, 124),
                preconditions: Preconditions::default(),
                input: ExternalObservation {
                    note: note.clone(),
                    observed_digest: ContentDigest::from_bytes(
                        *blake3::hash(body.as_bytes()).as_bytes(),
                    ),
                    base_revision: before.note.revision,
                    disk_identity: ContentDigest::from_bytes([124; 32]),
                    content: ObservedContent::Carrier(body.into()),
                },
            },
        )
        .await
        .unwrap();
    let ExternalObservationResult::Committed(updated) = update else {
        panic!("expected a canonical edit")
    };
    ready(&mut status, |value| {
        value.cursor >= updated.receipt.seq()
            && value
                .conflicts
                .iter()
                .any(|issue| issue.path == "folder/blocked.md")
    })
    .await;
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    let resumed = tokio::time::timeout(
        Duration::from_secs(5),
        status.wait_for(|value| {
            value.phase == SyncPhase::Watching
                && value.conflicts.is_empty()
                && fs::read_to_string(&file).is_ok_and(|text| text.contains(body))
        }),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    let actual = status.borrow().clone();
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
    assert!(resumed, "pending publication did not resume: {actual:?}");
    assert_eq!(disk_id(&file), Some(note));
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unresolved_withdrawal_keeps_its_purge_handoff() {
    use notarium_vault::filesystem::{VaultDir, Withdrawal};

    let fixture = Fixture::open().await;
    let old = fixture.create("purged", 135).await;
    let target = Path::new("purged.md");
    let file = fixture.root.join(target);
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&file) == Some(old.clone())
    })
    .await;
    worker.shutdown().await.unwrap();
    let ctx = context(&fixture.scope);
    let head = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 136),
                preconditions: Preconditions {
                    revision: Some(head.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: old.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();

    let vault = fixture.roots.vault().unwrap();
    let expected = vault.read(target, 8192).unwrap().unwrap().stamp;
    let operation = ContentDigest::from_bytes([137; 32]);
    let slot = VaultDir::operation_slot(target, &operation.to_hex()).unwrap();
    let record = fixture
        .roots
        .data_root()
        .root()
        .join(format!("vault-notes-{}", binding.generation.to_hex()))
        .join(format!("{}.intent", operation.to_hex()));
    let journal_file = fs::File::create(&record).unwrap();
    serde_json::to_writer(
        &journal_file,
        &serde_json::json!({
            "scope": binding.scope,
            "generation": binding.generation,
            "id": operation,
            "target": target,
            "action": { "Withdraw": { "expected": expected } },
        }),
    )
    .unwrap();
    journal_file.sync_all().unwrap();
    drop(journal_file);
    assert!(matches!(
        vault.withdraw(target, &slot, &expected).unwrap(),
        Withdrawal::Captured(_)
    ));
    let capture = fixture.root.join(&slot);
    fs::write(&capture, "# Updated through the old editor handle\n").unwrap();
    let unrelated = fixture.create("unrelated", 138).await;
    let unrelated_file = fixture.root.join("unrelated.md");

    let worker = fixture.start();
    let status = ready(&mut worker.status(), |_| {
        disk_id(&unrelated_file) == Some(unrelated.clone())
    })
    .await;
    assert!(
        status
            .conflicts
            .iter()
            .any(|issue| issue.path == "purged.md")
    );
    assert!(record.exists() && capture.exists());
    assert_eq!(
        fixture
            .store
            .vault_handoffs(&ctx, &binding)
            .await
            .unwrap()
            .len(),
        1
    );
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_collision_does_not_hide_an_unclaimed_purge_inode() {
    let fixture = Fixture::open().await;
    let old = fixture.create("purged", 131).await;
    let original = fixture.root.join("purged.md");
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&original) == Some(old.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    let first = fixture.root.join("Alias.md");
    let moved = fixture.root.join("alias.md");
    fs::write(&original, "# Start\n\nInitial words.\n").unwrap();
    assert!(disk_id(&original).is_none());
    fs::rename(&original, &moved).unwrap();
    let first_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&first);
    let mut first_file = match first_file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            fixture.runtime.shutdown().await.unwrap();
            return;
        }
        Err(error) => panic!("cannot create the distinct case alias: {error}"),
    };
    std::io::Write::write_all(&mut first_file, b"# Unrelated Markdown\n").unwrap();
    drop(first_file);

    let ctx = context(&fixture.scope);
    let head = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 132),
                preconditions: Preconditions {
                    revision: Some(head.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: old.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    let worker = fixture.start();
    ready(&mut worker.status(), |status| {
        status
            .conflicts
            .iter()
            .any(|issue| issue.path == "alias.md")
            && status
                .conflicts
                .iter()
                .any(|issue| issue.path == "Alias.md")
    })
    .await;
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let retained = fixture
        .store
        .vault_handoffs(&ctx, &binding)
        .await
        .unwrap()
        .iter()
        .any(|handoff| handoff.old_note == old);
    fs::remove_file(first).unwrap();
    ready(&mut worker.status(), |status| {
        status.conflicts.iter().any(|issue| {
            issue.path == "alias.md"
                && issue.reason == notarium_vault::ConflictReason::ClaimedPurgedIdentity
        })
    })
    .await;
    assert!(
        fixture
            .store
            .vault_observation_at(&ctx, &binding, "alias.md")
            .await
            .unwrap()
            .is_none()
    );
    assert!(disk_id(&moved).is_none());
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
    assert!(
        retained,
        "a colliding spelling hid the remaining purged inode"
    );
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlapping_conversion_and_purge_keep_both_handoffs() {
    const ARMOR: &str = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    let fixture = Fixture::open().await;
    let converted = fixture.create("switch", 151).await;
    let retired = fixture.create("retired", 152).await;
    assert!(converted.as_str() < retired.as_str());
    let conversion_path = fixture.root.join("switch.md");
    let retired_path = fixture.root.join("retired.md");
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&conversion_path) == Some(converted.clone())
            && disk_id(&retired_path) == Some(retired.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    let ctx = context(&fixture.scope);
    let conversion_base = fixture
        .store
        .read_vault_note(&ctx, &converted)
        .await
        .unwrap()
        .unwrap();
    let retired_base = fixture
        .store
        .read_vault_note(&ctx, &retired)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .mint_and_purge(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 153),
                preconditions: Preconditions {
                    revision: Some(conversion_base.note.revision.clone()),
                    ..Default::default()
                },
                input: MintAndPurge {
                    old_note: converted.clone(),
                    expected_revision: conversion_base.note.revision,
                    new_note: NoteId::from_bytes([153; 16]),
                    new_slug: Some("encrypted".into()),
                    encrypted_carrier: format!(
                        "---\nclass: encrypted-note\n---\n\x60\x60\x60age\n{ARMOR}\x60\x60\x60\n"
                    ),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 154),
                preconditions: Preconditions {
                    revision: Some(retired_base.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: retired.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();

    let edited = "# A saved edit from the retired file\n";
    fs::write(&retired_path, edited).unwrap();
    fs::rename(&retired_path, &conversion_path).unwrap();
    let worker = fixture.start();
    ready(&mut worker.status(), |status| {
        status
            .conflicts
            .iter()
            .any(|issue| issue.path == "switch.md")
    })
    .await;
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let handoffs = fixture.store.vault_handoffs(&ctx, &binding).await.unwrap();
    assert!(
        handoffs
            .iter()
            .any(|handoff| handoff.old_note == retired && handoff.new_note.is_none())
    );
    assert!(
        handoffs
            .iter()
            .any(|handoff| handoff.old_note == converted && handoff.new_note.is_some())
    );
    assert_eq!(fs::read_to_string(&conversion_path).unwrap(), edited);
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_foreign_asserted_id_does_not_hide_the_purged_inode() {
    let fixture = Fixture::open().await;
    let old = fixture.create("purged", 141).await;
    let foreign = fixture.create("other", 142).await;
    let original = fixture.root.join("purged.md");
    let moved = fixture.root.join("moved.md");
    let fresh = fixture.root.join("fresh.md");
    let worker = fixture.start();
    ready(&mut worker.status(), |_| {
        disk_id(&original) == Some(old.clone())
    })
    .await;
    worker.shutdown().await.unwrap();

    let body = "# Old body after an external edit\n";
    let edited = carrier::materialize(body, DocClass::UserDoc, &foreign).unwrap();
    fs::write(&original, edited).unwrap();
    fs::rename(&original, &moved).unwrap();
    assert_eq!(disk_id(&moved), Some(foreign));

    let ctx = context(&fixture.scope);
    let head = fixture
        .store
        .read_vault_note(&ctx, &old)
        .await
        .unwrap()
        .unwrap();
    fixture
        .store
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: identity(&fixture.scope, 143),
                preconditions: Preconditions {
                    revision: Some(head.note.revision),
                    ..Default::default()
                },
                input: DeleteNote {
                    note: old.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();

    let worker = fixture.start();
    let mut status = worker.status();
    ready(&mut status, |status| {
        status.conflicts.iter().any(|issue| {
            issue.path == "moved.md"
                && issue.reason == notarium_vault::ConflictReason::ClaimedPurgedIdentity
        })
    })
    .await;
    let binding = fixture.store.vault_binding(&ctx).await.unwrap().unwrap();
    let retained = fixture
        .store
        .vault_handoffs(&ctx, &binding)
        .await
        .unwrap()
        .iter()
        .any(|handoff| handoff.old_note == old);
    worker.shutdown().await.unwrap();

    fs::write(&moved, body).unwrap();
    fs::rename(&moved, &fresh).unwrap();
    let worker = fixture.start();
    ready(&mut worker.status(), |_| true).await;
    let reminted = fixture
        .store
        .vault_observation_at(&ctx, &binding, "fresh.md")
        .await
        .unwrap()
        .is_some();
    worker.shutdown().await.unwrap();
    fixture.runtime.shutdown().await.unwrap();
    assert!(
        retained,
        "another asserted ID hid the old inode from acknowledgement"
    );
    assert!(!reminted, "the same inode was imported at the second path");
    assert!(disk_id(&fresh).is_none());
}

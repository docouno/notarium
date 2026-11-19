#![forbid(unsafe_code)]

mod support;

use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, SqlBackendConfig,
    vault::{VaultFileStamp, VaultImport, VaultObservation, VaultPath},
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, GrantId, LeaseEpoch, NoteId, RequestId, SpaceSeq},
    ports::{
        CallBudget, CreateNote, DeleteDisposition, DeleteNote, ExternalObservation,
        ExternalObservationResult, MintAndPurge, MoveNote, Mutation, NoteRevision, NoteWritePort,
        ObservedContent, RenameFolder, ServicePurpose, SpaceContext,
    },
    receipt::CommandIdentity,
};
use support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, random_bytes_16,
    sample_folder_id, sample_incarnation, sample_installation_id, sample_note_id,
    sample_principal_id, sample_space_id,
};

async fn seed_space(store: &CanonicalStore) -> SpaceContext {
    let owner = sample_principal_id(31);
    let rec = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(31),
            incarnation: sample_incarnation(31),
            root_folder_id: sample_folder_id(1),
            slug: "vault-test".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let human = VerifiedHuman::attest(
        owner,
        GrantId::from_bytes([31; 16]),
        BTreeMap::from([(
            rec.scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        true,
    )
    .with_human_management(true);
    SpaceContext::new(
        EngineAuthContext::for_human(human),
        rec.scope,
        CallBudget {
            request: RequestId::from_bytes(random_bytes_16()),
            cancellation: Default::default(),
            remaining: Duration::from_secs(10),
        },
    )
    .unwrap()
}

fn identity(ctx: &SpaceContext) -> CommandIdentity {
    CommandIdentity {
        scope: ctx.scope().clone(),
        actor: ctx.auth().principal().clone(),
        key: CommandKey::from_bytes(random_bytes_16()),
        hash: ContentDigest::from_bytes([17; 32]),
    }
}

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: identity(ctx),
        preconditions: Default::default(),
        input,
    }
}

fn path(relative: &str) -> VaultPath {
    VaultPath {
        relative: relative.into(),
        key: relative.to_lowercase(),
    }
}

fn stamp(bytes: &str, serial: u8) -> VaultFileStamp {
    VaultFileStamp {
        size: bytes.len() as u64,
        identity: ContentDigest::from_bytes([serial; 32]),
        mtime_seconds: 1_800_000_000,
        mtime_nanos: 50,
        digest: notarium_syntax::content_digest(bytes),
    }
}

fn candidate(serial: u8, claimed_note: Option<NoteId>, slug: &str, body: &str) -> VaultImport {
    VaultImport {
        create: CreateNote {
            note: sample_note_id(serial),
            parent: None,
            slug: slug.into(),
            class: DocClass::UserDoc,
            carrier: body.into(),
        },
        claimed_note,
        path: path(&format!("{slug}.md")),
        file: stamp(body, serial),
    }
}

async fn edit_body(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    base: &NoteRevision,
    body: &str,
) -> NoteRevision {
    let result = store
        .accept_external_observation(
            ctx.clone(),
            mutation(
                ctx,
                ExternalObservation {
                    note: base.note.clone(),
                    observed_digest: notarium_syntax::content_digest(body),
                    base_revision: base.revision.clone(),
                    disk_identity: ContentDigest::from_bytes([99; 32]),
                    content: ObservedContent::Carrier(body.into()),
                },
            ),
        )
        .await
        .unwrap();
    match result {
        ExternalObservationResult::Committed(result) => result.value,
        other => panic!("expected a committed edit, got {other:?}"),
    }
}

#[tokio::test]
async fn changed_head_is_reread_and_exact_prior_publication_can_be_stamped() {
    let root = TempDataRoot::new("vault-racing-canonical-head");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let original = store
        .create_note(
            ctx.clone(),
            mutation(&ctx, candidate(41, None, "published", "version one").create),
        )
        .await
        .unwrap()
        .value;
    let unrelated = store
        .create_note(
            ctx.clone(),
            mutation(
                &ctx,
                candidate(42, None, "another-note", "version one").create,
            ),
        )
        .await
        .unwrap()
        .value;
    let mut updated = None;
    let mut checks = 0;
    let read = store
        .read_vault_note_with_recheck_hook(&ctx, &original.note, async || {
            checks += 1;
            if updated.is_none() {
                updated = Some(edit_body(&store, &ctx, &original, "version two").await);
            }
        })
        .await
        .unwrap()
        .unwrap();
    let updated = updated.unwrap();
    assert_eq!(checks, 2);
    assert_eq!(read.note, updated);
    assert_eq!(read.carrier, "version two");

    let file = stamp("version one", 41);
    let old = VaultObservation {
        note: original.note.clone(),
        revision: original.revision.clone(),
        path: path("published.md"),
        carrier_digest: file.digest,
        file,
    };
    store
        .put_vault_observation(ctx.clone(), &binding, None, old.clone())
        .await
        .unwrap();
    let mut wrong_digest = old.clone();
    wrong_digest.carrier_digest = read.carrier_digest;
    assert_validation_err(
        &store
            .put_vault_observation(ctx.clone(), &binding, Some(old.clone()), wrong_digest)
            .await,
        ValidationReason::InvalidDigest,
    );
    let mut wrong_revision = old.clone();
    wrong_revision.revision = unrelated.revision;
    assert!(matches!(
        store
            .put_vault_observation(ctx.clone(), &binding, Some(old.clone()), wrong_revision)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let mut next = old.clone();
    next.revision = read.note.revision;
    next.carrier_digest = read.carrier_digest;
    next.file = stamp("version two", 43);
    assert_validation_err(
        &store
            .put_vault_observation(ctx.clone(), &binding, None, next.clone())
            .await,
        ValidationReason::CursorStale,
    );
    store
        .put_vault_observation(ctx.clone(), &binding, Some(old.clone()), next.clone())
        .await
        .unwrap();

    let mut changing = updated;
    let mut count = 0;
    let result = store
        .read_vault_note_with_recheck_hook(&ctx, &original.note, async || {
            count += 1;
            changing = edit_body(&store, &ctx, &changing, &format!("concurrent {count}")).await;
        })
        .await;
    assert!(matches!(result, Err(PortError::Unavailable(_))));
    assert_eq!(count, 3);
    store
        .delete_note(
            ctx.clone(),
            mutation(
                &ctx,
                DeleteNote {
                    note: original.note,
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .put_vault_observation(ctx, &binding, Some(next), old)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_creation_receipt_is_invalid_after_rename_and_a_new_attempt_reuses_the_name() {
    let root = TempDataRoot::new("vault-folder-receipt-placement");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let old = sample_folder_id(3);
    let attempt = identity(&ctx);
    store
        .writer_faults()
        .unwrap()
        .drop_commit_response_once
        .store(true, Ordering::SeqCst);
    assert!(
        store
            .resolve_vault_folder(
                ctx.clone(),
                &binding,
                None,
                "Folder",
                old.clone(),
                attempt.clone(),
            )
            .await
            .is_err()
    );
    assert_eq!(
        store
            .resolve_vault_folder(
                ctx.clone(),
                &binding,
                None,
                "Folder",
                old.clone(),
                attempt.clone()
            )
            .await
            .unwrap(),
        old,
    );
    store
        .rename_folder(
            ctx.clone(),
            mutation(
                &ctx,
                RenameFolder {
                    folder: old.clone(),
                    name: "renamed".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert_validation_err(
        &store
            .resolve_vault_folder(ctx.clone(), &binding, None, "Folder", old.clone(), attempt)
            .await,
        ValidationReason::CursorStale,
    );
    let fresh = sample_folder_id(4);
    assert_eq!(
        store
            .resolve_vault_folder(
                ctx.clone(),
                &binding,
                None,
                "Folder",
                fresh.clone(),
                identity(&ctx)
            )
            .await
            .unwrap(),
        fresh,
    );
    assert_eq!(
        store
            .resolve_vault_folder(
                ctx.clone(),
                &binding,
                None,
                "renamed",
                sample_folder_id(5),
                identity(&ctx)
            )
            .await
            .unwrap(),
        old,
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_service_open_refuses_hardlink_aliases() {
    let data = TempDataRoot::new("sqlite-hardlink-alias");
    let outside = TempDataRoot::new("sqlite-service-target");
    let service = data.path().join("v1");
    fs::create_dir(&service).unwrap();
    let target = outside.path().join("sentinel");
    fs::write(&target, b"outside state").unwrap();
    for name in [
        "canonical-owner.lock",
        "canonical.sqlite",
        "canonical.sqlite-wal",
        "canonical.sqlite-shm",
        "canonical.sqlite-journal",
    ] {
        let alias = service.join(name);
        fs::hard_link(&target, &alias).unwrap();
        let config = CanonicalConfig::local_default(sample_installation_id(31), data.data_root());
        assert!(
            CanonicalRuntime::open(config).await.is_err(),
            "{name} was accepted"
        );
        assert_eq!(fs::read(&target).unwrap(), b"outside state");
        fs::remove_file(alias).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn canonical_owner_lock_refuses_aliased_v1_directory() {
    let data = TempDataRoot::new("sqlite-aliased-service-dir");
    let outside = TempDataRoot::new("sqlite-aliased-service-target");
    std::os::unix::fs::symlink(outside.path(), data.path().join("v1")).unwrap();
    assert!(notarium_canonical::DataRootOwnerLock::acquire(&data.data_root()).is_err());
    assert!(!outside.path().join("canonical-owner.lock").exists());
}

#[tokio::test]
async fn vault_move_guard_persists_purge_handoff_and_blocks_delayed_fenced_import() {
    let root = TempDataRoot::new("vault-binding-purge");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    guarded_purge_roundtrip(config).await;
}

#[tokio::test]
async fn postgres_vault_move_guard_preserves_the_purge_fence() {
    let fixtures = StorageTestFixtures::load_required();
    let root = TempDataRoot::new("vault-pg-binding-purge");
    let config = fixtures.pg_local_config(
        sample_installation_id(31),
        &fixtures.fresh_pg_schema(),
        root.data_root(),
    );
    guarded_purge_roundtrip(config).await;
}

async fn guarded_purge_roundtrip(config: CanonicalConfig) {
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let directory_id = sample_folder_id(3);
    let folder_identity = identity(&ctx);
    for _ in 0..2 {
        assert_eq!(
            store
                .resolve_vault_folder(
                    ctx.clone(),
                    &binding,
                    None,
                    "Folder",
                    directory_id.clone(),
                    folder_identity.clone(),
                )
                .await
                .unwrap(),
            directory_id
        );
    }

    let input = candidate(31, None, "original", "note body");
    let original = input.create.note.clone();
    let import = mutation(&ctx, input);
    let created = store
        .import_vault_note(ctx.clone(), &binding, import.clone())
        .await
        .unwrap();
    let replayed = store
        .import_vault_note(ctx.clone(), &binding, import)
        .await
        .unwrap();
    assert_eq!(replayed.receipt, created.receipt);
    store
        .advance_vault_cursor(ctx.clone(), &binding, binding.cursor, created.receipt.seq())
        .await
        .unwrap();
    let original_stamp = store
        .vault_observation_at(&ctx, &binding, "original.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original_stamp.revision, created.value.revision);

    let moved_path = path("Folder/moved.md");
    let moved = store
        .move_vault_note(
            ctx.clone(),
            &binding,
            original_stamp.clone(),
            moved_path.clone(),
            mutation(
                &ctx,
                MoveNote {
                    note: original.clone(),
                    parent: Some(directory_id.clone()),
                    slug: "moved".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        store
            .vault_observation_at(&ctx, &binding, "original.md")
            .await
            .unwrap()
            .is_none()
    );
    let moved_stamp = store
        .vault_observation_at(&ctx, &binding, &moved_path.key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved_stamp.revision, moved.value.revision);
    assert_eq!(moved_stamp.file, original_stamp.file);
    assert_eq!(
        store
            .vault_observations(&ctx, &binding, Some("folder"), None, 64)
            .await
            .unwrap(),
        vec![moved_stamp.clone()]
    );
    assert_eq!(
        store
            .vault_note_ids_below_folder(&ctx, &directory_id, None, 64)
            .await
            .unwrap(),
        vec![original.clone()]
    );

    let changed_body = "note body after external save";
    let fresh_stamp = stamp(changed_body, 36);
    let observe = mutation(
        &ctx,
        ExternalObservation {
            note: original.clone(),
            observed_digest: fresh_stamp.digest,
            base_revision: moved.value.revision,
            disk_identity: fresh_stamp.identity,
            content: ObservedContent::Carrier(changed_body.into()),
        },
    );
    assert_validation_err(
        &store
            .accept_vault_observation(ctx.clone(), &binding, original_stamp, observe.clone())
            .await,
        ValidationReason::CursorStale,
    );
    let ExternalObservationResult::Committed(edited) = store
        .accept_vault_observation(ctx.clone(), &binding, moved_stamp.clone(), observe)
        .await
        .unwrap()
    else {
        panic!("expected committed guarded observation");
    };
    let edited_stamp = VaultObservation {
        note: original.clone(),
        revision: edited.value.revision,
        path: moved_path,
        file: fresh_stamp.clone(),
        carrier_digest: fresh_stamp.digest,
    };
    store
        .put_vault_observation(
            ctx.clone(),
            &binding,
            Some(moved_stamp),
            edited_stamp.clone(),
        )
        .await
        .unwrap();

    let delayed = mutation(
        &ctx,
        candidate(32, Some(original.clone()), "late-copy", changed_body),
    );
    let released = store
        .delete_note(
            ctx.clone(),
            mutation(
                &ctx,
                DeleteNote {
                    note: original.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();

    let postgres = matches!(&config.sql, SqlBackendConfig::Postgres { .. });
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    if postgres {
        store
            .advance_space_lease(
                &maintenance_ctx(ServicePurpose::Revocation),
                ctx.scope(),
                LeaseEpoch::new(2).unwrap(),
            )
            .await
            .unwrap();
    }
    let saved_binding = store.vault_binding(&ctx).await.unwrap().unwrap();
    assert_eq!(saved_binding.generation, binding.generation);
    assert_eq!(saved_binding.cursor, created.receipt.seq());
    assert!(
        store
            .vault_observation_for(&ctx, &binding, &original)
            .await
            .unwrap()
            .is_none()
    );
    let handoffs = store.vault_handoffs(&ctx, &binding).await.unwrap();
    let [handoff] = handoffs.as_slice() else {
        panic!("expected a single withdrawal");
    };
    assert_eq!(handoff.observation, edited_stamp);
    assert_eq!(handoff.purge_seq, released.receipt.seq());
    assert!(handoff.new_note.is_none());
    assert!(
        store
            .vault_candidate_is_quarantined(
                &ctx,
                &binding,
                &path("moved-externally.md"),
                &edited_stamp.file,
                Some(&original),
            )
            .await
            .unwrap()
    );
    let denied = store
        .import_vault_note(ctx.clone(), &binding, delayed.clone())
        .await;
    assert!(
        matches!(
            denied,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "the purged identity must remain fenced: {denied:?}"
    );

    let checks = AtomicUsize::new(0);
    assert!(matches!(
        store.complete_vault_purge(ctx.clone(), &binding, handoff.clone(), move || {
                checks.fetch_add(1, Ordering::Relaxed) == 0
        }).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorStale
    ));
    assert_eq!(
        store.vault_handoffs(&ctx, &binding).await.unwrap(),
        vec![handoff.clone()]
    );
    store
        .complete_vault_purge(ctx.clone(), &binding, handoff.clone(), || true)
        .await
        .unwrap();
    assert!(
        store
            .vault_handoffs(&ctx, &binding)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .vault_is_purge_fenced(&ctx, &binding, &original)
            .await
            .unwrap()
    );
    assert!(matches!(
        store
            .import_vault_note(ctx.clone(), &binding, delayed)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    store
        .import_vault_note(
            ctx.clone(),
            &binding,
            mutation(&ctx, candidate(33, None, "independent", "unrelated")),
        )
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_mint_purge_handoff_keeps_path_and_completes_with_authenticated_successor() {
    let fixtures = StorageTestFixtures::load_required();
    let root = TempDataRoot::new("vault-pg-convert");
    let config = fixtures.pg_local_config(
        sample_installation_id(31),
        &fixtures.fresh_pg_schema(),
        root.data_root(),
    );
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let original = store
        .import_vault_note(
            ctx.clone(),
            &binding,
            mutation(&ctx, candidate(40, None, "same-path", "before")),
        )
        .await
        .unwrap();
    let stamp_before = store
        .vault_observation_for(&ctx, &binding, &original.value.note)
        .await
        .unwrap()
        .unwrap();
    let new_note = sample_note_id(41);
    let armor = include_str!("../../notarium-syntax/tests/fixtures/age-v1.asc");
    let encrypted =
        format!("---\nclass: encrypted-note\n---\n\n\x60\x60\x60age\n{armor}\x60\x60\x60\n");
    let converted = store
        .mint_and_purge(
            ctx.clone(),
            mutation(
                &ctx,
                MintAndPurge {
                    old_note: original.value.note.clone(),
                    expected_revision: original.value.revision,
                    new_note: new_note.clone(),
                    new_slug: Some("different-canonical-name".into()),
                    encrypted_carrier: encrypted.clone(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        store
            .vault_observation_for(&ctx, &binding, &original.value.note)
            .await
            .unwrap()
            .is_none()
    );
    let handoffs = store.vault_handoffs(&ctx, &binding).await.unwrap();
    let [handoff] = handoffs.as_slice() else {
        panic!("expected a single conversion");
    };
    assert_eq!(handoff.new_note.as_ref(), Some(&converted.value.new_note));
    assert_eq!(handoff.observation, stamp_before);

    let stamp_after = VaultObservation {
        note: new_note.clone(),
        revision: converted.value.new_note.revision,
        path: stamp_before.path,
        file: stamp(&encrypted, 41),
        carrier_digest: notarium_syntax::content_digest(&encrypted),
    };
    for _ in 0..2 {
        store
            .complete_vault_handoff(ctx.clone(), &binding, handoff.clone(), stamp_after.clone())
            .await
            .unwrap();
    }
    assert_eq!(
        store
            .vault_observation_for(&ctx, &binding, &new_note)
            .await
            .unwrap(),
        Some(stamp_after),
    );
    assert!(
        store
            .vault_handoffs(&ctx, &binding)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .vault_is_purge_fenced(&ctx, &binding, &original.value.note)
            .await
            .unwrap()
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn case_only_folder_rename_keeps_folder_and_note_identity_and_records_exact_path() {
    let root = TempDataRoot::new("vault-folder-case-change");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let id = sample_folder_id(3);
    store
        .resolve_vault_folder(
            ctx.clone(),
            &binding,
            None,
            "alpha",
            id.clone(),
            identity(&ctx),
        )
        .await
        .unwrap();
    let initial = store
        .vault_folder_at(&ctx, &binding, None, "Alpha")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(initial.name, "alpha");
    assert_eq!(initial.id, id);
    let mut input = candidate(41, None, "nested", "note body");
    input.create.parent = Some(id.clone());
    input.path = path("alpha/nested.md");
    let created = store
        .import_vault_note(ctx.clone(), &binding, mutation(&ctx, input))
        .await
        .unwrap();
    let previous = store
        .vault_observation_for(&ctx, &binding, &created.value.note)
        .await
        .unwrap()
        .unwrap();

    let mut rename = mutation(
        &ctx,
        RenameFolder {
            folder: id.clone(),
            name: "Alpha".into(),
        },
    );
    rename.preconditions.revision = Some(initial.revision.clone());
    store.rename_folder(ctx.clone(), rename).await.unwrap();
    let renamed = store
        .vault_folder_at(&ctx, &binding, None, "alpha")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.name, "Alpha");
    assert_eq!(renamed.id, id);
    assert_eq!(renamed.parent, initial.parent);
    assert_ne!(renamed.revision, initial.revision);

    // The note's logical parent ID and slug are both unchanged.
    let updated = store
        .move_vault_note(
            ctx.clone(),
            &binding,
            previous.clone(),
            path("Alpha/nested.md"),
            mutation(
                &ctx,
                MoveNote {
                    note: created.value.note.clone(),
                    parent: Some(id),
                    slug: "nested".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(updated.value.note, created.value.note);
    let current = store
        .vault_observation_at(&ctx, &binding, "alpha/nested.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, updated.value.revision);
    assert_eq!(current.path.relative, "Alpha/nested.md");
    assert_eq!(current.file, previous.file);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn watcher_fence_invalidated_at_commit_rolls_back_trash_receipt_and_stamp() {
    let root = TempDataRoot::new("vault-watch-cut-invalidated");
    let config = CanonicalConfig::local_default(sample_installation_id(31), root.data_root());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let ctx = seed_space(&store).await;
    let binding = store
        .bind_vault(
            ctx.clone(),
            ContentDigest::from_bytes([1; 32]),
            ContentDigest::from_bytes([2; 32]),
            None,
        )
        .await
        .unwrap();
    let created = store
        .import_vault_note(
            ctx.clone(),
            &binding,
            mutation(&ctx, candidate(41, None, "missing", "note body")),
        )
        .await
        .unwrap();
    let stamp = store
        .vault_observation_for(&ctx, &binding, &created.value.note)
        .await
        .unwrap()
        .unwrap();
    let action = mutation(
        &ctx,
        DeleteNote {
            note: created.value.note.clone(),
            disposition: DeleteDisposition::Trash,
        },
    );
    let checks = Arc::new(AtomicUsize::new(0));
    let writer_checks = checks.clone();

    // Admit the mutation through both item checks, then invalidate the watch
    // generation at the writer callback immediately before committing SQL.
    let result = store
        .trash_vault_note_with_fence(
            ctx.clone(),
            &binding,
            stamp.clone(),
            action.clone(),
            move || writer_checks.fetch_add(1, Ordering::SeqCst) < 2,
        )
        .await;
    assert_validation_err(&result, ValidationReason::CursorStale);
    assert!(checks.load(Ordering::SeqCst) >= 3);
    assert_eq!(store.vault_head(&ctx).await.unwrap(), created.receipt.seq());
    assert_eq!(
        store
            .read_vault_note(&ctx, &created.value.note)
            .await
            .unwrap()
            .unwrap()
            .note,
        created.value,
    );
    assert_eq!(
        store
            .vault_observation_for(&ctx, &binding, &created.value.note)
            .await
            .unwrap(),
        Some(stamp.clone()),
    );

    // A new stable reconciliation can use the same command identity.
    store
        .trash_vault_note_with_fence(ctx.clone(), &binding, stamp, action, || true)
        .await
        .unwrap();
    assert!(
        store
            .read_vault_note(&ctx, &created.value.note)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .vault_observation_for(&ctx, &binding, &created.value.note)
            .await
            .unwrap()
            .is_none()
    );
    runtime.shutdown().await.unwrap();
}

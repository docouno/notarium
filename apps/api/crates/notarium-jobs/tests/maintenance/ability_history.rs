use super::*;
use notarium_core::classes::AbilityKind;

pub(super) const CARRIER: &str = "---\nclass: skill\n---\n# Revision-pinned skill\n";

pub(super) struct AbilityHistory {
    entrypoint: NoteId,
    original: RevisionId,
    first: AbilityRef,
    current: AbilityRef,
    unavailable: Vec<AbilityRef>,
}

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
            hash: ContentDigest::from_bytes([0; 32]),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

async fn skill(store: &CanonicalStore, ctx: &SpaceContext, slug: &str) -> NoteRevision {
    store
        .create_note(
            ctx.clone(),
            mutation(
                ctx,
                CreateNote {
                    note: NoteId::from_bytes(codec::ordered_id_16().unwrap()),
                    parent: None,
                    slug: slug.into(),
                    class: DocClass::Skill,
                    carrier: CARRIER.into(),
                },
            ),
        )
        .await
        .unwrap()
        .value
}

async fn publish(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    ability: &AbilityId,
    previous: Option<RevisionId>,
) -> AbilityRef {
    let package = store
        .publish_ability_package(
            ctx.clone(),
            mutation(
                ctx,
                PublishAbilityPackage {
                    ability: ability.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: note.clone(),
                    files: Vec::new(),
                    expected_package_revision: previous,
                },
            ),
        )
        .await
        .unwrap();
    AbilityRef {
        id: ability.clone(),
        placement: AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        revision: package.value.revision,
    }
}

async fn disposition(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    action: DeleteDisposition,
) {
    store
        .delete_note(
            ctx.clone(),
            mutation(
                ctx,
                DeleteNote {
                    note: note.clone(),
                    disposition: action,
                },
            ),
        )
        .await
        .unwrap();
}

impl AbilityHistory {
    pub(super) async fn create(
        store: &CanonicalStore,
        scope: &HistoryScope,
        owner: &PrincipalId,
    ) -> Self {
        let ctx = human_context(scope, owner, true);
        let entry = skill(store, &ctx, "original-skill").await;
        let ability = AbilityId::from_bytes(codec::ordered_id_16().unwrap());
        let rename = |slug: &str| {
            store.rename_note(
                ctx.clone(),
                mutation(
                    &ctx,
                    RenameNote {
                        note: entry.note.clone(),
                        slug: slug.into(),
                        title: None,
                    },
                ),
            )
        };
        rename("first-publication").await.unwrap();
        let first = publish(store, &ctx, &entry.note, &ability, None).await;
        rename("second-publication").await.unwrap();
        let current = publish(
            store,
            &ctx,
            &entry.note,
            &ability,
            Some(first.revision.clone()),
        )
        .await;
        // Both immutable packages retain their publication pins beyond these later revisions.
        disposition(store, &ctx, &entry.note, DeleteDisposition::Trash).await;
        disposition(store, &ctx, &entry.note, DeleteDisposition::Restore).await;
        let mut unavailable = Vec::new();
        for (slug, purge) in [("trashed-skill", false), ("purged-skill", true)] {
            let entry = skill(store, &ctx, slug).await;
            unavailable.push(
                publish(
                    store,
                    &ctx,
                    &entry.note,
                    &AbilityId::from_bytes(codec::ordered_id_16().unwrap()),
                    None,
                )
                .await,
            );
            disposition(store, &ctx, &entry.note, DeleteDisposition::Trash).await;
            if purge {
                disposition(store, &ctx, &entry.note, DeleteDisposition::Purge).await;
            }
        }
        Self {
            entrypoint: entry.note,
            original: entry.revision,
            first,
            current,
            unavailable,
        }
    }

    pub(super) fn invalid_pins(&self) -> [(RevisionId, RevisionId); 2] {
        [
            (
                self.current.revision.clone(),
                RevisionId::from_bytes([0x95; 16]),
            ),
            (self.first.revision.clone(), self.original.clone()),
        ]
    }

    pub(super) async fn check(
        &self,
        store: &CanonicalStore,
        scope: &HistoryScope,
        owner: &PrincipalId,
    ) {
        let account = AccountContext::new(auth(scope, owner).auth().clone(), budget());
        for reference in [&self.first, &self.current] {
            let exact = store
                .ability(account.clone(), reference.clone())
                .await
                .unwrap();
            assert_eq!(&exact.reference, reference);
            assert_eq!(exact.entrypoint.note_id, self.entrypoint);
        }
        let current = store
            .current_ability(account.clone(), self.current.identity())
            .await
            .unwrap();
        assert_eq!(current.reference, self.current);
        for reference in &self.unavailable {
            let result = store
                .current_ability(account.clone(), reference.identity())
                .await;
            assert!(matches!(
                result,
                Err(notarium_core::error::PortError::Domain(
                    notarium_core::DomainError::ResourceNotFound
                ))
            ));
        }
    }
}

fn replace_pin(bytes: &[u8], replacement: RevisionId) -> Vec<u8> {
    let mut envelope = codec::RevisionMetadataEnvelope::decode(bytes).unwrap();
    let codec::RevisionMetadataPayload::Ability(ability) = &mut envelope.payload else {
        panic!("expected an ability manifest");
    };
    assert_ne!(ability.entrypoint_revision, replacement);
    ability.entrypoint_revision = replacement;
    envelope.encode().unwrap()
}

pub(super) async fn round_trip(
    store: &CanonicalStore,
    control: &ControlBackup,
    scope: &HistoryScope,
    owner: &PrincipalId,
    scratch: &Path,
    target: RestoreTarget,
) {
    use notarium_canonical::{backup::PostgresSpoolValue, build_pg_connect_options};
    use notarium_core::error::{PortError, ValidationReason};
    use sqlx::{Connection, PgConnection};

    let history = AbilityHistory::create(store, scope, owner).await;
    history.check(store, scope, owner).await;
    let (options, keyring) = match &target {
        RestoreTarget::Local {
            keyring: RestoreKeyring::External(path),
            ..
        } => (sqlite_backup_options(), path),
        RestoreTarget::Cloud(cloud) => (BackupOptions::default(), &cloud.external_keyring),
        _ => unreachable!("this fixture supplies the separately saved keyring"),
    };
    let path = scratch.join("ability-history.zip");
    run_backup(
        authority(ServicePurpose::Backup),
        store,
        control,
        &path,
        options.clone(),
    )
    .await
    .unwrap();
    run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Archive(open(&path)),
        keyring,
        options.clone(),
    )
    .await
    .unwrap();
    for (manifest, pin) in history.invalid_pins() {
        let invalid = match &target {
            RestoreTarget::Local { .. } => {
                change_sqlite_archive(&path, scratch, "canonical", |db| {
                    let bytes: Vec<u8> = db
                        .query_row(
                            "SELECT metadata_msgpack FROM revisions WHERE rev_id=?1",
                            [manifest.as_str()],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(
                        db.execute(
                            "UPDATE revisions SET metadata_msgpack=?1 WHERE rev_id=?2",
                            rusqlite::params![replace_pin(&bytes, pin), manifest.as_str()]
                        )
                        .unwrap(),
                        1
                    );
                })
            }
            RestoreTarget::Cloud(_) => {
                revision_integrity::change_postgres_revisions(&path, |rows| {
                    let row = rows.iter_mut().find(|row| matches!(&row[2], PostgresSpoolValue::Text(rev) if rev == manifest.as_str())).unwrap();
                    let PostgresSpoolValue::Bytes(bytes) = &mut row[11] else {
                        panic!("expected manifest bytes")
                    };
                    *bytes = replace_pin(bytes, pin);
                })
            }
        };
        let fsck = run_fsck(
            authority(ServicePurpose::Fsck),
            FsckInput::Archive(ArchiveInput::new(invalid.clone()).unwrap()),
            keyring,
            options.clone(),
        )
        .await;
        let restore = run_restore(
            authority(ServicePurpose::Restore),
            ArchiveInput::new(invalid).unwrap(),
            target.clone(),
            options.clone(),
        )
        .await;
        for error in [fsck.unwrap_err(), restore.unwrap_err()] {
            assert!(
                matches!(error, PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic })
                if diagnostic.reason == ValidationReason::InvalidArchive)
            );
        }
    }
    match &target {
        RestoreTarget::Local { root, .. } => assert!(!root.root().exists()),
        RestoreTarget::Cloud(cloud) => {
            let mut db = PgConnection::connect_with(&build_pg_connect_options(&cloud.database))
                .await
                .unwrap();
            let empty: bool = sqlx::query_scalar(
                "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace
                WHERE nspname IN ('notarium_restore','v1_canonical','v1_control'))",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert!(empty);
        }
    }
    let restored = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target.clone(),
        options,
    )
    .await
    .unwrap();
    let config = match target {
        RestoreTarget::Local { root, .. } => {
            CanonicalConfig::local_default(restored.installation, root)
        }
        RestoreTarget::Cloud(cloud) => {
            cloud_config(restored.installation, cloud.database, cloud.object_store)
        }
    };
    let (cold, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let rotated = &restored.histories[0].scope;
    assert_ne!(rotated.incarnation, scope.incarnation);
    history.check(&cold, rotated, owner).await;
    runtime.shutdown().await.unwrap();
}

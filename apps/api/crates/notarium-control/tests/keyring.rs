#[allow(dead_code)]
mod support;
use notarium_control::{
    keyring::{EnvelopeAddress, FreshLocalInitializer, Keyring, KeyringLocation},
    store::target::{SecretKeyringRow, TargetRecord, TargetTable, V1StorageEpochRow},
};
use notarium_core::{auth::SecretString, epoch::DataRoot, ids::*, ports::*};
use std::{fs, path::PathBuf, time::Duration};
use support::*;

fn native() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native")
}
fn vector() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/keyring/vectors.json")).unwrap()
}
fn row() -> SecretKeyringRow {
    let v = vector();
    SecretKeyringRow {
        key_id: v["keyId"].as_str().unwrap().into(),
        key_hash: v["keyHash"].as_str().unwrap().into(),
        generation: 1,
        state: "active".into(),
        canary: v["canaryEnvelope"].as_str().unwrap().into(),
        created_at: 0,
        retired_at: None,
    }
}
fn maintenance(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: budget(),
    }
}
fn epoch() -> TargetRecord {
    TargetRecord::V1StorageEpoch(V1StorageEpochRow {
        singleton: 1,
        epoch_version: 1,
        state: "migrating".into(),
        installation_id: InstallationId::from_bytes([1; 16]).to_string(),
        receipt_sha256: None,
        receipt_json: None,
    })
}
async fn seed(f: &mut Fixture) {
    f.observer.execute("DELETE FROM v1_storage_epoch").await;
    f.store
        .import_target_batch(
            maintenance(ServicePurpose::Restore),
            &[epoch(), TargetRecord::SecretKeyring(row())],
        )
        .await
        .unwrap();
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
}
async fn open(f: &Fixture) -> Keyring {
    Keyring::open(
        f.store.clone(),
        KeyringLocation::External(native()),
        budget(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn both_databases_verify_and_export_native_witnesses_without_caching_keys() {
    for pg in [false, true] {
        let mut f = Fixture::new(pg, "keyring_native").await;
        seed(&mut f).await;
        let keyring = open(&f).await;
        let address = EnvelopeAddress::credential(&CredentialId::from_bytes([1; 16]));
        let v = vector();
        assert_eq!(
            keyring
                .open_envelope(
                    budget(),
                    address.clone(),
                    v["credentialEnvelope"].as_str().unwrap()
                )
                .await
                .unwrap()
                .expose(),
            v["credentialPlaintext"].as_str().unwrap()
        );
        let sealed = keyring
            .seal(
                budget(),
                address.clone(),
                SecretString::new("live-secret".into()),
            )
            .await
            .unwrap();
        let again = keyring
            .seal(
                budget(),
                address.clone(),
                SecretString::new("live-secret".into()),
            )
            .await
            .unwrap();
        assert_ne!(
            sealed.encrypted, again.encrypted,
            "each encryption needs a fresh nonce"
        );
        assert_eq!(sealed.witness.hash, row().key_hash);
        assert_eq!(
            keyring
                .open_envelope(budget(), address.clone(), &sealed.encrypted)
                .await
                .unwrap()
                .expose(),
            "live-secret"
        );
        assert!(!format!("{sealed:?}").contains(&sealed.encrypted));
        let mut export = f
            .store
            .export_target(
                maintenance(ServicePurpose::Backup),
                BackupBudget {
                    deadline: Duration::from_secs(20),
                    retention: if pg {
                        BackupRetentionBudget::PostgresSnapshot {
                            max_age: Duration::from_secs(20),
                        }
                    } else {
                        BackupRetentionBudget::SqliteWal {
                            max_pinned_bytes: 16 * 1024 * 1024,
                        }
                    },
                    max_spool_bytes: 16 * 1024 * 1024,
                },
            )
            .await
            .unwrap();
        let page = export
            .page(TargetTable::SecretKeyring, None, 10)
            .await
            .unwrap();
        assert_eq!(page.records.len(), 1);
        let TargetRecord::SecretKeyring(exported) = &page.records[0] else {
            panic!("expected key witness");
        };
        assert_eq!(exported.key_hash, row().key_hash);
        assert_eq!(exported.canary, row().canary);
        let encoded = serde_json::to_string(&page.records).unwrap();
        assert!(!encoded.contains("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
        export.close().await.unwrap();
        f.observer.execute("UPDATE secret_keyring SET key_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'").await;
        assert!(
            keyring
                .open_envelope(budget(), address.clone(), &sealed.encrypted)
                .await
                .is_err()
        );
        assert!(keyring.inspect(budget()).await.is_err());
        assert!(
            Keyring::open(
                f.store.clone(),
                KeyringLocation::External(native()),
                budget()
            )
            .await
            .is_err()
        );
        f.observer.execute("DELETE FROM secret_keyring").await;
        assert!(
            keyring
                .seal(budget(), address, SecretString::new("secret".into()))
                .await
                .is_err()
        );
        if pg {
            let arbitrary = DataRoot::new(native().join("must-not-be-created"));
            assert!(
                FreshLocalInitializer::initialize(
                    f.store.clone(),
                    arbitrary.clone(),
                    empty(),
                    budget()
                )
                .await
                .is_err()
            );
            assert!(!arbitrary.root().exists());
        }
        f.close().await;
    }
}

#[tokio::test]
async fn fresh_local_is_generation_one_repeatable_and_never_regenerates_missing_state() {
    let mut f = Fixture::new(false, "keyring_fresh").await;
    f.observer.execute("DELETE FROM v1_storage_epoch").await;
    let root = DataRoot::new(f.root.clone().unwrap());
    let keyring =
        FreshLocalInitializer::initialize(f.store.clone(), root.clone(), empty(), budget())
            .await
            .unwrap();
    assert!(
        f.store.installation().await.unwrap().is_none(),
        "key initialization must not publish readiness"
    );
    let witness = keyring.inspect(budget()).await.unwrap().remove(0);
    assert_eq!(witness.generation, 1);
    let key_path = root.keyring().join(format!("keys/{}.json", witness.key));
    let key = fs::read(&key_path).unwrap();
    let pointer = fs::read(root.keyring().join("active.json")).unwrap();
    assert_eq!(key.last(), Some(&b'\n'));
    assert_eq!(pointer.last(), Some(&b'\n'));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(root.keyring()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let repeated =
        FreshLocalInitializer::initialize(f.store.clone(), root.clone(), empty(), budget())
            .await
            .unwrap();
    assert_eq!(
        repeated.inspect(budget()).await.unwrap(),
        vec![witness.clone()]
    );
    assert_eq!(fs::read(&key_path).unwrap(), key);
    assert_eq!(
        fs::read(root.keyring().join("active.json")).unwrap(),
        pointer
    );
    let address = EnvelopeAddress::credential(&CredentialId::from_bytes([5; 16]));
    let sealed = keyring
        .seal(
            budget(),
            address.clone(),
            SecretString::new("fresh-secret".into()),
        )
        .await
        .unwrap();
    assert_eq!(
        repeated
            .open_envelope(budget(), address.clone(), &sealed.encrypted)
            .await
            .unwrap()
            .expose(),
        "fresh-secret"
    );
    fs::remove_file(&key_path).unwrap();
    assert!(
        keyring
            .open_envelope(budget(), address, &sealed.encrypted)
            .await
            .is_err()
    );
    assert!(
        FreshLocalInitializer::initialize(f.store.clone(), root.clone(), empty(), budget())
            .await
            .is_err()
    );
    assert!(!key_path.exists());
    assert_eq!(
        fs::read(root.keyring().join("active.json")).unwrap(),
        pointer
    );
    assert_eq!(
        f.observer
            .count("SELECT count(*) FROM secret_keyring")
            .await,
        1
    );
    f.close().await;
}

#[tokio::test]
async fn fresh_local_rejects_partial_files_and_nonempty_database_before_generation() {
    for partial in [false, true] {
        let mut f = Fixture::new(false, "keyring_partial").await;
        f.observer.execute("DELETE FROM v1_storage_epoch").await;
        let root = DataRoot::new(f.root.clone().unwrap());
        if partial {
            fs::create_dir(root.keyring()).unwrap();
            fs::write(root.keyring().join("sentinel"), b"preserve").unwrap();
        } else {
            f.observer.execute("INSERT INTO oauth_clients(client_id,kind,redirect_uris,client_name,created_at) VALUES('existing','dcr','[]','existing',0)").await;
        }
        assert!(
            FreshLocalInitializer::initialize(f.store.clone(), root.clone(), empty(), budget())
                .await
                .is_err()
        );
        assert_eq!(
            f.observer
                .count("SELECT count(*) FROM secret_keyring")
                .await,
            0
        );
        assert_eq!(
            f.observer
                .count("SELECT count(*) FROM v1_storage_epoch")
                .await,
            0
        );
        if partial {
            assert_eq!(
                fs::read(root.keyring().join("sentinel")).unwrap(),
                b"preserve"
            );
            assert_eq!(fs::read_dir(root.keyring()).unwrap().count(), 1);
        } else {
            assert!(!root.keyring().exists());
        }
        f.close().await;
    }
}

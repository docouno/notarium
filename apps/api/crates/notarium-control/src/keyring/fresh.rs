//! Fresh-only file creation. Existing and interrupted keyrings are never repaired.
use super::{
    Keyring, KeyringLocation,
    crypto::{Material, file_hash},
};
use crate::{
    error::{database, invalid, unavailable},
    store::{
        Backend, ControlStore, Transaction,
        lease::OperationBudget,
        target::{SecretKeyringRow, TargetRecord, TargetTable, V1StorageEpochRow},
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, OpenOptions},
};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ports::{CallBudget, EmptyRootAuthorization},
};
use serde::Serialize;
use std::{
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

fn failed() -> PortError {
    unavailable(
        "control fresh keyring initialization",
        CommitEffect::Unknown,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyFile<'a> {
    format: &'static str,
    format_version: u32,
    key_id: &'a str,
    secret: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pointer<'a> {
    format: &'static str,
    format_version: u32,
    generation: u64,
    key_id: &'a str,
    key_hash: &'a str,
}
fn write_new(root: &Dir, name: &str, bytes: &[u8]) -> Result<(), PortError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = root.open_with(name, &options).map_err(|_| failed())?;
    file.write_all(bytes).map_err(|_| failed())?;
    file.sync_all().map_err(|_| failed())
}
fn sync_directory(root: &Dir) -> Result<(), PortError> {
    // A directory capability may be an O_PATH handle on Linux. Obtain an
    // ordinary read handle before fsync; O_PATH itself returns EBADF.
    root.open(".")
        .map_err(|_| failed())?
        .sync_all()
        .map_err(|_| failed())
}
fn create(root: &Path, budget: &OperationBudget) -> Result<SecretKeyringRow, PortError> {
    budget.check(CommitEffect::Unknown)?;
    let root = Dir::open_ambient_dir(root, ambient_authority()).map_err(|_| failed())?;
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Exclusive mkdir rejects existing files, directories and symlinks. There
    // is deliberately no cleanup, replacement, resume or regeneration path.
    root.create_dir_with("secret-keyring", &builder)
        .map_err(|_| failed())?;
    let keys_root = root.open_dir("secret-keyring").map_err(|_| failed())?;
    keys_root
        .create_dir_with("keys", &builder)
        .map_err(|_| failed())?;
    let keys = keys_root.open_dir("keys").map_err(|_| failed())?;
    let mut master = Zeroizing::new([0; 32]);
    getrandom::fill(&mut *master).map_err(|_| failed())?;
    let material = Material::derive(&master).map_err(|_| failed())?;
    let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(master.as_slice()));
    let mut bytes = Zeroizing::new(
        serde_json::to_vec(&KeyFile {
            format: "notarium-credential-key",
            format_version: 1,
            key_id: material.id.as_str(),
            secret: &secret,
        })
        .map_err(|_| failed())?,
    );
    bytes.push(b'\n');
    let hash = file_hash(&bytes);
    let mut pointer = serde_json::to_vec(&Pointer {
        format: "notarium-credential-key-pointer",
        format_version: 1,
        generation: 1,
        key_id: material.id.as_str(),
        key_hash: &hash,
    })
    .map_err(|_| failed())?;
    pointer.push(b'\n');
    budget.check(CommitEffect::Unknown)?;
    write_new(&keys, &format!("{}.json", material.id), &bytes)?;
    sync_directory(&keys)?;
    budget.check(CommitEffect::Unknown)?;
    write_new(&keys_root, "active.json", &pointer)?;
    sync_directory(&keys_root)?;
    sync_directory(&root)?;
    let created_at = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| failed())?
            .as_millis(),
    )
    .map_err(|_| failed())?;
    Ok(SecretKeyringRow {
        key_id: material.id.to_string(),
        key_hash: hash,
        generation: 1,
        state: "active".into(),
        canary: material.seal_canary().map_err(|_| failed())?,
        created_at,
        retired_at: None,
    })
}

/// Only the composition owner holding a verified EmptyRoot admission may use
/// this entry point. It accepts only the SQLite store's local default location.
/// The caller must publish the paired ready epoch separately. A crash between
/// file creation and SQL commit leaves a fail-closed partial root for recovery.
pub struct FreshLocalInitializer;
impl FreshLocalInitializer {
    pub async fn initialize(
        store: ControlStore,
        root: DataRoot,
        authorization: EmptyRootAuthorization,
        call: CallBudget,
    ) -> Result<Keyring, PortError> {
        if !matches!(&store.backend, Backend::Sqlite { path, .. } if *path == root.control()) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let request = call.request.clone();
        let budget = OperationBudget::new(call);
        budget.check(CommitEffect::NotCommitted)?;
        let io_admission = Keyring::new_admission();
        let permit =
            io_admission
                .clone()
                .try_acquire_owned()
                .map_err(|_| DomainError::RateLimited {
                    retry_after_ms: 100,
                    budget: BudgetKind::Concurrency,
                })?;
        let worker_store = store.clone();
        let worker_root = root.clone();
        let worker_budget = budget.clone();
        // The owner survives caller drop through real file completion and the
        // database commit/rollback ACK; admission cannot be recycled early.
        let worker = tokio::spawn(async move {
            let mut tx = worker_store.write(worker_budget.clone()).await?;
            let Transaction::Sqlite(connection) = tx.inner_mut() else {
                return Err(failed());
            };
            let epoch: Option<(i64, String)> = worker_budget.run(async {
                sqlx::query_as("SELECT epoch_version,installation_id FROM v1_storage_epoch WHERE singleton=1")
                    .fetch_optional(&mut **connection).await.map_err(database)
            }, CommitEffect::NotCommitted).await?;
            if let Some((version, installation)) = epoch {
                if version != 1 || installation != authorization.installation().as_str() {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                // Existing state gets only the ordinary, strictly read-only
                // reader below. Missing or corrupt files remain an error.
                tx.rollback().await?;
                return Ok(permit);
            }
            for table in TargetTable::ALL {
                worker_budget.check(CommitEffect::NotCommitted)?;
                // Identifiers come exclusively from the closed schema enum.
                let any: Option<i64> = worker_budget
                    .run(
                        async {
                            sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT 1 FROM ")
                                .push(table.name())
                                .push(" LIMIT 1")
                                .build_query_scalar()
                                .fetch_optional(&mut **connection)
                                .await
                                .map_err(database)
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if any.is_some() {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
            let file_budget = worker_budget.clone();
            let files = tokio::task::spawn_blocking(move || {
                let result = create(worker_root.root(), &file_budget);
                (result, permit)
            });
            // No timeout of this join: a timed-out caller leaves this bounded
            // owner waiting for the actual filesystem operation to finish.
            let (row, permit) = files.await.map_err(|_| failed())?;
            let row = row?;
            worker_budget.check(CommitEffect::Unknown)?;
            TargetRecord::from(V1StorageEpochRow {
                singleton: 1,
                epoch_version: 1,
                state: "migrating".into(),
                installation_id: authorization.installation().to_string(),
                receipt_sha256: None,
                receipt_json: None,
            })
            .insert(tx.inner_mut())
            .await?;
            TargetRecord::from(row).insert(tx.inner_mut()).await?;
            worker_budget.check(CommitEffect::Unknown)?;
            tx.commit().await?;
            Ok::<_, PortError>(permit)
        });
        let permit = budget
            .run(
                async { worker.await.map_err(|_| failed())? },
                CommitEffect::Unknown,
            )
            .await?;
        drop(permit);
        Keyring::open_with_admission(
            store,
            KeyringLocation::LocalDefault(root),
            budget.context(request),
            io_admission,
        )
        .await
        .map_err(|_| failed())
    }
}

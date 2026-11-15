use super::{
    EnvelopeAddress, Witness,
    crypto::{Envelope, Material, failure},
    reader,
};
use crate::{
    error::invalid,
    store::{
        Backend, ControlStore,
        lease::OperationBudget,
        statements::read_rows,
        target::{SecretKeyringRow, TargetRecord},
    },
};
use notarium_core::{
    DomainError,
    auth::SecretString,
    epoch::DataRoot,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ids::KeyId,
    ports::CallBudget,
};
use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, LazyLock},
};
use tokio::sync::Semaphore;

pub(super) static IO_ADMISSION: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(4)));

#[cfg(test)]
#[path = "facade_tests.rs"]
mod tests;

/// External locations are operator configuration. Cloud requires one explicitly.
pub enum KeyringLocation {
    LocalDefault(DataRoot),
    External(PathBuf),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyringWitness {
    pub key: KeyId,
    pub generation: u64,
    pub hash: String,
}
impl From<&Witness> for KeyringWitness {
    fn from(value: &Witness) -> Self {
        Self {
            key: value.key.clone(),
            generation: value.generation,
            hash: value.hash.clone(),
        }
    }
}
pub struct SealedValue {
    pub encrypted: String,
    pub witness: KeyringWitness,
}
impl fmt::Debug for SealedValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedValue")
            .field("witness", &self.witness)
            .finish_non_exhaustive()
    }
}

/// No key material is retained between calls. Existing state is read-only.
#[derive(Clone)]
pub struct Keyring {
    store: ControlStore,
    path: PathBuf,
}
impl Keyring {
    pub async fn open(
        store: ControlStore,
        location: KeyringLocation,
        budget: CallBudget,
    ) -> Result<Self, PortError> {
        let path = match (&store.backend, location) {
            (Backend::Sqlite { path, .. }, KeyringLocation::LocalDefault(root))
                if *path == root.control() =>
            {
                root.keyring()
            }
            (_, KeyringLocation::External(path)) => path,
            _ => return Err(invalid(ValidationReason::InvalidState)),
        };
        let keyring = Self { store, path };
        keyring.execute(budget, None, true, |_, _| Ok(())).await?;
        Ok(keyring)
    }
    async fn witnesses(&self, budget: &OperationBudget) -> Result<Vec<Witness>, PortError> {
        let rows = budget.run(async {
            read_rows!(&self.store.backend,SecretKeyringRow,fetch_all,
                "SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM secret_keyring WHERE retired_at IS NULL ORDER BY generation LIMIT 4097",
                "SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM v1_control.secret_keyring WHERE retired_at IS NULL ORDER BY generation LIMIT 4097";)
        }, CommitEffect::NotCommitted).await?;
        if rows.is_empty() || rows.len() > reader::MAX_KEYS {
            return Err(failure());
        }
        rows.into_iter()
            .map(|row| {
                TargetRecord::SecretKeyring(row.clone()).validate()?;
                if !matches!(row.state.as_str(), "active" | "readable")
                    || row.generation <= 0
                    || row.canary.len() > 1024
                {
                    return Err(failure());
                }
                Ok(Witness {
                    key: KeyId::parse(&row.key_id).map_err(|_| failure())?,
                    hash: row.key_hash,
                    generation: row.generation as u64,
                    active: row.state == "active",
                    canary: row.canary,
                })
            })
            .collect()
    }
    async fn execute<T: Send + 'static>(
        &self,
        call: CallBudget,
        requested: Option<KeyId>,
        all: bool,
        action: impl FnOnce(Material, &[Witness]) -> Result<T, PortError> + Send + 'static,
    ) -> Result<T, PortError> {
        let budget = OperationBudget::new(call);
        budget.check(CommitEffect::NotCommitted)?;
        let permit = IO_ADMISSION.clone().try_acquire_owned().map_err(|_| {
            PortError::Domain(DomainError::RateLimited {
                retry_after_ms: 100,
                budget: BudgetKind::Concurrency,
            })
        })?;
        let before = self.witnesses(&budget).await?;
        let rows = before.clone();
        let path = self.path.clone();
        let worker_budget = budget.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let result = (|| {
                worker_budget.check(CommitEffect::NotCommitted)?;
                let material = reader::load(&path, &rows, requested.as_ref(), all, &worker_budget)?;
                worker_budget.check(CommitEffect::NotCommitted)?;
                action(material, &rows)
            })();
            // Cancellation of the caller never detaches the admission credit
            // from actual blocking I/O. Keep it through the final DB recheck too.
            (result, permit)
        });
        let (result, _permit) = budget
            .run(
                async { worker.await.map_err(|_| failure()) },
                CommitEffect::NotCommitted,
            )
            .await?;
        let value = result?;
        if self.witnesses(&budget).await? != before {
            return Err(failure());
        }
        Ok(value)
    }
    pub async fn seal(
        &self,
        budget: CallBudget,
        address: EnvelopeAddress,
        value: SecretString,
    ) -> Result<SealedValue, PortError> {
        if value.expose().len() > super::crypto::MAX_PLAINTEXT {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        self.execute(budget, None, false, move |material, rows| {
            let row = rows
                .iter()
                .find(|row| row.key == material.id)
                .ok_or_else(failure)?;
            Ok(SealedValue {
                encrypted: material.seal(&address, value.expose())?,
                witness: row.into(),
            })
        })
        .await
    }
    pub async fn open_envelope(
        &self,
        budget: CallBudget,
        address: EnvelopeAddress,
        encrypted: &str,
    ) -> Result<SecretString, PortError> {
        let envelope = Envelope::parse(encrypted)?;
        self.execute(
            budget,
            Some(envelope.key.clone()),
            false,
            move |material, _| material.open(&address, &envelope),
        )
        .await
    }
    /// Validated key identity witnesses contain no file bytes or master secrets.
    pub async fn inspect(&self, budget: CallBudget) -> Result<Vec<KeyringWitness>, PortError> {
        self.execute(budget, None, true, |_, rows| {
            Ok(rows.iter().map(Into::into).collect())
        })
        .await
    }
}

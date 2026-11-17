use super::{
    EnvelopeAddress, Witness,
    crypto::{Envelope, Material, failure},
    reader,
};
use crate::{
    error::invalid,
    store::{
        Backend, ControlStore, Transaction,
        lease::OperationBudget,
        statements::{read_rows, rows},
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
use std::{fmt, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const MAX_IO_WORKERS: usize = 4;
const MAX_IO_QUEUE: usize = 64;
const IO_ADMISSION_WAIT: Duration = Duration::from_millis(50);

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
    active: bool,
    canary_hash: [u8; 32],
}
impl From<&Witness> for KeyringWitness {
    fn from(value: &Witness) -> Self {
        Self {
            key: value.key.clone(),
            generation: value.generation,
            hash: value.hash.clone(),
            active: value.active,
            canary_hash: crate::auth::token::digest(value.canary.as_bytes()),
        }
    }
}
impl KeyringWitness {
    pub(crate) fn matches(&self, row: &SecretKeyringRow) -> bool {
        row.retired_at.is_none()
            && row.key_id == self.key.as_str()
            && row.generation as u64 == self.generation
            && row.key_hash == self.hash
            && row.state == if self.active { "active" } else { "readable" }
            && crate::auth::token::digest(row.canary.as_bytes()) == self.canary_hash
    }

    pub(crate) fn backup_canary(&self) -> notarium_core::ports::KeyCanary {
        notarium_core::ports::KeyCanary {
            key: self.key.clone(),
            generation: self.generation,
            active: self.active,
            digest: notarium_core::ids::ContentDigest::from_bytes(self.canary_hash),
            readable: true,
        }
    }

    /// Persistence owners recheck the complete witness under their SQL commit
    /// authority, after filesystem work has finished outside the transaction.
    pub(crate) async fn verify(&self, tx: &mut Transaction) -> Result<(), PortError> {
        let row = rows!(tx, SecretKeyringRow, fetch_optional,
            "SELECT * FROM secret_keyring WHERE key_id=$1",
            "SELECT * FROM v1_control.secret_keyring WHERE key_id=$1 FOR SHARE";self.key.as_str())?
        .ok_or_else(failure)?;
        if !self.matches(&row) {
            return Err(failure());
        }
        Ok(())
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
    io_admission: Arc<Semaphore>,
    io_queue: Arc<Semaphore>,
}
impl Keyring {
    pub(super) fn new_admission() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(MAX_IO_WORKERS))
    }
    #[cfg(test)]
    pub(super) fn available_io_permits(&self) -> usize {
        self.io_admission.available_permits()
    }
    pub async fn open(
        store: ControlStore,
        location: KeyringLocation,
        budget: CallBudget,
    ) -> Result<Self, PortError> {
        Self::open_with_admission(store, location, budget, Self::new_admission()).await
    }
    pub(super) async fn open_with_admission(
        store: ControlStore,
        location: KeyringLocation,
        budget: CallBudget,
        io_admission: Arc<Semaphore>,
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
        let keyring = Self {
            store,
            path,
            io_admission,
            io_queue: Arc::new(Semaphore::new(MAX_IO_QUEUE)),
        };
        keyring
            .execute(budget, Vec::new(), true, |_, _| Ok(()))
            .await?;
        Ok(keyring)
    }
    async fn acquire_io_permit(
        &self,
        budget: &OperationBudget,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, PortError> {
        let _queue = self.io_queue.clone().try_acquire_owned().map_err(|_| {
            PortError::Domain(DomainError::RateLimited {
                retry_after_ms: 100,
                budget: BudgetKind::Concurrency,
            })
        })?;
        if let Ok(permit) = self.io_admission.clone().try_acquire_owned() {
            return Ok(permit);
        }
        let wait_for = budget.remaining_now().min(IO_ADMISSION_WAIT);
        tokio::select! {
            biased;
            () = budget.cancellation().cancelled() => Err(budget.check(CommitEffect::NotCommitted).expect_err("cancelled")),
            permit = self.io_admission.clone().acquire_owned() => permit.map_err(|_| failure()),
            () = tokio::time::sleep(wait_for) => {
                if budget.remaining_now() == Duration::ZERO {
                    Err(budget.check(CommitEffect::NotCommitted).expect_err("deadline"))
                } else {
                    Err(PortError::Domain(DomainError::RateLimited {
                        retry_after_ms: 100,
                        budget: BudgetKind::Concurrency,
                    }))
                }
            }
        }
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
                TargetRecord::from(row.clone()).validate()?;
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
        requested: Vec<KeyId>,
        all: bool,
        action: impl FnOnce(Vec<Material>, &[Witness]) -> Result<T, PortError> + Send + 'static,
    ) -> Result<T, PortError> {
        let budget = OperationBudget::new(call);
        budget.check(CommitEffect::NotCommitted)?;
        let permit = self.acquire_io_permit(&budget).await?;
        let before = self.witnesses(&budget).await?;
        let rows = before.clone();
        let path = self.path.clone();
        let worker_budget = budget.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let result = (|| {
                worker_budget.check(CommitEffect::NotCommitted)?;
                let materials = reader::load_many(&path, &rows, &requested, all, &worker_budget)?;
                worker_budget.check(CommitEffect::NotCommitted)?;
                action(materials, &rows)
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
        self.execute(budget, Vec::new(), false, move |materials, rows| {
            let active = rows.iter().find(|row| row.active).ok_or_else(failure)?;
            let material = materials
                .iter()
                .find(|item| item.id == active.key)
                .ok_or_else(failure)?;
            Ok(SealedValue {
                encrypted: material.seal(&address, value.expose())?,
                witness: active.into(),
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
        self.open_verified(budget, address, encrypted)
            .await
            .map(|(secret, _)| secret)
    }
    pub(crate) async fn open_verified(
        &self,
        budget: CallBudget,
        address: EnvelopeAddress,
        encrypted: &str,
    ) -> Result<(SecretString, KeyringWitness), PortError> {
        let mut opened = self
            .open_verified_many(budget, vec![(address, encrypted.to_owned())])
            .await?;
        opened.pop().ok_or_else(failure)
    }
    /// Opens a batch of envelopes in one DB witness read and one filesystem pass.
    pub(crate) async fn open_verified_many(
        &self,
        budget: CallBudget,
        items: Vec<(EnvelopeAddress, String)>,
    ) -> Result<Vec<(SecretString, KeyringWitness)>, PortError> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let mut parsed = Vec::with_capacity(items.len());
        let mut keys = Vec::new();
        for (address, encrypted) in items {
            let envelope = Envelope::parse(&encrypted)?;
            if !keys.contains(&envelope.key) {
                keys.push(envelope.key.clone());
            }
            parsed.push((address, envelope));
        }
        self.execute(budget, keys, false, move |materials, rows| {
            let mut out = Vec::with_capacity(parsed.len());
            for (address, envelope) in parsed {
                let material = materials
                    .iter()
                    .find(|item| item.id == envelope.key)
                    .ok_or_else(failure)?;
                let witness = rows
                    .iter()
                    .find(|row| row.key == material.id)
                    .ok_or_else(failure)?;
                out.push((material.open(&address, &envelope)?, witness.into()));
            }
            Ok(out)
        })
        .await
    }
    /// Validated key identity witnesses contain no file bytes or master secrets.
    pub async fn inspect(&self, budget: CallBudget) -> Result<Vec<KeyringWitness>, PortError> {
        self.execute(budget, Vec::new(), true, |_, rows| {
            Ok(rows.iter().map(Into::into).collect())
        })
        .await
    }
}

//! Control snapshots, bounded stable spools, and offline cursor rebinding.
mod artifacts;
mod postgres;
mod protocol;
mod session;
mod spool;
mod sqlite;
mod worker;
pub use spool::SpoolReader;

use crate::{
    error::{invalid, unavailable},
    keyring::Keyring,
    store::{
        Backend, ControlStore, lease::OperationBudget, statements::execute,
        target::TARGET_SCHEMA_VERSION,
    },
};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::{BudgetKind, CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::*,
    receipt::ChangeCursor,
};
use std::{
    collections::BTreeSet,
    fs::File,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
fn failure() -> PortError {
    unavailable("control backup operation", CommitEffect::NotCommitted)
}

/// Operator ceilings. Each coordinator request may lower these limits.
#[derive(Clone, Copy, Debug)]
pub struct BackupConfig {
    pub deadline: Duration,
    pub max_spool_bytes: u64,
    pub max_pinned_wal_bytes: u64,
    pub max_snapshot_age: Duration,
}
impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(300),
            max_spool_bytes: 10 * 1024 * 1024 * 1024,
            max_pinned_wal_bytes: 256 * 1024 * 1024,
            max_snapshot_age: Duration::from_secs(300),
        }
    }
}
#[derive(Clone, Debug)]
pub struct BackupMetrics {
    pub backup: BackupId,
    pub prepare: Duration,
    /// Conservative admission-to-drain interval, including existing writers.
    pub drain: Duration,
    /// Admission request through the actual writer-resume acknowledgement.
    pub pause: Duration,
    pub spool: Duration,
    pub bytes: u64,
}
#[derive(Clone)]
pub struct ControlBackup {
    store: ControlStore,
    keyring: Keyring,
    data: DataRoot,
    config: BackupConfig,
    metrics: Arc<Mutex<Option<BackupMetrics>>>,
    pub(crate) admission: Arc<Semaphore>,
    artifact_io: Arc<Semaphore>,
}
impl ControlBackup {
    pub fn new(
        store: ControlStore,
        keyring: Keyring,
        data: DataRoot,
        config: BackupConfig,
    ) -> Result<Self, PortError> {
        if matches!(&store.backend,Backend::Sqlite{path,..}if *path!=data.control())
            || config.deadline.is_zero()
            || config.max_spool_bytes == 0
            || config.max_pinned_wal_bytes == 0
            || config.max_snapshot_age.is_zero()
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(Self {
            store,
            keyring,
            data,
            config,
            metrics: Arc::new(Mutex::new(None)),
            admission: Arc::new(Semaphore::new(1)),
            artifact_io: Arc::new(Semaphore::new(4)),
        })
    }
    pub fn default_budget(&self) -> BackupBudget {
        BackupBudget {
            deadline: self.config.deadline,
            max_spool_bytes: self.config.max_spool_bytes,
            retention: match self.store.backend {
                Backend::Sqlite { .. } => BackupRetentionBudget::SqliteWal {
                    max_pinned_bytes: self.config.max_pinned_wal_bytes,
                },
                Backend::Postgres { .. } => BackupRetentionBudget::PostgresSnapshot {
                    max_age: self.config.max_snapshot_age,
                },
            },
        }
    }
    pub fn last_metrics(&self) -> Option<BackupMetrics> {
        self.metrics.lock().ok().and_then(|value| value.clone())
    }
    fn budget(&self, mut budget: BackupBudget) -> Result<BackupBudget, PortError> {
        budget.deadline = budget.deadline.min(self.config.deadline);
        budget.max_spool_bytes = budget.max_spool_bytes.min(self.config.max_spool_bytes);
        match (&self.store.backend, &mut budget.retention) {
            (Backend::Sqlite { .. }, BackupRetentionBudget::SqliteWal { max_pinned_bytes }) => {
                *max_pinned_bytes = (*max_pinned_bytes).min(self.config.max_pinned_wal_bytes)
            }
            (Backend::Postgres { .. }, BackupRetentionBudget::PostgresSnapshot { max_age }) => {
                *max_age = (*max_age).min(self.config.max_snapshot_age)
            }
            _ => return Err(invalid(ValidationReason::ScopeMismatch)),
        }
        Ok(budget)
    }
    /// Resolve only a participant-owned immutable artifact and verify its complete
    /// file digest. Packaging and upload consume this file without a database cut.
    pub async fn open_artifact(
        &self,
        ctx: MaintenanceContext,
        artifact: ArtifactId,
    ) -> Result<(BackupSpool, File), PortError> {
        ctx.authority.require(ServicePurpose::Backup)?;
        let operation = OperationBudget::new(ctx.budget);
        operation.check(CommitEffect::NotCommitted)?;
        let permit =
            self.artifact_io
                .clone()
                .try_acquire_owned()
                .map_err(|_| DomainError::RateLimited {
                    retry_after_ms: 1000,
                    budget: BudgetKind::Concurrency,
                })?;
        let data = self.data.clone();
        let budget = operation.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            artifacts::open_completed(&data, &artifact, || {
                budget.check(CommitEffect::NotCommitted)
            })
        });
        operation
            .run(
                async { worker.await.map_err(|_| failure())? },
                CommitEffect::NotCommitted,
            )
            .await
    }
}
struct Preparing {
    session: Arc<session::Session>,
    complete: bool,
}
impl Drop for Preparing {
    fn drop(&mut self) {
        if !self.complete {
            self.session.cancel();
        }
    }
}
impl BackupParticipantPort for ControlBackup {
    fn prepare(
        &self,
        ctx: MaintenanceContext,
        backup: BackupId,
        budget: BackupBudget,
    ) -> PortFuture<'_, Box<dyn PreparedBackup>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Backup)?;
            let budget = self.budget(budget)?;
            let slot = self.admission.clone().try_acquire_owned().map_err(|_| {
                DomainError::RateLimited {
                    retry_after_ms: 1000,
                    budget: BudgetKind::Concurrency,
                }
            })?;
            let wal = match &self.store.backend {
                Backend::Sqlite { path, .. } => {
                    Some(PathBuf::from(format!("{}-wal", path.display())))
                }
                Backend::Postgres { .. } => None,
            };
            let session = session::Session::new(ctx.budget.clone(), budget, wal);
            let mut guard = Preparing {
                session: session.clone(),
                complete: false,
            };
            session.check()?;
            // Inspect/decrypt key canaries before pausing writers. Only validated metadata
            // crosses into the worker; the pinned cut must match this complete key set.
            let mut key_budget = ctx.budget.clone();
            key_budget.remaining = session.remaining();
            let keys = session
                .operation
                .run(self.keyring.inspect(key_budget), CommitEffect::NotCommitted)
                .await?;
            session.check()?;
            // The worker watchdog has not started yet. Observe the caller's
            // cancellation directly while reading the installation witness.
            let mut preparation_budget = ctx.budget;
            preparation_budget.remaining = session.remaining();
            let installation = OperationBudget::new(preparation_budget)
                .run(self.store.installation(), CommitEffect::NotCommitted)
                .await?
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let witness = BackupWitness {
                installation,
                schema_version: TARGET_SCHEMA_VERSION,
                histories: Vec::new(),
                canaries: keys.iter().map(KeyringWitness::backup_canary).collect(),
            };
            let client = worker::launch(worker::Start {
                store: self.store.clone(),
                data: self.data.clone(),
                backup,
                keys,
                witness: witness.clone(),
                session,
                slot,
                metrics: self.metrics.clone(),
            })
            .await?;
            guard.complete = true;
            Ok(Box::new(protocol::Prepared {
                client,
                witness,
                owns: true,
                hold_acquired: false,
            }) as Box<dyn PreparedBackup>)
        })
    }
    fn restore_cursors(
        &self,
        ctx: MaintenanceContext,
        restored: Vec<ChangeCursor>,
    ) -> PortFuture<'_, ()> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Restore)?;
            let budget = OperationBudget::new(ctx.budget);
            let mut spaces = BTreeSet::new();
            for cursor in &restored {
                budget.check(CommitEffect::NotCommitted)?;
                if !spaces.insert(&cursor.scope.space_id) {
                    return Err(invalid(ValidationReason::DuplicateKey));
                }
            }
            let now = i64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| failure())?
                    .as_millis(),
            )
            .map_err(|_| failure())?;
            let mut transaction = self.store.write(budget.clone()).await?;
            budget.run(async{
   for cursor in restored {
    budget.check(CommitEffect::NotCommitted)?;
    let ceiling=i64::try_from(cursor.after.get()).map_err(|_|invalid(ValidationReason::InvalidLimit))?;
    let history=cursor.scope.incarnation.as_bytes().as_slice();let space=cursor.scope.space_id.as_str();
    execute!(transaction.inner_mut(),"UPDATE mcp_delta_owner_cursors SET acked_space_seq=MIN(acked_space_seq,$1),history_incarnation=$2,updated_at=$3 WHERE space_id=$4","UPDATE v1_control.mcp_delta_owner_cursors SET acked_space_seq=LEAST(acked_space_seq,$1),history_incarnation=$2,updated_at=$3 WHERE space_id=$4";ceiling,history,now,space)?;
    execute!(transaction.inner_mut(),"UPDATE mcp_delta_session_cursors SET acked_space_seq=MIN(acked_space_seq,$1),history_incarnation=$2,updated_at=$3 WHERE space_id=$4","UPDATE v1_control.mcp_delta_session_cursors SET acked_space_seq=LEAST(acked_space_seq,$1),history_incarnation=$2,updated_at=$3 WHERE space_id=$4";ceiling,history,now,space)?;
   }
   Ok(())
  },CommitEffect::NotCommitted).await?;
            budget
                .run(transaction.commit(), CommitEffect::Unknown)
                .await
        })
    }
}
use crate::keyring::KeyringWitness;
use std::path::PathBuf;

#[cfg(test)]
mod latency_tests;
#[cfg(test)]
mod tests;

use super::{
    Backend, ControlStore, Transaction, encoded_size,
    lease::{LeasedTransaction, OperationBudget, TransactionLease},
    target,
};
use crate::error::{database, invalid, unavailable};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ports::{
        BackupBudget, BackupProgress, BackupRetentionProgress, MaintenanceContext, ServicePurpose,
    },
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// A single-store read cut. A watchdog releases the transaction on cancellation,
/// expiry or retention overflow, even if the consumer never requests another page.
pub struct TargetExport {
    lease: TransactionLease,
    exported_bytes: Arc<AtomicU64>,
}
impl ControlStore {
    /// A paired disaster-recovery cut still requires a coordinator to pause both
    /// participants. Only one live target export is admitted per store owner.
    pub async fn export_target(
        &self,
        mut ctx: MaintenanceContext,
        mut budget: BackupBudget,
    ) -> Result<TargetExport, PortError> {
        ctx.authority.require(ServicePurpose::Backup)?;
        budget.deadline = budget.deadline.min(ctx.budget.remaining);
        ctx.budget.remaining = budget.deadline;
        let operation = OperationBudget::new(ctx.budget);
        operation.check(CommitEffect::NotCommitted)?;
        let slot = self
            .exports
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid(ValidationReason::BudgetExceeded))?;
        let (mut tx, wal) = operation
            .run(
                async {
                    match &self.backend {
                        Backend::Sqlite { pool, path } => Ok((
                            Transaction::Sqlite(pool.begin().await.map_err(database)?),
                            Some(PathBuf::from(format!("{}-wal", path.display()))),
                        )),
                        Backend::Postgres(pool) => Ok((
                            Transaction::Postgres(
                                pool.begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                                    .await
                                    .map_err(database)?,
                            ),
                            None,
                        )),
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let pinned = Instant::now();
        let epoch=operation.run(async {
            operation.configure(&mut tx).await?;
            match &mut tx {
                Transaction::Sqlite(tx)=>sqlx::query_as::<_,(i64,String)>("SELECT epoch_version,state FROM v1_storage_epoch WHERE singleton=1").fetch_optional(&mut **tx).await.map_err(database),
                Transaction::Postgres(tx)=>sqlx::query_as::<_,(i64,String)>("SELECT epoch_version,state FROM v1_control.v1_storage_epoch WHERE singleton=1").fetch_optional(&mut **tx).await.map_err(database),
            }
        },CommitEffect::NotCommitted).await?;
        if epoch != Some((1, "ready".into())) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let exported_bytes = Arc::new(AtomicU64::new(0));
        let bytes = exported_bytes.clone();
        let started = operation.started;
        let retention = Arc::new(move || {
            let retention = if let Some(wal) = &wal {
                BackupRetentionProgress::SqliteWal {
                    pinned_bytes: std::fs::metadata(wal)
                        .map_err(|_| unavailable("control export WAL", CommitEffect::NotCommitted))?
                        .len(),
                }
            } else {
                BackupRetentionProgress::PostgresSnapshot {
                    age: pinned.elapsed(),
                }
            };
            budget.check(BackupProgress {
                elapsed: started.elapsed(),
                retention,
                spool_bytes: bytes.load(Ordering::SeqCst),
            })?;
            Ok(())
        });
        retention()?;
        operation.check(CommitEffect::NotCommitted)?;
        Ok(TargetExport {
            lease: TransactionLease::new(
                LeasedTransaction::Read(tx),
                operation,
                retention,
                Some(slot),
            ),
            exported_bytes,
        })
    }
}
impl TargetExport {
    pub async fn page(
        &mut self,
        table: target::TargetTable,
        after: Option<target::TargetPosition>,
        limit: u16,
    ) -> Result<target::TargetPage, PortError> {
        let operation = self.lease.operation();
        let result = self
            .lease
            .budget
            .run(
                async {
                    let mut state = self.lease.state.lock().await;
                    self.lease.check()?;
                    let tx = state
                        .as_mut()
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?
                        .inner();
                    let page = target::read_page(tx, table, after, limit).await?;
                    let bytes = page.records.iter().try_fold(0u64, |total, record| {
                        encoded_size(record).map(|size| total.saturating_add(size as u64))
                    })?;
                    self.exported_bytes
                        .try_update(Ordering::SeqCst, Ordering::SeqCst, |total| {
                            Some(total.saturating_add(bytes))
                        })
                        .expect("always updates");
                    self.lease.check()?;
                    Ok(page)
                },
                CommitEffect::NotCommitted,
            )
            .await;
        if result.is_err() {
            self.lease.close().await?;
        } else {
            operation.complete();
        }
        result
    }
    pub async fn close(mut self) -> Result<(), PortError> {
        self.lease.close().await
    }
}

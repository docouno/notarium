use super::{
    ControlStore, EXPORT_PAGE_BYTES, Transaction, encoded_size,
    lease::{LeasedTransaction, OperationBudget, TransactionLease},
    target::TargetRecord,
};
use crate::error::{database, invalid, unavailable};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::InstallationId,
    ports::{MaintenanceContext, ServicePurpose},
};
use std::sync::Arc;

/// An offline import transaction. Append bounded pages, then finish once all
/// referenced rows are present. Dropping or abandoning it aborts the whole cut.
pub struct TargetImport {
    lease: TransactionLease,
    has_epoch: bool,
}
impl ControlStore {
    pub async fn begin_target_import(
        &self,
        ctx: MaintenanceContext,
    ) -> Result<TargetImport, PortError> {
        ctx.authority.require(ServicePurpose::Restore)?;
        let budget = OperationBudget::new(ctx.budget);
        let mut tx = self.write(budget.clone()).await?;
        let epoch = budget
            .run(
                async {
                    budget.configure(tx.inner_mut()).await?;
                    match tx.inner_mut() {
                        Transaction::Sqlite(tx) => sqlx::query_as::<_, (i64, String)>(
                            "SELECT epoch_version,state FROM v1_storage_epoch WHERE singleton=1",
                        )
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(database),
                        Transaction::Postgres(tx) => sqlx::query_as::<_, (i64, String)>(
                            "SELECT epoch_version,state FROM v1_control.v1_storage_epoch WHERE singleton=1 FOR UPDATE",
                        )
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(database),
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        if epoch
            .as_ref()
            .is_some_and(|(version, state)| *version != 1 || state != "migrating")
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        budget.check(CommitEffect::NotCommitted)?;
        Ok(TargetImport {
            has_epoch: epoch.is_some(),
            lease: TransactionLease::new(
                LeasedTransaction::Write(tx),
                budget,
                Arc::new(|| Ok(())),
                None,
                None,
            ),
        })
    }
    /// Convenience for a complete cut fitting in one page. Cross-page foreign
    /// keys require begin_target_import/append/finish around all pages.
    pub async fn import_target_batch(
        &self,
        ctx: MaintenanceContext,
        records: &[TargetRecord],
    ) -> Result<(), PortError> {
        let mut import = self.begin_target_import(ctx).await?;
        import.append(records).await?;
        import.finish().await
    }
}
impl TargetImport {
    pub async fn append(&mut self, records: &[TargetRecord]) -> Result<(), PortError> {
        let operation = self.lease.operation();
        let result = self
            .lease
            .budget
            .run(
                async {
                    self.lease.check()?;
                    if records.is_empty() || records.len() > 200 {
                        return Err(invalid(ValidationReason::InvalidLimit));
                    }
                    let mut bytes = 0usize;
                    for record in records {
                        record.validate()?;
                        bytes = bytes.saturating_add(encoded_size(record)?);
                        if bytes > EXPORT_PAGE_BYTES {
                            return Err(invalid(ValidationReason::InvalidLimit));
                        }
                        if let TargetRecord::V1StorageEpoch {
                            epoch_version,
                            state,
                            installation_id,
                            ..
                        } = record
                        {
                            if *epoch_version != 1 || state != "migrating" {
                                return Err(invalid(ValidationReason::InvalidState));
                            }
                            InstallationId::parse(installation_id)?;
                        }
                    }
                    if !self.has_epoch
                        && !matches!(records.first(), Some(TargetRecord::V1StorageEpoch { .. }))
                    {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    let mut state = self.lease.state.lock().await;
                    self.lease.check()?;
                    let tx = state
                        .as_mut()
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?
                        .inner();
                    for record in records {
                        self.lease.check()?;
                        if let TargetRecord::AgentSchedules {
                            title,
                            init_prompt,
                            deleted_at: Some(_),
                            ..
                        } = record
                            && (!title.is_empty() || !init_prompt.is_empty())
                        {
                            let mut sanitized = record.clone();
                            if let TargetRecord::AgentSchedules {
                                title, init_prompt, ..
                            } = &mut sanitized
                            {
                                title.clear();
                                init_prompt.clear();
                            }
                            sanitized.insert(tx).await?;
                        } else {
                            record.insert(tx).await?;
                        }
                    }
                    self.lease.check()
                },
                CommitEffect::NotCommitted,
            )
            .await;
        if result.is_err() {
            self.lease.close().await?;
        } else {
            self.has_epoch = true;
            operation.complete();
        }
        result
    }
    pub async fn finish(mut self) -> Result<(), PortError> {
        let result = self
            .lease
            .budget
            .run(
                async {
                    let mut state = self.lease.state.lock().await;
                    self.lease.check()?;
                    if !self.has_epoch {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    let Some(LeasedTransaction::Write(tx)) = state.take() else {
                        return Err(invalid(ValidationReason::InvalidState));
                    };
                    // Spawn before yielding: cancellation from this point is an unknown
                    // commit outcome, and the transaction keeps its writer fence.
                    let commit = tokio::spawn(async move { tx.commit().await });
                    drop(state);
                    commit
                        .await
                        .map_err(|_| unavailable("control import commit", CommitEffect::Unknown))?
                },
                CommitEffect::Unknown,
            )
            .await;
        self.lease.close().await?;
        result
    }
}

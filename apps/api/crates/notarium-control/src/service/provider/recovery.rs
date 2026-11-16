use super::{
    ProviderService, accounting,
    records::{json, parse},
};
use crate::{
    error::invalid,
    store::{lease::OperationBudget, statements::page_rows, target::*},
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::ControlPageRequest, *},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    installation: InstallationId,
    before: i64,
    created: i64,
    id: String,
}
impl ProviderService {
    /// Startup/maintenance composition drains these bounded pages. A database
    /// age alone never proves another process dead: the registry must atomically
    /// fence an inactive call, and any live registration makes this pass skip it.
    pub async fn recover_calls(
        &self,
        ctx: MaintenanceContext,
        page: ControlPageRequest,
    ) -> Result<ProviderRecoveryPage, PortError> {
        ctx.authority.require(ServicePurpose::ProviderRecovery)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let now = self.control.clock.now_ms()?;
        let before = now.saturating_sub(300_000);
        let mut cursor = if let Some(value) = page.continuation() {
            let cursor: Cursor = parse(value)?;
            if cursor.version != 1
                || cursor.installation != self.control.installation
                || cursor.before > before
                || cursor.before < 0
                || cursor.created < 0
                || cursor.id.len() > 128
            {
                return Err(invalid(ValidationReason::CursorStale));
            }
            RequestId::parse(&cursor.id)?;
            cursor
        } else {
            Cursor {
                version: 1,
                installation: self.control.installation.clone(),
                before,
                created: -1,
                id: String::new(),
            }
        };
        let mut read = self.control.store.read(budget.clone()).await?;
        let candidates=budget.run(async {page_rows!(read.inner_mut(),ProviderCallLogRow,TargetTable::ProviderCallLog,page.limit(),
            "SELECT * FROM provider_call_log WHERE delivery_state IN ('intent','sending') AND created_at<=$1 AND (created_at,call_id)>($2,$3) ORDER BY created_at,call_id LIMIT $4",
            "SELECT * FROM v1_control.provider_call_log WHERE delivery_state IN ('intent','sending') AND created_at<=$1 AND (created_at,call_id)>($2,$3) ORDER BY created_at,call_id LIMIT $4";cursor.before,cursor.created,&cursor.id,i64::from(page.limit())+1)},CommitEffect::NotCommitted).await?;
        budget
            .run(read.rollback(), CommitEffect::NotCommitted)
            .await?;
        let mut settled = 0;
        let inspected = candidates.rows.len() as u16;
        for observed in candidates.rows {
            cursor.created = observed.created_at;
            cursor.id = observed.call_id.clone();
            let id = RequestId::parse(&observed.call_id)?;
            let mut tx = self.control.store.write(budget.clone()).await?;
            let row = budget
                .run(
                    accounting::call(tx.inner_mut(), &id),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if row.delivery_state == "settled" || row.created_at > cursor.before {
                budget
                    .run(tx.rollback(), CommitEffect::NotCommitted)
                    .await?;
                continue;
            }
            let fence = budget
                .run(
                    self.control.revoker.fence_inactive_provider(
                        MaintenanceContext {
                            authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                            budget: budget.context(id.clone()),
                        },
                        id,
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            let Some(fence) = fence else {
                budget
                    .run(tx.rollback(), CommitEffect::NotCommitted)
                    .await?;
                continue;
            };
            fence.check()?;
            tx.hold_revocation_fence(fence);
            budget
                .run(
                    accounting::settle(
                        tx.inner_mut(),
                        row,
                        ProviderUsage::Unknown,
                        ProviderOutcome::Unknown,
                        None,
                        now,
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget.run(tx.commit(), CommitEffect::Unknown).await?;
            settled += 1;
        }
        let continuation = if candidates.has_more {
            Some(json(&cursor)?)
        } else {
            None
        };
        Ok(ProviderRecoveryPage {
            inspected,
            settled,
            continuation,
        })
    }
}

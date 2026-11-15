use super::ControlService;
use crate::{
    auth::token::random,
    error::{invalid, unavailable},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::{RevocationEventsRow, TargetRecord},
    },
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::RequestId,
    ports::*,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectorEnvelope {
    version: u8,
    selector: RevocationSelector,
}
pub(super) async fn pending(
    tx: &mut Transaction,
    selector: RevocationSelector,
) -> Result<Vec<RequestId>, PortError> {
    let selector = serde_json::to_string(&SelectorEnvelope {
        version: 1,
        selector,
    })
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let events = rows!(tx,(String,),fetch_all,
        "SELECT event_id FROM revocation_events WHERE selector=$1 AND delivered_at IS NULL ORDER BY event_id LIMIT 201",
        "SELECT event_id FROM v1_control.revocation_events WHERE selector=$1 AND delivered_at IS NULL ORDER BY event_id LIMIT 201";&selector)?;
    if events.len() > 200 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    events
        .into_iter()
        .map(|(id,)| RequestId::parse(&id).map_err(Into::into))
        .collect()
}
pub(super) async fn enqueue(
    tx: &mut Transaction,
    selector: RevocationSelector,
    reason: RevocationReason,
    version: i64,
    now: i64,
) -> Result<RequestId, PortError> {
    let id = RequestId::from_bytes(random()?);
    enqueue_at(tx, id, selector, reason, version, now).await
}
pub(super) async fn enqueue_at(
    tx: &mut Transaction,
    id: RequestId,
    selector: RevocationSelector,
    reason: RevocationReason,
    version: i64,
    now: i64,
) -> Result<RequestId, PortError> {
    let selector = serde_json::to_string(&SelectorEnvelope {
        version: 1,
        selector,
    })
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let reason = match reason {
        RevocationReason::Logout => "logout",
        RevocationReason::Expired => "expired",
        RevocationReason::PermissionChanged => "permission_changed",
        RevocationReason::SpaceClosed => "space_closed",
        RevocationReason::CredentialRemoved => "credential_removed",
    };
    let record = TargetRecord::RevocationEvents(RevocationEventsRow {
        event_id: id.to_string(),
        selector,
        reason: reason.into(),
        authority_version: version,
        committed_at: now,
        delivered_at: None,
        attempts: 0,
    });
    record.validate()?;
    record.insert(tx).await?;
    Ok(id)
}
impl ControlService {
    pub(super) async fn flush_event(
        &self,
        budget: &OperationBudget,
        id: &RequestId,
    ) -> Result<(), PortError> {
        let result=async {
            let event=budget.run(async {read_rows!(&self.store.backend,RevocationEventsRow,fetch_one,
                "SELECT * FROM revocation_events WHERE event_id=$1","SELECT * FROM v1_control.revocation_events WHERE event_id=$1";id.as_str())
            },CommitEffect::Unknown).await?;
            if event.delivered_at.is_none() {self.deliver_revocation(budget,event).await?;}
            Ok(())
        }.await;
        result.map_err(|_: PortError| {
            unavailable(
                "control committed revocation pending",
                CommitEffect::Unknown,
            )
        })
    }
    pub async fn drain_revocations(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> Result<RevocationDrain, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        if !(1..=200).contains(&limit) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let budget = OperationBudget::new(ctx.budget);
        let rows=budget.run(async {read_rows!(&self.store.backend,RevocationEventsRow,fetch_all,
            "SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM revocation_events WHERE delivered_at IS NULL ORDER BY committed_at,event_id LIMIT $1",
            "SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM v1_control.revocation_events WHERE delivered_at IS NULL ORDER BY committed_at,event_id LIMIT $1"; i64::from(limit)+1)
        },CommitEffect::NotCommitted).await?;
        let has_more = rows.len() > usize::from(limit);
        let mut delivered = 0;
        for event in rows.into_iter().take(usize::from(limit)) {
            self.deliver_revocation(&budget, event).await?;
            delivered += 1;
        }
        Ok(RevocationDrain {
            delivered,
            has_more,
        })
    }
    async fn deliver_revocation(
        &self,
        budget: &OperationBudget,
        event: RevocationEventsRow,
    ) -> Result<(), PortError> {
        let request = RequestId::parse(&event.event_id)?;
        let envelope: SelectorEnvelope = serde_json::from_str(&event.selector)
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        if envelope.version != 1 {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let reason: RevocationReason =
            serde_json::from_value(serde_json::Value::String(event.reason))
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
        let mut tx = self.store.write(budget.clone()).await?;
        let changed=budget.run(async {execute!(tx.inner_mut(),
            "UPDATE revocation_events SET attempts=attempts+1 WHERE event_id=$1 AND delivered_at IS NULL",
            "UPDATE v1_control.revocation_events SET attempts=attempts+1 WHERE event_id=$1 AND delivered_at IS NULL"; &event.event_id)
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        if changed == 0 {
            return Ok(());
        }
        budget
            .run(
                self.revoker.revoke(
                    MaintenanceContext {
                        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                        budget: budget.context(request),
                    },
                    envelope.selector,
                    reason,
                ),
                CommitEffect::Unknown,
            )
            .await
            .map_err(|_| unavailable("control revocation delivery", CommitEffect::Unknown))?;
        let mut tx = self.store.write(budget.clone()).await?;
        let now = self.clock.now_ms()?;
        budget.run(async {execute!(tx.inner_mut(),
            "UPDATE revocation_events SET delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL",
            "UPDATE v1_control.revocation_events SET delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL"; now,&event.event_id)
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
}

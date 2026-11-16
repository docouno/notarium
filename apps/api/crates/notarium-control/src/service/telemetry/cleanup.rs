use super::*;
impl ControlService {
    pub async fn cleanup_telemetry(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> Result<TelemetryCleanup, PortError> {
        ctx.authority.require(ServicePurpose::Telemetry)?;
        if !(1..=200).contains(&limit) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let budget = OperationBudget::new(ctx.budget);
        let mut tx = self.store.write(budget.clone()).await?;
        let result=budget.run(async{
            let config=configuration(tx.inner_mut(),false).await?;let now=self.clock.now_ms()?;
            let compact=now.checked_sub(config.compact_retention_days*DAY).ok_or_else(||invalid(ValidationReason::InvalidTimestamp))?;
            let detailed=now.checked_sub(config.detailed_retention_days*DAY).ok_or_else(||invalid(ValidationReason::InvalidTimestamp))?;
            let mut remaining=i64::from(limit);let mut result=TelemetryCleanup{details:0,retrievals:0,calls:0,commands:0,has_more:false};
            let rows=rows!(tx.inner_mut(),(String,),fetch_all,
                "SELECT d.call_id FROM agent_call_details d JOIN agent_calls c ON c.call_id=d.call_id WHERE (d.expires_at<=$1 OR d.created_at<=$2) AND c.finished_at IS NOT NULL ORDER BY d.expires_at,d.call_id LIMIT $3",
                "SELECT d.call_id FROM v1_control.agent_call_details d JOIN v1_control.agent_calls c ON c.call_id=d.call_id WHERE (d.expires_at<=$1 OR d.created_at<=$2) AND c.finished_at IS NOT NULL ORDER BY d.expires_at,d.call_id LIMIT $3 FOR UPDATE OF d";now,detailed,remaining)?;
            for (id,) in rows{execute!(tx.inner_mut(),"DELETE FROM agent_call_details WHERE call_id=$1","DELETE FROM v1_control.agent_call_details WHERE call_id=$1";id)?;result.details+=1;remaining-=1;}
            let rows=rows!(tx.inner_mut(),(String,),fetch_all,
                "SELECT r.retrieval_id FROM agent_retrievals r WHERE r.created_at<=$1 AND (r.call_id IS NULL OR EXISTS(SELECT 1 FROM agent_calls c WHERE c.call_id=r.call_id AND c.finished_at IS NOT NULL)) ORDER BY r.created_at,r.retrieval_id LIMIT $2",
                "SELECT r.retrieval_id FROM v1_control.agent_retrievals r WHERE r.created_at<=$1 AND (r.call_id IS NULL OR EXISTS(SELECT 1 FROM v1_control.agent_calls c WHERE c.call_id=r.call_id AND c.finished_at IS NOT NULL)) ORDER BY r.created_at,r.retrieval_id LIMIT $2 FOR UPDATE OF r";compact,remaining)?;
            for (id,) in rows{execute!(tx.inner_mut(),"DELETE FROM agent_retrievals WHERE retrieval_id=$1","DELETE FROM v1_control.agent_retrievals WHERE retrieval_id=$1";id)?;result.retrievals+=1;remaining-=1;}
            let rows=rows!(tx.inner_mut(),(String,),fetch_all,
                "SELECT c.call_id FROM agent_calls c WHERE c.finished_at<=$1 AND NOT EXISTS(SELECT 1 FROM agent_retrievals r WHERE r.call_id=c.call_id) AND NOT EXISTS(SELECT 1 FROM agent_call_details d WHERE d.call_id=c.call_id) ORDER BY c.finished_at,c.call_id LIMIT $2",
                "SELECT c.call_id FROM v1_control.agent_calls c WHERE c.finished_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.agent_retrievals r WHERE r.call_id=c.call_id) AND NOT EXISTS(SELECT 1 FROM v1_control.agent_call_details d WHERE d.call_id=c.call_id) ORDER BY c.finished_at,c.call_id LIMIT $2 FOR UPDATE OF c";compact,remaining)?;
            for (id,) in rows{execute!(tx.inner_mut(),"DELETE FROM agent_calls WHERE call_id=$1","DELETE FROM v1_control.agent_calls WHERE call_id=$1";id)?;result.calls+=1;remaining-=1;}
            // Conservatively preserve command receipts while any durable
            // canonical/revocation obligation still needs reconciliation.
            let commands=rows!(tx.inner_mut(),(String,String,String),fetch_all,
                "SELECT owner,actor,command_key FROM control_commands WHERE state='committed' AND expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM revocation_events WHERE delivered_at IS NULL) AND NOT EXISTS(SELECT 1 FROM control_operations WHERE state<>'committed') ORDER BY expires_at,owner,actor,command_key LIMIT $2",
                "SELECT owner,actor,command_key FROM v1_control.control_commands WHERE state='committed' AND expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.revocation_events WHERE delivered_at IS NULL) AND NOT EXISTS(SELECT 1 FROM v1_control.control_operations WHERE state<>'committed') ORDER BY expires_at,owner,actor,command_key LIMIT $2 FOR UPDATE";now,remaining)?;
            for (owner,actor,key) in commands{execute!(tx.inner_mut(),"DELETE FROM control_commands WHERE owner=$1 AND actor=$2 AND command_key=$3","DELETE FROM v1_control.control_commands WHERE owner=$1 AND actor=$2 AND command_key=$3";owner,actor,key)?;result.commands+=1;remaining-=1;}
            result.has_more=remaining==0;Ok(result)
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
}

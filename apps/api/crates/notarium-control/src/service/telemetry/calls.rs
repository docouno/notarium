use super::*;

impl ControlService {
    pub async fn begin_agent_call(
        &self,
        ctx: AccountContext,
        request: BeginAgentCall,
    ) -> Result<(), PortError> {
        signed(request.input_bytes)?;
        let fingerprint = hash(&(1, ctx.auth().principal(), ctx.auth().grant(), &request))?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        budget.run(async{
            let auth=self.revalidate_with_keeper(tx.inner_mut(),ctx.auth(),keeper.as_ref()).await?;
            let existing=rows!(tx.inner_mut(),AgentCallsRow,fetch_optional,"SELECT * FROM agent_calls WHERE call_id=$1","SELECT * FROM v1_control.agent_calls WHERE call_id=$1 FOR UPDATE";request.call.as_str())?;
            if let Some(existing)=existing {
                if existing.owner_id!=auth.principal().as_str() || existing.fingerprint!=fingerprint.as_bytes(){return Err(DomainError::IdempotencyKeyReused.into());}return Ok(());
            }
            if let Some(id)=&request.episode {super::super::episodes::episode(tx.inner_mut(),auth.principal(),id).await?;}
            let agent=match auth.kind(){PrincipalKind::AgentRun(run)|PrincipalKind::Keeper(run)=>Some(run.to_string()),_=>None};
            let record=TargetRecord::from(AgentCallsRow{
                call_id:request.call.to_string(),owner_id:auth.principal().to_string(),principal:auth.principal().to_string(),agent,transport:label(&request.transport)?,request_id:request.request.to_string(),episode_id:request.episode.as_ref().map(ToString::to_string),
                tool:label(&request.operation)?,effect:label(&request.effect)?,domain:"control".into(),started_at:self.clock.now_ms()?,finished_at:None,duration_ms:None,outcome:None,reason:None,input_bytes:signed(request.input_bytes)?,output_bytes:None,
                summaries:"null".into(),fingerprint:fingerprint.as_bytes().to_vec(),projection_version:1,redacted:1,truncated:0,detail_capture_failed:0,
            });record.validate()?;record.insert(tx.inner_mut()).await
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
    pub async fn finish_agent_call(
        &self,
        ctx: MaintenanceContext,
        request: FinishAgentCall,
    ) -> Result<(), PortError> {
        ctx.authority.require(ServicePurpose::Telemetry)?;
        signed(request.output_bytes)?;
        if request.outcome == AgentOutcome::Succeeded && request.failure.is_some() {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let encoded = request.detail.as_ref().map(detail).transpose()?;
        let fingerprint = hash(&(1, &request))?;
        let budget = OperationBudget::new(ctx.budget);
        let mut tx = self.store.write(budget.clone()).await?;
        budget.run(async{
            let config=configuration(tx.inner_mut(),false).await?;
            let row=rows!(tx.inner_mut(),AgentCallsRow,fetch_optional,"SELECT * FROM agent_calls WHERE call_id=$1","SELECT * FROM v1_control.agent_calls WHERE call_id=$1 FOR UPDATE";request.call.as_str())?.ok_or(DomainError::ResourceNotFound)?;
            if row.finished_at.is_some(){
                if parse::<Option<ContentDigest>>(&row.summaries)?!=Some(fingerprint){return Err(DomainError::IdempotencyKeyReused.into());}return Ok(());
            }
            let raw_now=self.clock.now_ms()?;
            let finished_at=raw_now.max(row.started_at);
            let duration=finished_at-row.started_at;
            let reason=request.failure.as_ref().map(label).transpose()?;let outcome=label(&request.outcome)?;let summary=json(&fingerprint)?;
            execute!(tx.inner_mut(),"UPDATE agent_calls SET finished_at=$1,duration_ms=$2,outcome=$3,reason=$4,output_bytes=$5,summaries=$6 WHERE call_id=$7","UPDATE v1_control.agent_calls SET finished_at=$1,duration_ms=$2,outcome=$3,reason=$4,output_bytes=$5,summaries=$6 WHERE call_id=$7";finished_at,duration,outcome,reason,signed(request.output_bytes)?,summary,request.call.as_str())?;
            if config.detailed_enabled==1 && let Some(payload)=encoded {
                let expires=raw_now.checked_add(config.detailed_retention_days*DAY).ok_or_else(||invalid(ValidationReason::InvalidTimestamp))?;
                let record=TargetRecord::from(AgentCallDetailsRow{call_id:request.call.to_string(),payload,created_at:raw_now,expires_at:expires});record.validate()?;record.insert(tx.inner_mut()).await?;
            }Ok(())
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
    pub async fn record_agent_retrieval(
        &self,
        ctx: AccountContext,
        request: AgentRetrieval,
    ) -> Result<(), PortError> {
        if request.hits.len() > 200
            || request.hits.len() > request.result_count as usize
            || request.top_score.is_some_and(|v| !v.is_finite())
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let fingerprint = hash(&(1, ctx.auth().principal(), ctx.auth().grant(), &request))?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        budget.run(async{
            let auth=self.revalidate_with_keeper(tx.inner_mut(),ctx.auth(),keeper.as_ref()).await?;
            if let Some(row)=rows!(tx.inner_mut(),AgentRetrievalsRow,fetch_optional,"SELECT * FROM agent_retrievals WHERE retrieval_id=$1","SELECT * FROM v1_control.agent_retrievals WHERE retrieval_id=$1 FOR UPDATE";request.id.as_str())? {
                if row.owner_id!=auth.principal().as_str() || parse::<ContentDigest>(&row.filters)?!=fingerprint {return Err(DomainError::IdempotencyKeyReused.into());}return Ok(());
            }
            if let Some(call)=&request.call {
                let owner=rows!(tx.inner_mut(),(String,),fetch_optional,"SELECT owner_id FROM agent_calls WHERE call_id=$1","SELECT owner_id FROM v1_control.agent_calls WHERE call_id=$1 FOR SHARE";call.as_str())?.ok_or(DomainError::ResourceNotFound)?;
                if owner.0!=auth.principal().as_str(){return Err(DomainError::ResourceNotFound.into());}
            }
            let agent=match auth.kind(){PrincipalKind::AgentRun(run)|PrincipalKind::Keeper(run)=>Some(run.to_string()),_=>None};
            let record=TargetRecord::from(AgentRetrievalsRow{retrieval_id:request.id.to_string(),owner_id:auth.principal().to_string(),principal:auth.principal().to_string(),agent,call_id:request.call.as_ref().map(ToString::to_string),tool:"search".into(),
                query_summary:json(&request.kind)?,filters:json(&fingerprint)?,hit_refs:json(&request.hits)?,result_count:i64::from(request.result_count),top_score:request.top_score,created_at:self.clock.now_ms()?});record.validate()?;record.insert(tx.inner_mut()).await
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
}

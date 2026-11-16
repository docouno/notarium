use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    spaces::{admission, expect_space, require_owner},
};
use crate::{
    auth::token,
    error::{invalid, unavailable},
    store::{
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    auth::*,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingLifecycle {
    version: u8,
    owner: PrincipalId,
    key: CommandKey,
    hash: ContentDigest,
    expected: ControlRevision,
    scope: HistoryScope,
    lifecycle: SpaceLifecycle,
    revision: i64,
    epoch: i64,
    event: RequestId,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultOperation {
    operation: RequestId,
}
impl ControlService {
    pub async fn change_space_lifecycle(
        &self,
        ctx: SpaceContext,
        request: SpaceLifecycleChange,
    ) -> Result<ControlCommit<AccessibleSpace>, PortError> {
        if request.lifecycle == SpaceLifecycle::Closing {
            return Err(access_denied());
        }
        ctx.auth().authorize_human_management()?;
        let digest = ContentDigest::from_bytes(
            *blake3::hash(
                &serde_json::to_vec(&(ctx.scope(), request.lifecycle))
                    .map_err(|_| invalid(ValidationReason::InvalidQuery))?,
            )
            .as_bytes(),
        );
        let command = Command::new(
            AccountCommandIdentity {
                owner: ctx.auth().principal().clone(),
                actor: ctx.auth().principal().clone(),
                key: request.command,
                hash: digest,
                expected: request.expected,
            },
            "change-space-lifecycle",
            (ctx.scope(), request.lifecycle),
        )?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let observed = budget
            .run(
                async {
                    let actor = user_read(rtx.inner_mut(), ctx.auth().principal().as_str()).await?;
                    self.live_human(rtx.inner_mut(), ctx.auth(), &actor).await?;
                    if command
                        .replay::<ResultOperation>(rtx.inner_mut())
                        .await?
                        .is_none()
                    {
                        require_owner(rtx.inner_mut(), ctx.auth(), &ctx.scope().space_id).await?;
                    }
                    admission(rtx.inner_mut(), &ctx.scope().space_id, false).await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let catalog = budget
            .run(
                self.catalog.space(
                    budget.context(ctx.budget.request.clone()),
                    ctx.scope().space_id.clone(),
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        ctx.check_current(&catalog.history)?;
        if catalog.space.id != ctx.scope().space_id {
            return Err(invalid(ValidationReason::InvalidState));
        }
        // Personal Spaces are inseparable from the account and cannot be archived.
        if catalog.space.kind == SpaceKind::Personal && request.lifecycle != SpaceLifecycle::Active
        {
            return Err(access_denied());
        }
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let actor=user(tx.inner_mut(),ctx.auth().principal().as_str()).await?;
            self.live_human(tx.inner_mut(),ctx.auth(),&actor).await?;
            if let Some(replay)=command.replay::<ResultOperation>(tx.inner_mut()).await? {return Ok(replay);}
            let current=admission(tx.inner_mut(),&ctx.scope().space_id,true).await?;
            expect_space(&current,request.expected)?;
            require_owner(tx.inner_mut(),ctx.auth(),&ctx.scope().space_id).await?;
            if current.admission_epoch!=observed.admission_epoch || !matches!(current.state.as_str(),"active"|"archived") {return Err(invalid(ValidationReason::InvalidState));}
            let now=self.clock.now_ms()?;
            let revision=next(current.revision)?;
            let epoch=next(current.admission_epoch)?;
            let event=super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Space(ctx.scope().space_id.clone()),RevocationReason::SpaceClosed,epoch,now).await?;
            execute!(tx.inner_mut(),"UPDATE space_admission SET state='closing',revision=$1,admission_epoch=$2 WHERE space_id=$3","UPDATE v1_control.space_admission SET state='closing',revision=$1,admission_epoch=$2 WHERE space_id=$3";revision,epoch,ctx.scope().space_id.as_str())?;
            let id=RequestId::from_bytes(token::random()?);
            let pending=PendingLifecycle{version:1,owner:ctx.auth().principal().clone(),key:command.identity.key.clone(),hash:digest,expected:request.expected,scope:ctx.scope().clone(),lifecycle:request.lifecycle,revision,epoch,event:event.clone()};
            let payload=serde_json::to_string(&pending).map_err(|_|invalid(ValidationReason::InvalidState))?;
            let row=TargetRecord::from(ControlOperationsRow{operation_id:id.to_string(),command_key:id.to_string(),kind:"lifecycle".into(),target_space:ctx.scope().space_id.to_string(),state:"pending".into(),payload_hash:blake3::hash(payload.as_bytes()).as_bytes().to_vec(),payload,canonical_receipt:None,next_action:"revoke-then-canonical".into(),updated_at:now});
            row.validate()?;row.insert(tx.inner_mut()).await?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:ResultOperation{operation:id},events:vec![event]};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &saved.events).await?;
        let current = self
            .finish_lifecycle(&budget, &saved.value.operation)
            .await?;
        Ok(ControlCommit {
            revision,
            value: AccessibleSpace {
                space: current.space,
                role: SpaceRole::Owner,
                history: current.history,
            },
        })
    }
    pub(super) async fn resume_pending_lifecycles(
        &self,
        budget: &OperationBudget,
    ) -> Result<(), PortError> {
        loop {
            let pending=budget.run(async{read_rows!(&self.store.backend,ControlOperationsRow,fetch_optional,
                "SELECT * FROM control_operations WHERE kind='lifecycle' AND state!='committed' ORDER BY updated_at,operation_id LIMIT 1",
                "SELECT * FROM v1_control.control_operations WHERE kind='lifecycle' AND state!='committed' ORDER BY updated_at,operation_id LIMIT 1";)
            },CommitEffect::Unknown).await?;
            let Some(pending) = pending else {
                return Ok(());
            };
            self.finish_lifecycle(budget, &RequestId::parse(&pending.operation_id)?)
                .await?;
        }
    }
    async fn finish_lifecycle(
        &self,
        budget: &OperationBudget,
        id: &RequestId,
    ) -> Result<CatalogSpace, PortError> {
        let work=async {
            let row=budget.run(async{read_rows!(&self.store.backend,ControlOperationsRow,fetch_one,"SELECT * FROM control_operations WHERE operation_id=$1","SELECT * FROM v1_control.control_operations WHERE operation_id=$1";id.as_str())},CommitEffect::Unknown).await?;
            if row.kind!="lifecycle" || row.payload_hash!=blake3::hash(row.payload.as_bytes()).as_bytes() {return Err(invalid(ValidationReason::InvalidState));}
            let pending:PendingLifecycle=serde_json::from_str(&row.payload).map_err(|_|invalid(ValidationReason::InvalidState))?;
            if pending.version!=1 || pending.scope.space_id.as_str()!=row.target_space || pending.lifecycle==SpaceLifecycle::Closing {return Err(invalid(ValidationReason::InvalidState));}
            if row.state=="committed" {
                let (space,history,last_seq)=serde_json::from_str(row.canonical_receipt.as_deref().ok_or_else(||invalid(ValidationReason::InvalidState))?).map_err(|_|invalid(ValidationReason::InvalidState))?;
                return Ok(CatalogSpace{space,history,last_seq});
            }
            self.flush_event(budget,&pending.event).await?;
            let identity=AccountCommandIdentity{owner:pending.owner.clone(),actor:pending.owner,key:pending.key,hash:pending.hash,expected:pending.expected};
            let result=budget.run(self.catalog.change_lifecycle(budget.context(id.clone()),identity,pending.scope.clone(),pending.lifecycle),CommitEffect::Unknown).await?;
            result.history.check(&pending.scope)?;
            if result.space.id!=pending.scope.space_id || result.space.lifecycle!=pending.lifecycle {return Err(invalid(ValidationReason::InvalidState));}
            let receipt=serde_json::to_string(&(result.space.clone(),result.history.clone(),result.last_seq)).map_err(|_|invalid(ValidationReason::InvalidState))?;
            let mut tx=self.store.write(budget.clone()).await?;
            budget.run(async {
                let current=rows!(tx.inner_mut(),ControlOperationsRow,fetch_one,"SELECT * FROM control_operations WHERE operation_id=$1","SELECT * FROM v1_control.control_operations WHERE operation_id=$1 FOR UPDATE";id.as_str())?;
                if current.payload_hash!=row.payload_hash {return Err(invalid(ValidationReason::InvalidState));}
                if current.state=="committed" {return Ok(());}
                let current=admission(tx.inner_mut(),&pending.scope.space_id,true).await?;
                if current.state!="closing" || current.revision!=pending.revision || current.admission_epoch!=pending.epoch {return Err(invalid(ValidationReason::InvalidState));}
                let state=if pending.lifecycle==SpaceLifecycle::Active {"active"} else {"archived"};
                execute!(tx.inner_mut(),"UPDATE space_admission SET state=$1 WHERE space_id=$2","UPDATE v1_control.space_admission SET state=$1 WHERE space_id=$2";state,pending.scope.space_id.as_str())?;
                execute!(tx.inner_mut(),"UPDATE control_operations SET state='committed',canonical_receipt=$1,next_action='done',updated_at=$2 WHERE operation_id=$3","UPDATE v1_control.control_operations SET state='committed',canonical_receipt=$1,next_action='done',updated_at=$2 WHERE operation_id=$3";&receipt,self.clock.now_ms()?,id.as_str())?;
                Ok(())
            },CommitEffect::Unknown).await?;
            budget.run(tx.commit(),CommitEffect::Unknown).await?;
            Ok(result)
        }.await;
        work.map_err(|_: PortError| {
            unavailable("control pending lifecycle operation", CommitEffect::Unknown)
        })
    }
}

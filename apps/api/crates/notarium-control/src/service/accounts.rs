use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    provider::SearchDefaultWitness,
};
use crate::store::{lease::OperationBudget, statements::execute};
use notarium_core::{
    error::{CommitEffect, PortError},
    ports::{control::*, *},
};

impl ControlService {
    pub async fn set_disabled(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetAccountDisabled>,
    ) -> Result<ControlCommit<AccountInfo>, PortError> {
        let command = Command::new(
            request.identity,
            "set-account-disabled",
            (&request.input.account, request.input.disabled),
        )?;
        command.require(ctx.auth().principal(), &request.input.account)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved,enqueued)=budget.run(async {
            let (actor,mut target)=self.manager(tx.inner_mut(),ctx.auth(),&request.input.account).await?;
            if actor.is_admin!=1 || actor.user_id==target.user_id {return Err(access_denied());}
            if let Some((revision,saved))=command.replay::<AccountInfo>(tx.inner_mut()).await? {return Ok((revision,saved,Vec::new()));}
            expect_revision(&target,command.identity.expected)?;
            let now=self.clock.now_ms()?;
            let mut events=super::outbox::pending(tx.inner_mut(),RevocationSelector::Principal(request.input.account.clone())).await?;
            let mut enqueued=Vec::new();
            if request.input.disabled!=target.disabled_at.is_some() {
                let defaults = if request.input.disabled {
                    Vec::new()
                } else {
                    SearchDefaultWitness::before_owner_enable(tx.inner_mut(), &target.user_id, self.clock.as_ref()).await?
                };
                let principal_event = self.revoke_principal(tx.inner_mut(),&target,now).await?;
                enqueued.push(principal_event.clone());
                events.push(principal_event);
                target.disabled_at=request.input.disabled.then_some(now);
                target.revision=next(target.revision)?;
                target.auth_version=next(target.auth_version)?;
                execute!(tx.inner_mut(),"UPDATE users SET disabled_at=$1,revision=$2,auth_version=$3 WHERE user_id=$4","UPDATE v1_control.users SET disabled_at=$1,revision=$2,auth_version=$3 WHERE user_id=$4";target.disabled_at,target.revision,target.auth_version,&target.user_id)?;
                for previous in defaults {
                    if let Some(selector) = previous.changed(tx.inner_mut(), self.clock.now_ms()?).await? {
                        let event = super::outbox::enqueue(tx.inner_mut(), selector, RevocationReason::PermissionChanged, target.auth_version, now).await?;
                        enqueued.push(event.clone());
                        events.push(event);
                    }
                }
            }
            let value=account_info(&target)?;
            let revision=value.revision;
            let saved=SavedResult{value,events};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved,enqueued))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &enqueued).await?;
        for event in &saved.events {
            self.flush_event(&budget, event).await?;
        }
        Ok(ControlCommit {
            value: saved.value,
            revision,
        })
    }
}

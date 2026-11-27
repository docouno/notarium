use super::{AuthenticationMode, ControlService, authority::*};
use crate::{
    auth::{
        password,
        token::{self, TokenKind},
    },
    error::invalid,
    store::{
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ports::{control::ControlCommit, *},
};

fn purpose(value: OneTimePurpose) -> &'static str {
    match value {
        OneTimePurpose::Invite => "invite",
        OneTimePurpose::Reset => "reset",
    }
}
impl ControlService {
    pub async fn issue_one_time(
        &self,
        ctx: AccountContext,
        request: IssueOneTime,
    ) -> Result<ControlCommit<IssuedOneTime>, PortError> {
        if !matches!(self.config.authentication, AuthenticationMode::Password) {
            return Err(denied());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let result=budget.run(async {
            let (actor,current)=self.manager(tx.inner_mut(),ctx.auth(),&request.account).await?;
            if actor.is_admin!=1 || current.disabled_at.is_some() {return Err(access_denied());}
            expect_revision(&current,request.expected)?;
            if request.purpose==OneTimePurpose::Invite && current.password_hash.is_some() {return Err(invalid(ValidationReason::InvalidState));}
            let now=self.clock.now_ms()?;
            let ttl=match request.purpose {OneTimePurpose::Invite=>7*24*60*60*1000,OneTimePurpose::Reset=>24*60*60*1000};
            let expires_at=now.checked_add(ttl).ok_or_else(||invalid(ValidationReason::InvalidTimestamp))?;
            let token=token::mint(TokenKind::OneTime)?;
            // Reissuing invalidates the previous token of the same purpose.
            execute!(tx.inner_mut(),"UPDATE one_time_tokens SET used_at=$1 WHERE user_id=$2 AND purpose=$3 AND used_at IS NULL","UPDATE v1_control.one_time_tokens SET used_at=$1 WHERE user_id=$2 AND purpose=$3 AND used_at IS NULL";now,&current.user_id,purpose(request.purpose))?;
            let row=TargetRecord::from(OneTimeTokensRow{token_hash:token.digest.to_vec(),user_id:current.user_id.clone(),purpose:purpose(request.purpose).into(),expires_at,used_at:None,created_at:now});
            row.validate()?;
            row.insert(tx.inner_mut()).await?;
            let revision=next(current.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&current.user_id)?;
            Ok(ControlCommit{value:IssuedOneTime{token:token.secret,purpose:request.purpose,expires_at_ms:expires_at},revision:notarium_core::ids::ControlRevision::new(revision as u64)?})
        },CommitEffect::NotCommitted).await?;
        budget.run_commit(tx.commit()).await?;
        Ok(result)
    }
    pub async fn consume_one_time(
        &self,
        ctx: CallBudget,
        request: ConsumeOneTime,
    ) -> Result<IssuedSession, PortError> {
        if !matches!(self.config.authentication, AuthenticationMode::Password) {
            return Err(denied());
        }
        let (_, digest) =
            token::parse(TokenKind::OneTime, request.token.expose()).map_err(|_| denied())?;
        let budget = OperationBudget::new(ctx);
        let observed=budget.run(async{read_rows!(&self.store.backend,OneTimeTokensRow,fetch_optional,"SELECT * FROM one_time_tokens WHERE token_hash=$1","SELECT * FROM v1_control.one_time_tokens WHERE token_hash=$1";digest.as_slice())?.ok_or_else(denied)},CommitEffect::NotCommitted).await?;
        check_one_time(&observed, &digest, request.purpose, self.clock.now_ms()?)?;
        let hash = budget
            .run(password::hash(request.password), CommitEffect::NotCommitted)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (event,issued)=budget.run(async {
            let mut current=user(tx.inner_mut(),&observed.user_id).await?;
            if current.disabled_at.is_some() {return Err(denied());}
            let one_time=rows!(tx.inner_mut(),OneTimeTokensRow,fetch_optional,"SELECT * FROM one_time_tokens WHERE token_hash=$1","SELECT * FROM v1_control.one_time_tokens WHERE token_hash=$1";digest.as_slice())?.ok_or_else(denied)?;
            let now=self.clock.now_ms()?;
            check_one_time(&one_time,&digest,request.purpose,now)?;
            if one_time.user_id!=current.user_id || (request.purpose==OneTimePurpose::Invite && current.password_hash.is_some()) {return Err(denied());}
            let event=self.revoke_principal(tx.inner_mut(),&current,now).await?;
            current.revision=next(current.revision)?;
            current.auth_version=next(current.auth_version)?;
            execute!(tx.inner_mut(),"UPDATE users SET password_hash=$1,revision=$2,auth_version=$3 WHERE user_id=$4","UPDATE v1_control.users SET password_hash=$1,revision=$2,auth_version=$3 WHERE user_id=$4";&hash,current.revision,current.auth_version,&current.user_id)?;
            let issued=mint_session(tx.inner_mut(),&current,now).await?;
            Ok((event,issued))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, std::slice::from_ref(&event))
            .await?;
        self.flush_event(&budget, &event).await?;
        Ok(issued)
    }
}
fn check_one_time(
    row: &OneTimeTokensRow,
    digest: &[u8; 32],
    expected: OneTimePurpose,
    now: i64,
) -> Result<(), PortError> {
    check_digest(&row.token_hash, digest)?;
    if row.used_at.is_some() || row.expires_at <= now || row.purpose != purpose(expected) {
        return Err(denied());
    }
    Ok(())
}

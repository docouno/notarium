use super::super::{
    authority::*,
    commands::{Command, SavedResult},
    outbox,
    sessions::selected,
};
use super::{OAuthService, invalid_grant, tokens, validation};
use crate::store::{
    lease::OperationBudget,
    statements::{execute, page_rows},
    target::*,
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError},
    ids::*,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    owner: PrincipalId,
    revision: ControlRevision,
    last: OAuthGrantId,
}
impl OAuthService {
    pub(super) async fn grants(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<OAuthGrantInfo>, PortError> {
        let cursor: Option<Cursor> = page
            .continuation()
            .map(|s| serde_json::from_str(s).map_err(|_| invalid_grant()))
            .transpose()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.control.store.read(budget.clone()).await?;
        let result=budget.run(async {
            let (_,user)=self.control.manager_read(rtx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            if let Some(cursor)=&cursor {
                if cursor.version!=1 || cursor.owner!=*ctx.auth().principal() {return Err(invalid_grant());}
                expect_revision(&user,cursor.revision)?;
            }
            let last=cursor.as_ref().map_or("",|v|v.last.as_str());
            let rows=page_rows!(rtx.inner_mut(),OauthGrantsRow,TargetTable::OauthGrants,page.limit(),"SELECT * FROM oauth_grants WHERE user_id=$1 AND grant_id>$2 ORDER BY grant_id LIMIT $3","SELECT * FROM v1_control.oauth_grants WHERE user_id=$1 AND grant_id>$2 ORDER BY grant_id LIMIT $3";&user.user_id,last,i64::from(page.limit())+1)?;
            let continuation=if rows.has_more {Some(serde_json::to_string(&Cursor {version:1,owner:ctx.auth().principal().clone(),revision:ControlRevision::new(user.revision as u64)?,last:OAuthGrantId::parse(&rows.rows.last().ok_or_else(invalid_grant)?.grant_id)?}).map_err(|_|invalid_grant())?)} else {None};
            let items=rows.rows.into_iter().map(|row|Ok(OAuthGrantInfo {id:OAuthGrantId::parse(&row.grant_id)?,client_id:row.client_id,resource:row.resource_uri,scope:validation::stored_scope(&row.scope)?,selected_spaces:selected(row.selected_spaces.as_deref(),self.control.config.max_auth_spaces)?.map(|s|s.into_iter().collect()),revoked_at_ms:row.revoked_at,created_at_ms:row.created_at})).collect::<Result<_,PortError>>()?;
            Ok(ControlPage {items,continuation})
        },CommitEffect::NotCommitted).await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        Ok(result)
    }
    pub(super) async fn disconnect(
        &self,
        ctx: AccountContext,
        request: AccountMutation<OAuthGrantId>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(request.identity, "revoke-oauth-grant", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let (_,user)=self.control.manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            if let Some(replay)=command.replay::<()>(tx.inner_mut()).await? {return Ok(replay);}
            expect_revision(&user,command.identity.expected)?;
            let grant=tokens::consent(tx.inner_mut(),request.input.as_str()).await?;
            if grant.user_id!=user.user_id {return Err(DomainError::ResourceNotFound.into());}
            let selector=RevocationSelector::OAuthGrant(request.input);
            let mut events=outbox::pending(tx.inner_mut(),selector.clone()).await?;
            let now=self.control.clock.now_ms()?;
            let revision=if grant.revoked_at.is_none() {
                let grant_revision=next(grant.revision)?;
                execute!(tx.inner_mut(),"UPDATE oauth_grants SET revoked_at=$1,revision=$2 WHERE grant_id=$3","UPDATE v1_control.oauth_grants SET revoked_at=$1,revision=$2 WHERE grant_id=$3";now,grant_revision,&grant.grant_id)?;
                let revision=next(user.revision)?;
                execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&user.user_id)?;
                events.push(outbox::enqueue(tx.inner_mut(),selector,RevocationReason::CredentialRemoved,grant_revision,now).await?);
                revision
            } else {user.revision};
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult {value:(),events};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        self.control
            .commit_revocations(tx, &budget, &saved.events)
            .await?;
        for event in saved.events {
            self.control.flush_event(&budget, &event).await?;
        }
        Ok(ControlCommit {
            revision,
            value: (),
        })
    }
}

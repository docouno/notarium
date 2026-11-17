use super::super::{authority::*, outbox};
use super::{OAuthService, expiry, invalid_grant, rejected, validation};
use crate::{
    auth::token::{self, TokenKind},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    error::{CommitEffect, PortError},
    ids::*,
    ports::*,
};

pub(super) async fn consent(tx: &mut Transaction, id: &str) -> Result<OauthGrantsRow, PortError> {
    rows!(tx,OauthGrantsRow,fetch_optional,"SELECT * FROM oauth_grants WHERE grant_id=$1","SELECT * FROM v1_control.oauth_grants WHERE grant_id=$1";id)?.ok_or_else(invalid_grant)
}
async fn code(tx: &mut Transaction, hash: &[u8]) -> Result<OauthAuthCodesRow, PortError> {
    rows!(tx,OauthAuthCodesRow,fetch_optional,"SELECT * FROM oauth_auth_codes WHERE code_hash=$1","SELECT * FROM v1_control.oauth_auth_codes WHERE code_hash=$1";hash)?.ok_or_else(invalid_grant)
}
async fn refresh(tx: &mut Transaction, id: &str) -> Result<OauthRefreshTokensRow, PortError> {
    rows!(tx,OauthRefreshTokensRow,fetch_optional,"SELECT * FROM oauth_refresh_tokens WHERE token_id=$1","SELECT * FROM v1_control.oauth_refresh_tokens WHERE token_id=$1";id)?.ok_or_else(invalid_grant)
}
async fn family(tx: &mut Transaction, id: &str) -> Result<OauthRefreshFamiliesRow, PortError> {
    rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1";id)?.ok_or_else(invalid_grant)
}
async fn lock_family(tx: &mut Transaction, id: &str) -> Result<OauthRefreshFamiliesRow, PortError> {
    rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1 FOR UPDATE";id)?.ok_or_else(invalid_grant)
}
async fn access(tx: &mut Transaction, id: &str) -> Result<Option<OauthAccessTokensRow>, PortError> {
    rows!(tx,OauthAccessTokensRow,fetch_optional,"SELECT * FROM oauth_access_tokens WHERE token_id=$1","SELECT * FROM v1_control.oauth_access_tokens WHERE token_id=$1";id)
}
fn proof(expected: &[u8], actual: &[u8; 32]) -> Result<(), PortError> {
    check_digest(expected, actual).map_err(|_| invalid_grant())
}

async fn issue(
    tx: &mut Transaction,
    grant: &OauthGrantsRow,
    family: Option<&OAuthFamilyId>,
    now: i64,
) -> Result<IssuedOAuthTokens, PortError> {
    let refresh = family
        .map(|_| token::mint(TokenKind::Refresh))
        .transpose()?;
    let refresh_expiry = if refresh.is_some() {
        Some(expiry(now, 30 * 24 * 60 * 60 * 1000)?)
    } else {
        None
    };
    if let (Some(family), Some(refresh), Some(expires)) = (family, &refresh, refresh_expiry) {
        let record = TargetRecord::from(OauthRefreshTokensRow {
            token_id: refresh.id.clone().ok_or_else(invalid_grant)?,
            token_hash: refresh.digest.to_vec(),
            family_id: family.to_string(),
            client_id: grant.client_id.clone(),
            issued_at: now,
            expires_at: expires,
            used_at: None,
            revoked_at: None,
            rotated_to: None,
        });
        record.validate()?;
        record.insert(tx).await?;
    }
    let access = token::mint(TokenKind::Access)?;
    let expires = expiry(now, 60 * 60 * 1000)?;
    let record = TargetRecord::from(OauthAccessTokensRow {
        token_id: access.id.ok_or_else(invalid_grant)?,
        token_hash: access.digest.to_vec(),
        grant_id: grant.grant_id.clone(),
        family_id: family.map(ToString::to_string),
        refresh_id: refresh.as_ref().and_then(|r| r.id.clone()),
        resource_uri: grant.resource_uri.clone(),
        scope: grant.scope.clone(),
        selected_spaces: grant.selected_spaces.clone(),
        issued_at: now,
        expires_at: expires,
        revoked_at: None,
        last_used_at: None,
    });
    record.validate()?;
    record.insert(tx).await?;
    Ok(IssuedOAuthTokens {
        access_token: access.secret,
        refresh_token: refresh.map(|r| r.secret),
        expires_at_ms: expires,
        refresh_expires_at_ms: refresh_expiry,
        scope: OAuthScope {
            access: validation::stored_scope(&grant.scope)?,
            offline_access: family.is_some(),
        },
        grant: OAuthGrantId::parse(&grant.grant_id)?,
        family: family.cloned(),
    })
}
async fn revoke_family(
    tx: &mut Transaction,
    row: &OauthRefreshFamiliesRow,
    now: i64,
    reason: &str,
) -> Result<Vec<RequestId>, PortError> {
    let selector = RevocationSelector::OAuthFamily(OAuthFamilyId::parse(&row.family_id)?);
    let mut events = outbox::pending(tx, selector.clone()).await?;
    if row.revoked_at.is_none() {
        execute!(tx,"UPDATE oauth_refresh_families SET revoked_at=$1,reason_code=$2 WHERE family_id=$3","UPDATE v1_control.oauth_refresh_families SET revoked_at=$1,reason_code=$2 WHERE family_id=$3";now,reason,&row.family_id)?;
        events.push(
            outbox::enqueue(tx, selector, RevocationReason::CredentialRemoved, 1, now).await?,
        );
    }
    Ok(events)
}
impl OAuthService {
    pub(super) async fn exchange(
        &self,
        call: CallBudget,
        request: ExchangeOAuthCode,
    ) -> Result<IssuedOAuthTokens, PortError> {
        if request.client_id.len() > 2048
            || request.redirect_uri.len() > 2048
            || request.resource != self.metadata.resource
        {
            return Err(invalid_grant());
        }
        let (_, hash) = token::parse(TokenKind::AuthorizationCode, request.code.expose())
            .map_err(|_| invalid_grant())?;
        let budget = OperationBudget::new(call);
        let mut tx = self.control.store.write(budget.clone()).await?;
        let result=budget.run(async {
            let observed=code(tx.inner_mut(),&hash).await?;
            let observed_grant=consent(tx.inner_mut(),&observed.grant_id).await?;
            let user=user(tx.inner_mut(),&observed_grant.user_id).await.map_err(|_|invalid_grant())?;
            let grant=consent(tx.inner_mut(),&observed.grant_id).await?;
            let current=code(tx.inner_mut(),&hash).await?;
            let now=self.control.clock.now_ms()?;
            if current.used_at.is_some() || current.expires_at<=now || current.client_id!=request.client_id || current.redirect_uri!=request.redirect_uri
                || current.resource_uri!=request.resource || current.method!="S256" || current.grant_id!=grant.grant_id
                || grant.client_id!=request.client_id || grant.resource_uri!=request.resource || grant.revoked_at.is_some() || user.disabled_at.is_some() {return Err(invalid_grant());}
            validation::verify_pkce(request.code_verifier.expose(),&current.code_challenge)?;
            let changed=execute!(tx.inner_mut(),"UPDATE oauth_auth_codes SET used_at=$1 WHERE code_hash=$2 AND used_at IS NULL","UPDATE v1_control.oauth_auth_codes SET used_at=$1 WHERE code_hash=$2 AND used_at IS NULL";now,hash.as_slice())?;
            if changed!=1 {return Err(invalid_grant());}
            let family=if current.offline_access==1 {
                let id=OAuthFamilyId::from_bytes(token::random()?);
                let record=TargetRecord::from(OauthRefreshFamiliesRow {family_id:id.to_string(),grant_id:grant.grant_id.clone(),revoked_at:None,reason_code:None,created_at:now});
                record.validate()?; record.insert(tx.inner_mut()).await?; Some(id)
            } else {None};
            issue(tx.inner_mut(),&grant,family.as_ref(),now).await
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
    pub(super) async fn rotate(
        &self,
        call: CallBudget,
        request: RefreshOAuthToken,
    ) -> Result<IssuedOAuthTokens, PortError> {
        if request.client_id.len() > 2048 || request.resource != self.metadata.resource {
            return Err(invalid_grant());
        }
        let (id, hash) = token::parse(TokenKind::Refresh, request.refresh_token.expose())
            .map_err(|_| invalid_grant())?;
        let id = id.ok_or_else(invalid_grant)?;
        let requested_scope = request
            .scope
            .as_deref()
            .map(validation::scope)
            .transpose()?;
        let budget = OperationBudget::new(call);
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (result,events)=budget.run(async {
            let observed=refresh(tx.inner_mut(),id).await?;
            proof(&observed.token_hash,&hash)?;
            let observed_family=family(tx.inner_mut(),&observed.family_id).await?;
            let observed_grant=consent(tx.inner_mut(),&observed_family.grant_id).await?;
            let user=user(tx.inner_mut(),&observed_grant.user_id).await.map_err(|_|invalid_grant())?;
            let grant=consent(tx.inner_mut(),&observed_family.grant_id).await?;
            let family=lock_family(tx.inner_mut(),&observed.family_id).await?;
            let current=rows!(tx.inner_mut(),OauthRefreshTokensRow,fetch_one,"SELECT * FROM oauth_refresh_tokens WHERE token_id=$1","SELECT * FROM v1_control.oauth_refresh_tokens WHERE token_id=$1 FOR UPDATE";id)?;
            proof(&current.token_hash,&hash)?;
            let now=self.control.clock.now_ms()?;
            if current.client_id!=request.client_id || current.family_id!=family.family_id || current.expires_at<=now || current.revoked_at.is_some()
                || grant.client_id!=request.client_id || grant.resource_uri!=request.resource || family.grant_id!=grant.grant_id || grant.revoked_at.is_some() || user.disabled_at.is_some() {return Err(invalid_grant());}
            let scope=OAuthScope {access:validation::stored_scope(&grant.scope)?,offline_access:true};
            if requested_scope.is_some_and(|s|s!=scope) {return Err(rejected(OAuthErrorCode::InvalidScope));}
            if current.used_at.is_some() || current.rotated_to.is_some() || family.revoked_at.is_some() {
                let events=revoke_family(tx.inner_mut(),&family,now,"refresh_reuse").await?;
                return Ok((None,events));
            }
            let family_id=OAuthFamilyId::parse(&family.family_id)?;
            let tokens=issue(tx.inner_mut(),&grant,Some(&family_id),now).await?;
            let (successor,_)=token::parse(TokenKind::Refresh,tokens.refresh_token.as_ref().ok_or_else(invalid_grant)?.expose())?;
            let successor=successor.ok_or_else(invalid_grant)?;
            let changed=execute!(tx.inner_mut(),"UPDATE oauth_refresh_tokens SET used_at=$1,rotated_to=$2 WHERE token_id=$3 AND used_at IS NULL AND rotated_to IS NULL","UPDATE v1_control.oauth_refresh_tokens SET used_at=$1,rotated_to=$2 WHERE token_id=$3 AND used_at IS NULL AND rotated_to IS NULL";now,successor,id)?;
            if changed!=1 {return Err(invalid_grant());}
            Ok((Some(tokens),vec![]))
        },CommitEffect::NotCommitted).await?;
        self.control
            .commit_revocations(tx, &budget, &events)
            .await?;
        for event in events {
            self.control.flush_event(&budget, &event).await?;
        }
        result.ok_or_else(invalid_grant)
    }
    pub(super) async fn revoke_token(
        &self,
        call: CallBudget,
        request: RevokeOAuthToken,
    ) -> Result<(), PortError> {
        if request.client_id.len() > 2048 {
            return Ok(());
        }
        let kind = if request
            .token
            .expose()
            .starts_with(TokenKind::Refresh.prefix())
        {
            TokenKind::Refresh
        } else {
            TokenKind::Access
        };
        let Ok((Some(id), hash)) = token::parse(kind, request.token.expose()) else {
            return Ok(());
        };
        let budget = OperationBudget::new(call);
        let mut tx = self.control.store.write(budget.clone()).await?;
        let events=budget.run(async {
            let (grant_id,family_id)=if kind==TokenKind::Refresh {
                let row=rows!(tx.inner_mut(),OauthRefreshTokensRow,fetch_optional,"SELECT * FROM oauth_refresh_tokens WHERE token_id=$1","SELECT * FROM v1_control.oauth_refresh_tokens WHERE token_id=$1";id)?;
                let Some(row)=row else {return Ok(vec![])};
                if proof(&row.token_hash,&hash).is_err() || row.client_id!=request.client_id {return Ok(vec![]);}
                let family=family(tx.inner_mut(),&row.family_id).await?;
                (family.grant_id,Some(family.family_id))
            } else {
                let Some(row)=access(tx.inner_mut(),id).await? else {return Ok(vec![])};
                if proof(&row.token_hash,&hash).is_err() {return Ok(vec![]);}
                (row.grant_id,row.family_id)
            };
            let grant=consent(tx.inner_mut(),&grant_id).await?;
            if grant.client_id!=request.client_id {return Ok(vec![]);}
            // All token/grant mutations take the same user lock first. A
            // disabled owner may still revoke its own valid token proof.
            user(tx.inner_mut(),&grant.user_id).await?;
            let now=self.control.clock.now_ms()?;
            if let Some(id)=family_id {
                let family=lock_family(tx.inner_mut(),&id).await?;
                if family.grant_id!=grant_id {return Err(invalid_grant());}
                revoke_family(tx.inner_mut(),&family,now,"token_revoked").await
            } else {
                let row=access(tx.inner_mut(),id).await?.ok_or_else(invalid_grant)?;
                proof(&row.token_hash,&hash)?;
                let selector=RevocationSelector::OAuthAccess(CredentialTokenId::parse(id)?);
                let mut events=outbox::pending(tx.inner_mut(),selector.clone()).await?;
                if row.revoked_at.is_none() {
                    execute!(tx.inner_mut(),"UPDATE oauth_access_tokens SET revoked_at=$1 WHERE token_id=$2","UPDATE v1_control.oauth_access_tokens SET revoked_at=$1 WHERE token_id=$2";now,id)?;
                    events.push(outbox::enqueue(tx.inner_mut(),selector,RevocationReason::CredentialRemoved,1,now).await?);
                }
                Ok(events)
            }
        },CommitEffect::NotCommitted).await?;
        self.control
            .commit_revocations(tx, &budget, &events)
            .await?;
        for event in events {
            self.control.flush_event(&budget, &event).await?;
        }
        Ok(())
    }
}

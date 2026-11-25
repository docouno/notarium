use super::super::authority::*;
use super::{OAuthService, clients, expiry, invalid_grant, rejected, validation};
use crate::{
    auth::token::{self, TokenKind},
    keyring::EnvelopeAddress,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    auth::{AuthenticatedCredential, SecretString},
    error::{CommitEffect, PortError},
    ids::*,
    ports::*,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    grant: OAuthGrantId,
    user: PrincipalId,
    credential: String,
    auth_version: i64,
    browser: [u8; 32],
    client_id: String,
    client_digest: [u8; 32],
    redirect: String,
    resource: String,
    scope: OAuthScope,
    spaces: Option<Vec<SpaceId>>,
    challenge: String,
    expires: i64,
}
fn credential(ctx: &AccountContext) -> Result<String, PortError> {
    match ctx.auth().credential() {
        Some(AuthenticatedCredential::Session(id)) => Ok(id.to_string()),
        Some(AuthenticatedCredential::TrustedNone) => Ok("trusted-none".into()),
        _ => Err(rejected(OAuthErrorCode::AccessDenied)),
    }
}
impl OAuthService {
    async fn check_spaces(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        user: &UsersRow,
        spaces: Option<&[SpaceId]>,
        access: BearerScope,
        lock: bool,
    ) -> Result<(), PortError> {
        let auth = self
            .control
            .human_context(
                tx,
                user,
                ctx.auth().credential().cloned().ok_or_else(denied)?,
                ctx.auth().grant().clone(),
                false,
                false,
                lock,
            )
            .await?;
        let all_classes = notarium_core::classes::DocClass::all();
        let check_caller_grant = |id: &SpaceId,
                                  caller_grant: &notarium_core::auth::SpaceGrant|
         -> Result<(), PortError> {
            if caller_grant.read_classes != all_classes {
                return Err(rejected(OAuthErrorCode::AccessDenied));
            }
            if access == BearerScope::Write {
                let live_writable = auth
                    .spaces()
                    .get(id)
                    .map(|g| g.role != notarium_core::auth::SpaceRole::Viewer)
                    .unwrap_or(caller_grant.role != notarium_core::auth::SpaceRole::Viewer);
                if live_writable
                    && (caller_grant.role == notarium_core::auth::SpaceRole::Viewer
                        || caller_grant.write_classes != all_classes)
                {
                    return Err(rejected(OAuthErrorCode::AccessDenied));
                }
            }
            Ok(())
        };
        if let Some(spaces) = spaces {
            if spaces.len() > usize::from(self.control.config.max_auth_spaces).min(256) {
                return Err(rejected(OAuthErrorCode::InvalidScope));
            }
            for id in spaces {
                let caller_grant = ctx
                    .auth()
                    .spaces()
                    .get(id)
                    .ok_or_else(|| rejected(OAuthErrorCode::AccessDenied))?;
                if !auth.spaces().contains_key(id) {
                    return Err(rejected(OAuthErrorCode::AccessDenied));
                }
                check_caller_grant(id, caller_grant)?;
            }
        } else {
            if ctx.auth().is_space_narrowed() {
                return Err(rejected(OAuthErrorCode::AccessDenied));
            }
            for (id, caller_grant) in ctx.auth().spaces() {
                check_caller_grant(id, caller_grant)?;
            }
        }
        Ok(())
    }
    pub(super) async fn prepare(
        &self,
        ctx: AccountContext,
        request: PrepareOAuthAuthorization,
    ) -> Result<PreparedOAuthAuthorization, PortError> {
        if request.resource != self.metadata.resource {
            return Err(rejected(OAuthErrorCode::InvalidTarget));
        }
        if request.code_challenge_method != "S256" {
            return Err(rejected(OAuthErrorCode::InvalidRequest));
        }
        validation::challenge(&request.code_challenge)?;
        let scope = validation::scope(&request.scope)?;
        let browser = validation::browser(request.browser_binding.expose())?;
        let credential = credential(&ctx)?;
        validation::grant_client(ctx.auth().principal(), &request.client_id)?;
        if request
            .selected_spaces
            .as_ref()
            .is_some_and(|v| v.len() > 256)
        {
            return Err(rejected(OAuthErrorCode::InvalidScope));
        }
        let spaces = request.selected_spaces.map(|v| {
            v.into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        });
        let budget = OperationBudget::new(ctx.budget.clone());
        {
            let mut pre_rtx = self.control.store.read(budget.clone()).await?;
            budget
                .run(
                    async {
                        let (_, user) = self
                            .control
                            .manager_read_allow_space_narrowed(
                                pre_rtx.inner_mut(),
                                ctx.auth(),
                                ctx.auth().principal(),
                            )
                            .await?;
                        self.check_spaces(
                            pre_rtx.inner_mut(),
                            &ctx,
                            &user,
                            spaces.as_deref(),
                            scope.access,
                            false,
                        )
                        .await
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget
                .run(pre_rtx.finish(), CommitEffect::NotCommitted)
                .await?;
        }
        let client = self
            .client(
                budget.context(ctx.budget.request.clone()),
                &request.client_id,
            )
            .await?;
        let info = clients::info(&client)?;
        validation::matches_redirect(&info.redirect_uris, &request.redirect_uri)?;
        let mut rtx = self.control.store.read(budget.clone()).await?;
        let now = self.control.clock.now_ms()?;
        let intent = budget
            .run(
                async {
                    let (_, user) = self
                        .control
                        .manager_read_allow_space_narrowed(
                            rtx.inner_mut(),
                            ctx.auth(),
                            ctx.auth().principal(),
                        )
                        .await?;
                    self.check_spaces(
                        rtx.inner_mut(),
                        &ctx,
                        &user,
                        spaces.as_deref(),
                        scope.access,
                        false,
                    )
                    .await?;
                    let current = clients::observed(rtx.inner_mut(), &request.client_id).await?;
                    if !client.matches(&current, now) {
                        return Err(rejected(OAuthErrorCode::InvalidClient));
                    }
                    Ok(Intent {
                        version: 1,
                        grant: OAuthGrantId::from_bytes(token::random()?),
                        user: ctx.auth().principal().clone(),
                        credential,
                        auth_version: user.auth_version,
                        browser,
                        client_id: request.client_id,
                        client_digest: clients::digest(&current),
                        redirect: request.redirect_uri,
                        resource: request.resource,
                        scope,
                        spaces,
                        challenge: request.code_challenge,
                        expires: expiry(now, 10 * 60 * 1000)?,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let plaintext =
            SecretString::new(serde_json::to_string(&intent).map_err(|_| invalid_grant())?);
        let sealed = self
            .keyring
            .seal(
                budget.context(ctx.budget.request),
                EnvelopeAddress::oauth_intent(&intent.grant),
                plaintext,
            )
            .await?;
        Ok(PreparedOAuthAuthorization {
            client: info,
            redirect_uri: intent.redirect,
            resource: intent.resource,
            scope,
            selected_spaces: intent.spaces,
            expires_at_ms: intent.expires,
            intent: OAuthAuthorizationIntent {
                id: intent.grant,
                protected: SecretString::new(sealed.encrypted),
            },
        })
    }
    pub(super) async fn approve(
        &self,
        ctx: AccountContext,
        consent: OAuthConsent,
    ) -> Result<IssuedAuthorizationCode, PortError> {
        ctx.auth().authorize_human_management()?;
        require_unpinned_project(ctx.auth())?;
        let (protected, browser) = consent.into_parts();
        let browser = validation::browser(browser.expose())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        {
            let mut pre_rtx = self.control.store.read(budget.clone()).await?;
            budget
                .run(
                    self.control.manager_read_allow_space_narrowed(
                        pre_rtx.inner_mut(),
                        ctx.auth(),
                        ctx.auth().principal(),
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget
                .run(pre_rtx.finish(), CommitEffect::NotCommitted)
                .await?;
        }
        let (plaintext, witness) = self
            .keyring
            .open_verified(
                budget.context(ctx.budget.request.clone()),
                EnvelopeAddress::oauth_intent(&protected.id),
                protected.protected.expose(),
            )
            .await?;
        let intent: Intent =
            serde_json::from_str(plaintext.expose()).map_err(|_| invalid_grant())?;
        let now = self.control.clock.now_ms()?;
        if intent.version != 1
            || intent.grant != protected.id
            || intent.user != *ctx.auth().principal()
            || intent.credential != credential(&ctx)?
            || intent.resource != self.metadata.resource
            || intent.expires <= now
            || !token::verify(&intent.browser, &browser)
        {
            return Err(invalid_grant());
        }
        validation::grant_client(ctx.auth().principal(), &intent.client_id)?;
        let client = self
            .client(
                budget.context(ctx.budget.request.clone()),
                &intent.client_id,
            )
            .await?;
        if clients::digest(&client) != intent.client_digest {
            return Err(rejected(OAuthErrorCode::InvalidClient));
        }
        validation::matches_redirect(&clients::info(&client)?.redirect_uris, &intent.redirect)?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        let result=budget.run(async {
            let (_,user)=self.control.manager_allow_space_narrowed(tx.inner_mut(),ctx.auth(),&intent.user).await?;
            let now=self.control.clock.now_ms()?;
            if user.auth_version!=intent.auth_version || intent.expires<=now {return Err(invalid_grant());}
            self.check_spaces(tx.inner_mut(),&ctx,&user,intent.spaces.as_deref(),intent.scope.access,true).await?;
            let current=clients::locked(tx.inner_mut(),&intent.client_id).await?;
            if !client.matches(&current,now) || clients::digest(&current)!=intent.client_digest {return Err(rejected(OAuthErrorCode::InvalidClient));}
            witness.verify(tx.inner_mut()).await?;
            let existing=rows!(tx.inner_mut(),(String,),fetch_optional,"SELECT grant_id FROM oauth_grants WHERE grant_id=$1","SELECT grant_id FROM v1_control.oauth_grants WHERE grant_id=$1";intent.grant.as_str())?;
            if existing.is_some() {return Err(invalid_grant());}
            let grant=TargetRecord::from(OauthGrantsRow {grant_id:intent.grant.to_string(),user_id:user.user_id.clone(),client_id:intent.client_id.clone(),resource_uri:intent.resource.clone(),scope:validation::scope_name(intent.scope.access).into(),ability_write:i64::from(intent.scope.ability_write),
                selected_spaces:intent.spaces.as_ref().map(serde_json::to_string).transpose().map_err(|_|invalid_grant())?,revoked_at:None,revision:1,created_at:now});
            grant.validate()?; grant.insert(tx.inner_mut()).await?;
            let code=token::mint(TokenKind::AuthorizationCode)?;
            let expires=expiry(now,60*1000)?;
            let record=TargetRecord::from(OauthAuthCodesRow {code_hash:code.digest.to_vec(),grant_id:intent.grant.to_string(),client_id:intent.client_id.clone(),redirect_uri:intent.redirect.clone(),resource_uri:intent.resource,code_challenge:intent.challenge,method:"S256".into(),offline_access:i64::from(intent.scope.offline_access),expires_at:expires,used_at:None,created_at:now});
            record.validate()?; record.insert(tx.inner_mut()).await?;
            execute!(tx.inner_mut(),"UPDATE oauth_clients SET activated_at=COALESCE(activated_at,$1),last_seen_at=$1 WHERE client_id=$2","UPDATE v1_control.oauth_clients SET activated_at=COALESCE(activated_at,$1),last_seen_at=$1 WHERE client_id=$2";now,&intent.client_id)?;
            let revision=next(user.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&user.user_id)?;
            Ok(IssuedAuthorizationCode {code:code.secret,redirect_uri:intent.redirect,expires_at_ms:expires,grant:intent.grant})
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
}

use super::super::authority;
use super::{OidcClientAuthentication, OidcService, Provider, denied, http::IdentityHttp};
use crate::{
    auth::token,
    error::unavailable,
    keyring::{EnvelopeAddress, KeyringWitness},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, SecretString},
    error::{CommitEffect, PortError},
    ids::*,
    ports::*,
};
use openidconnect::{
    AuthType, AuthorizationCode, ClientId, ClientSecret, CsrfToken, Nonce, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BoundUser {
    pub user: PrincipalId,
    pub session: AuthSessionId,
    pub auth_version: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Flow {
    version: u8,
    pub transaction: RequestId,
    issuer: String,
    client: String,
    redirect: String,
    config: [u8; 32],
    browser: [u8; 32],
    pub bound: Option<BoundUser>,
    pub expires: i64,
    created: i64,
    nonce: String,
    verifier: String,
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.nonce.zeroize();
        self.verifier.zeroize();
    }
}
async fn check_bound(
    user: &UsersRow,
    tx: &mut Transaction,
    bound: &BoundUser,
    now: i64,
    recent: bool,
) -> Result<(), PortError> {
    let session = authority::session(tx, bound.session.as_str()).await?;
    authority::live_session(&session, user, now)?;
    if user.auth_version != bound.auth_version {
        return Err(denied());
    }
    if recent && session.created_at < now.saturating_sub(5 * 60 * 1000) {
        // Explicit step-up failure for a valid session older than 5 minutes.
        return Err(DomainError::AccessDenied.into());
    }
    Ok(())
}
async fn live_bound(
    tx: &mut Transaction,
    bound: &BoundUser,
    now: i64,
    recent: bool,
) -> Result<(), PortError> {
    let user = authority::user(tx, bound.user.as_str()).await?;
    check_bound(&user, tx, bound, now, recent).await
}
async fn live_bound_read(
    tx: &mut Transaction,
    bound: &BoundUser,
    now: i64,
    recent: bool,
) -> Result<(), PortError> {
    let user = authority::user_read(tx, bound.user.as_str()).await?;
    check_bound(&user, tx, bound, now, recent).await
}
struct Confidential {
    row: CredentialsRow,
    secret: SecretString,
    witness: KeyringWitness,
}
impl Confidential {
    async fn verify(&self, tx: &mut Transaction) -> Result<(), PortError> {
        let row=rows!(tx,CredentialsRow,fetch_optional,"SELECT * FROM credentials WHERE id=$1","SELECT * FROM v1_control.credentials WHERE id=$1 FOR SHARE";&self.row.id)?.ok_or_else(denied)?;
        if row.kind != "oidc-client-secret"
            || row.disabled_at.is_some()
            || row.runtime_epoch != self.row.runtime_epoch
            || row.secret != self.row.secret
        {
            return Err(denied());
        }
        self.witness.verify(tx).await
    }
}
impl OidcService {
    pub(super) async fn begin(
        &self,
        call: CallBudget,
        ctx: Option<AccountContext>,
        request: BeginOidcLogin,
    ) -> Result<OidcAuthorization, PortError> {
        // Validate configured issuer, browser binding and link authority BEFORE
        // consuming rate-limit or concurrency permits.
        let provider = self.provider(&request.issuer)?;
        let browser = super::super::oauth::validation::browser(request.browser_binding.expose())?;
        let budget = OperationBudget::new(call.clone());
        let bound = if let Some(ctx) = &ctx {
            ctx.auth().authorize_human_management()?;
            let Some(AuthenticatedCredential::Session(id)) = ctx.auth().credential() else {
                return Err(denied());
            };
            let mut rtx = self.control.store.read(budget.clone()).await?;
            let bound = budget
                .run(
                    async {
                        let (_, user) = self
                            .control
                            .manager_read(rtx.inner_mut(), ctx.auth(), ctx.auth().principal())
                            .await?;
                        let bound = BoundUser {
                            user: ctx.auth().principal().clone(),
                            session: id.clone(),
                            auth_version: user.auth_version,
                        };
                        live_bound_read(
                            rtx.inner_mut(),
                            &bound,
                            self.control.clock.now_ms()?,
                            true,
                        )
                        .await?;
                        Ok(bound)
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
            Some(bound)
        } else {
            None
        };
        let _admission = self.admit()?;
        provider.admit_begin(bound.is_some())?;
        let metadata = self.metadata(&provider, &budget, &call.request).await?;
        let now = self.control.clock.now_ms()?;
        let flow = Flow {
            version: 1,
            transaction: RequestId::from_bytes(token::random()?),
            issuer: provider.config.issuer.clone(),
            client: provider.config.client_id.clone(),
            redirect: provider.config.redirect_uri.clone(),
            config: provider.digest,
            browser,
            bound,
            expires: now.checked_add(10 * 60 * 1000).ok_or_else(denied)?,
            created: now,
            nonce: URL_SAFE_NO_PAD.encode(token::random::<32>()?),
            verifier: URL_SAFE_NO_PAD.encode(token::random::<32>()?),
        };
        let state = SecretString::new(URL_SAFE_NO_PAD.encode(token::random::<32>()?));
        let client =
            CoreClient::from_provider_metadata(metadata, ClientId::new(flow.client.clone()), None)
                .set_redirect_uri(RedirectUrl::new(flow.redirect.clone()).map_err(|_| denied())?);
        let verifier = PkceCodeVerifier::new(flow.verifier.clone());
        let challenge = PkceCodeChallenge::from_code_verifier_sha256(&verifier);
        let sent_state = CsrfToken::new(state.expose().into());
        let sent_nonce = Nonce::new(flow.nonce.clone());
        let (url, _, _) = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                move || sent_state,
                move || sent_nonce,
            )
            .add_scope(Scope::new("profile".into()))
            .add_scope(Scope::new("email".into()))
            .set_pkce_challenge(challenge)
            .url();
        let plaintext = SecretString::new(serde_json::to_string(&flow).map_err(|_| denied())?);
        let sealed = self
            .keyring
            .seal(
                budget.context(call.request.clone()),
                EnvelopeAddress::oidc_context(&flow.transaction),
                plaintext,
            )
            .await?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        budget.run(async {
            rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT singleton FROM v1_storage_epoch WHERE singleton=1","SELECT singleton FROM v1_control.v1_storage_epoch WHERE singleton=1 FOR UPDATE";)?;
            let now=self.control.clock.now_ms()?;
            if flow.expires<=now {return Err(denied());}
            if let Some(bound)=&flow.bound {live_bound(tx.inner_mut(),bound,now,true).await?;}
            sealed.witness.verify(tx.inner_mut()).await?;
            execute!(tx.inner_mut(),"DELETE FROM oidc_transactions WHERE expires_at<=$1","DELETE FROM v1_control.oidc_transactions WHERE expires_at<=$1";now)?;
            let (count,)=rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT COUNT(*) FROM oidc_transactions","SELECT COUNT(*) FROM v1_control.oidc_transactions";)?;
            if count>=4096 {return Err(super::limited());}
            let record=TargetRecord::from(OidcTransactionsRow {transaction_id:flow.transaction.to_string(),state_hash:token::digest(state.expose().as_bytes()).to_vec(),nonce_hash:token::digest(flow.nonce.as_bytes()).to_vec(),flow_context_hash:token::digest(sealed.encrypted.as_bytes()).to_vec(),key_id:sealed.witness.key.to_string(),issuer:flow.issuer.clone(),client_id:flow.client.clone(),redirect_uri:flow.redirect.clone(),purpose:if flow.bound.is_some() {"link"} else {"login"}.into(),bound_user:flow.bound.as_ref().map(|b|b.user.to_string()),browser_binding_hash:browser.to_vec(),expires_at:flow.expires,consumed_at:None,created_at:flow.created});
            record.validate()?;record.insert(tx.inner_mut()).await
        },CommitEffect::NotCommitted).await?;
        budget.commit_tx(tx).await?;
        Ok(OidcAuthorization {
            authorization_url: SecretString::new(url.to_string()),
            flow: ProtectedOidcFlow {
                transaction: flow.transaction.clone(),
                context: SecretString::new(sealed.encrypted),
            },
            expires_at_ms: flow.expires,
        })
    }
    async fn confidential(
        &self,
        provider: &Provider,
        budget: &OperationBudget,
        request: &RequestId,
    ) -> Result<Option<Confidential>, PortError> {
        let id = match &provider.config.authentication {
            OidcClientAuthentication::Public => return Ok(None),
            OidcClientAuthentication::SecretBasic { credential }
            | OidcClientAuthentication::SecretPost { credential } => credential,
        };
        let row=budget.run(async {read_rows!(&self.control.store.backend,CredentialsRow,fetch_optional,"SELECT * FROM credentials WHERE id=$1","SELECT * FROM v1_control.credentials WHERE id=$1";id.as_str())?.ok_or_else(denied)},CommitEffect::NotCommitted).await?;
        if row.disabled_at.is_some() || row.kind != "oidc-client-secret" {
            return Err(denied());
        }
        let (secret, witness) = self
            .keyring
            .open_verified(
                budget.context(request.clone()),
                EnvelopeAddress::credential(id),
                &row.secret,
            )
            .await?;
        if secret.expose().is_empty() || secret.expose().len() > 8192 {
            return Err(denied());
        }
        Ok(Some(Confidential {
            row,
            secret,
            witness,
        }))
    }
    pub(super) async fn finish(
        &self,
        call: CallBudget,
        request: FinishOidcCallback,
    ) -> Result<OidcOutcome, PortError> {
        if request.code.expose().is_empty()
            || request.code.expose().len() > 8192
            || request.state.expose().len() != 43
        {
            return Err(denied());
        }
        let browser = super::super::oauth::validation::browser(request.browser_binding.expose())?;
        let _admission = self.admit()?;
        let budget = OperationBudget::new(call.clone());
        let (plaintext, witness) = self
            .keyring
            .open_verified(
                budget.context(call.request.clone()),
                EnvelopeAddress::oidc_context(&request.flow.transaction),
                request.flow.context.expose(),
            )
            .await?;
        let flow: Flow = serde_json::from_str(plaintext.expose()).map_err(|_| denied())?;
        let provider = self.provider(&flow.issuer)?;
        let now = self.control.clock.now_ms()?;
        if flow.version != 1
            || flow.transaction != request.flow.transaction
            || flow.config != provider.digest
            || flow.client != provider.config.client_id
            || flow.redirect != provider.config.redirect_uri
            || flow.expires <= now
            || !token::verify(&flow.browser, &browser)
        {
            return Err(denied());
        }
        let metadata = self.metadata(&provider, &budget, &call.request).await?;
        let confidential = self.confidential(&provider, &budget, &call.request).await?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        budget.run(async {
            if let Some(bound)=&flow.bound {live_bound(tx.inner_mut(),bound,self.control.clock.now_ms()?,false).await?;}
            let row=rows!(tx.inner_mut(),OidcTransactionsRow,fetch_optional,"SELECT * FROM oidc_transactions WHERE transaction_id=$1","SELECT * FROM v1_control.oidc_transactions WHERE transaction_id=$1 FOR UPDATE";flow.transaction.as_str())?.ok_or_else(denied)?;
            let now=self.control.clock.now_ms()?;
            if row.consumed_at.is_some() || row.expires_at<=now || row.expires_at!=flow.expires || row.created_at!=flow.created || row.issuer!=flow.issuer || row.client_id!=flow.client || row.redirect_uri!=flow.redirect
                || row.bound_user.as_deref()!=flow.bound.as_ref().map(|b|b.user.as_str()) || row.purpose!=if flow.bound.is_some() {"link"} else {"login"} || row.key_id!=witness.key.as_str() {return Err(denied());}
            for (stored,actual) in [(&row.state_hash,token::digest(request.state.expose().as_bytes())),(&row.nonce_hash,token::digest(flow.nonce.as_bytes())),(&row.flow_context_hash,token::digest(request.flow.context.expose().as_bytes())),(&row.browser_binding_hash,browser)] {
                authority::check_digest(stored,&actual)?;
            }
            witness.verify(tx.inner_mut()).await?;
            if let Some(confidential)=&confidential {confidential.verify(tx.inner_mut()).await?;}
            let changed=execute!(tx.inner_mut(),"UPDATE oidc_transactions SET consumed_at=$1 WHERE transaction_id=$2 AND consumed_at IS NULL AND expires_at>$1","UPDATE v1_control.oidc_transactions SET consumed_at=$1 WHERE transaction_id=$2 AND consumed_at IS NULL AND expires_at>$1";now,flow.transaction.as_str())?;
            if changed!=1 {return Err(denied());}Ok(())
        },CommitEffect::NotCommitted).await?;
        // Claim is durable before the only token exchange. A lost response or
        // cancelled caller must start a new flow; there is no exchange retry.
        budget.commit_tx(tx).await?;
        let client = CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(flow.client.clone()),
            confidential
                .as_ref()
                .map(|c| ClientSecret::new(c.secret.expose().into())),
        )
        .set_redirect_uri(RedirectUrl::new(flow.redirect.clone()).map_err(|_| denied())?)
        .set_auth_type(match provider.config.authentication {
            OidcClientAuthentication::SecretPost { .. } => AuthType::RequestBody,
            _ => AuthType::BasicAuth,
        });
        let http = IdentityHttp {
            outbound: self.outbound.clone(),
            issuer: flow.issuer.clone(),
            budget: budget.clone(),
            request: call.request.clone(),
        };
        let token = client
            .exchange_code(AuthorizationCode::new(request.code.expose().into()))
            .map_err(|_| denied())?
            .set_pkce_verifier(PkceCodeVerifier::new(flow.verifier.clone()))
            .request_async(&http)
            .await
            .map_err(|_| unavailable("control OIDC token exchange", CommitEffect::Unknown))?;
        let identity = self
            .verify_identity(
                &provider,
                &budget,
                &call.request,
                token.id_token().ok_or_else(denied)?,
                &flow.nonce,
                flow.created,
            )
            .await?;
        self.complete_identity(&budget, &flow, identity).await
    }
}

use super::{AuthenticationMode, ControlService, authority::*};
use crate::{
    auth::token::{self, TokenKind},
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    auth::*,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::*,
};
use std::collections::{BTreeMap, BTreeSet};

const TOUCH_WINDOW_MS: i64 = 60 * 60 * 1000;

pub(super) fn selected(
    value: Option<&str>,
    max: u16,
) -> Result<Option<BTreeSet<SpaceId>>, PortError> {
    value
        .map(|value| {
            if value.len() > usize::from(max) * 48 + 2 {
                return Err(denied());
            }
            let ids: Vec<SpaceId> = serde_json::from_str(value).map_err(|_| denied())?;
            if ids.len() > usize::from(max) {
                return Err(denied());
            }
            Ok(ids.into_iter().collect())
        })
        .transpose()
}
fn restrict(
    context: &EngineAuthContext,
    scope: &str,
    selected: Option<BTreeSet<SpaceId>>,
) -> Result<BTreeMap<SpaceId, SpaceGrant>, PortError> {
    if !matches!(scope, "read" | "write") {
        return Err(denied());
    }
    Ok(context
        .spaces()
        .iter()
        .filter(|(id, _)| selected.as_ref().is_none_or(|ids| ids.contains(*id)))
        .map(|(id, grant)| {
            let mut grant = grant.clone();
            if scope == "read" {
                grant.write_classes.clear();
            }
            (id.clone(), grant)
        })
        .collect())
}
impl ControlService {
    /// Acquire active revocation registration under the same authority locks
    /// used for synchronous effects. A runner drops it after stopping work.
    pub async fn register_archive_job(
        &self,
        budget: CallBudget,
        delegation: &JobDelegation,
    ) -> Result<(SpaceContext, Box<dyn RevocationLease>), PortError> {
        let operation = OperationBudget::new(budget.clone());
        let mut tx = self.store.write(operation.clone()).await?;
        let credential = delegation.credential_reference();
        let (auth, lease) = operation
            .run(
                async {
                    let current_user =
                        user(tx.inner_mut(), delegation.principal().as_str()).await?;
                    let current = self
                        .credential_context(
                            tx.inner_mut(),
                            &current_user,
                            credential.clone(),
                            false,
                            false,
                            true,
                            None,
                        )
                        .await?;
                    let auth = delegation.limit(&current)?;
                    let scope = delegation.scope();
                    let mut selectors = vec![
                        RevocationSelector::Principal(delegation.principal().clone()),
                        RevocationSelector::Grant(delegation.grant().clone()),
                        RevocationSelector::Space(scope.space_id.clone()),
                        RevocationSelector::Membership {
                            space: scope.space_id.clone(),
                            principal: delegation.principal().clone(),
                        },
                    ];
                    match credential {
                        AuthenticatedCredential::Session(id) => {
                            selectors.push(RevocationSelector::Session(id));
                        }
                        AuthenticatedCredential::OAuth {
                            token,
                            grant,
                            family,
                        } => {
                            selectors.push(RevocationSelector::OAuthAccess(token));
                            selectors.push(RevocationSelector::OAuthGrant(grant));
                            selectors.extend(family.map(RevocationSelector::OAuthFamily));
                        }
                        _ => {}
                    }
                    let lease = self
                        .revoker
                        .register_content_job(
                            MaintenanceContext {
                                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                                budget: operation.context(budget.request.clone()),
                            },
                            selectors,
                            budget.cancellation.clone(),
                        )
                        .await?;
                    lease.check()?;
                    Ok((auth, lease))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        operation.run(tx.commit(), CommitEffect::Unknown).await?;
        let ctx = SpaceContext::new(auth, delegation.scope().clone(), budget)?;
        Ok((ctx, lease))
    }

    /// Refresh the delegation without acquiring a new registry lease. This is
    /// also used to observe natural credential expiration while a job runs.
    pub async fn refresh_archive_job(
        &self,
        budget: CallBudget,
        delegation: &JobDelegation,
    ) -> Result<SpaceContext, PortError> {
        let operation = OperationBudget::new(budget.clone());
        let mut tx = self.store.read(operation.clone()).await?;
        let auth = operation
            .run(
                async {
                    let current_user =
                        user_read(tx.inner_mut(), delegation.principal().as_str()).await?;
                    let current = self
                        .credential_context(
                            tx.inner_mut(),
                            &current_user,
                            delegation.credential_reference(),
                            false,
                            false,
                            false,
                            None,
                        )
                        .await?;
                    delegation.limit(&current).map_err(Into::into)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        tx.finish().await?;
        SpaceContext::new(auth, delegation.scope().clone(), budget).map_err(Into::into)
    }

    pub(super) async fn revalidate(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
    ) -> Result<EngineAuthContext, PortError> {
        self.revalidate_with_keeper(tx, auth, None).await
    }
    pub(super) async fn revalidate_with_keeper(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        keeper: Option<&super::schedules::PrecheckedKeeper>,
    ) -> Result<EngineAuthContext, PortError> {
        let current_user = user(tx, auth.principal().as_str()).await?;
        let credential = auth.credential().cloned().ok_or_else(denied)?;
        let current = self
            .credential_context(
                tx,
                &current_user,
                credential,
                auth.human_management(),
                auth.has_cap(Cap::AbilityWrite),
                true,
                keeper,
            )
            .await?;
        auth.intersect_current(&current).map_err(Into::into)
    }
    pub(super) async fn revalidate_read(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
    ) -> Result<EngineAuthContext, PortError> {
        self.revalidate_read_with_keeper(tx, auth, None).await
    }
    pub(super) async fn revalidate_read_with_keeper(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        keeper: Option<&super::schedules::PrecheckedKeeper>,
    ) -> Result<EngineAuthContext, PortError> {
        let current_user = user_read(tx, auth.principal().as_str()).await?;
        let credential = auth.credential().cloned().ok_or_else(denied)?;
        let current = self
            .credential_context(
                tx,
                &current_user,
                credential,
                auth.human_management(),
                auth.has_cap(Cap::AbilityWrite),
                false,
                keeper,
            )
            .await?;
        auth.intersect_current(&current).map_err(Into::into)
    }
    pub(super) async fn open_revalidated_read(
        &self,
        budget: &OperationBudget,
        request: &RequestId,
        auth: &EngineAuthContext,
    ) -> Result<(crate::store::ReadTransaction, EngineAuthContext), PortError> {
        let keeper = self.precheck_keeper_catalog(auth, budget, request).await?;
        let mut rtx = self.store.read(budget.clone()).await?;
        match budget
            .run(
                self.revalidate_read_with_keeper(rtx.inner_mut(), auth, keeper.as_ref()),
                CommitEffect::NotCommitted,
            )
            .await
        {
            Ok(revalidated) => Ok((rtx, revalidated)),
            Err(err) => {
                let _ = rtx.finish().await;
                Err(err)
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn credential_context(
        &self,
        tx: &mut Transaction,
        current_user: &UsersRow,
        credential: AuthenticatedCredential,
        human_management: bool,
        ability_write: bool,
        lock: bool,
        keeper: Option<&super::schedules::PrecheckedKeeper>,
    ) -> Result<EngineAuthContext, PortError> {
        let now = self.clock.now_ms()?;
        match &credential {
            AuthenticatedCredential::ScheduledRun { .. } => {
                self.scheduled_context(tx, current_user, credential, lock, keeper)
                    .await
            }
            AuthenticatedCredential::Session(id) => {
                live_session(&session(tx, id.as_str()).await?, current_user, now)?;
                let source = grant("session", id.as_str());
                self.human_context(
                    tx,
                    current_user,
                    credential,
                    source,
                    human_management,
                    ability_write,
                    lock,
                )
                .await
            }
            AuthenticatedCredential::TrustedNone => {
                if !matches!(&self.config.authentication,AuthenticationMode::TrustedNone{owner} if owner.as_str()==current_user.user_id)
                {
                    return Err(denied());
                }
                self.human_context(
                    tx,
                    current_user,
                    credential,
                    grant("none", &current_user.user_id),
                    human_management,
                    ability_write,
                    lock,
                )
                .await
            }
            AuthenticatedCredential::Pat(id) => {
                let current = pat(tx, id.as_str()).await?;
                if current.user_id != current_user.user_id
                    || current.revoked_at.is_some()
                    || current.expires_at.is_some_and(|time| time <= now)
                {
                    return Err(denied());
                }
                let source = grant("pat", id.as_str());
                let human = self
                    .human_context(tx, current_user, credential, source, false, false, lock)
                    .await?;
                let wanted = restrict(
                    &human,
                    &current.scope,
                    selected(
                        current.selected_spaces.as_deref(),
                        self.config.max_auth_spaces,
                    )?,
                )?;
                human.for_pat(wanted).map_err(Into::into)
            }
            AuthenticatedCredential::OAuth {
                token,
                grant: grant_id,
                family,
            } => {
                let current = access(tx, token.as_str()).await?;
                let consent = oauth_grant(tx, &current.grant_id).await?;
                if current.grant_id != grant_id.as_str()
                    || current.family_id.as_deref() != family.as_ref().map(|id| id.as_str())
                    || consent.user_id != current_user.user_id
                    || current.revoked_at.is_some()
                    || current.expires_at <= now
                    || consent.revoked_at.is_some()
                    || current.resource_uri != self.config.resource_uri
                    || consent.resource_uri != self.config.resource_uri
                {
                    return Err(denied());
                }
                if let Some(id) = family {
                    let family = if lock {
                        rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1 FOR SHARE";id.as_str())?.ok_or_else(denied)?
                    } else {
                        rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1";id.as_str())?.ok_or_else(denied)?
                    };
                    if family.grant_id != consent.grant_id || family.revoked_at.is_some() {
                        return Err(denied());
                    }
                }
                let source = grant("oauth", &consent.grant_id);
                let human = self
                    .human_context(
                        tx,
                        current_user,
                        credential,
                        source.clone(),
                        false,
                        false,
                        lock,
                    )
                    .await?;
                let consent_context = human.for_oauth(
                    source.clone(),
                    restrict(
                        &human,
                        &consent.scope,
                        selected(
                            consent.selected_spaces.as_deref(),
                            self.config.max_auth_spaces,
                        )?,
                    )?,
                )?;
                let wanted = restrict(
                    &consent_context,
                    &current.scope,
                    selected(
                        current.selected_spaces.as_deref(),
                        self.config.max_auth_spaces,
                    )?,
                )?;
                consent_context
                    .for_oauth(source, wanted)
                    .map_err(Into::into)
            }
        }
    }
    pub async fn resolve(&self, ctx: PreAuthContext) -> Result<EngineAuthContext, PortError> {
        let budget = OperationBudget::new(ctx.budget);
        let kind = match ctx.evidence.kind() {
            AuthEvidenceKind::Session => TokenKind::Session,
            AuthEvidenceKind::Pat => TokenKind::Pat,
            AuthEvidenceKind::OAuth => TokenKind::Access,
            AuthEvidenceKind::Oidc => return Err(denied()),
        };
        let human_management = ctx.evidence.human_management();
        let ability_write = human_management && ctx.evidence.ability_write();
        let (id, digest) = token::parse(kind, ctx.evidence.secret()).map_err(|_| denied())?;

        // Fast path: consistent read-only resolution with zero writer contention
        // when the credential's hourly `last_used_at` window has not elapsed.
        let mut rtx = self.store.read(budget.clone()).await?;
        let (auth, needs_touch) = budget
            .run(
                self.resolve_evidence_read(
                    rtx.inner_mut(),
                    kind,
                    id,
                    digest,
                    human_management,
                    ability_write,
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        if !needs_touch {
            return Ok(auth);
        }

        let mut tx = self.store.write(budget.clone()).await?;
        let auth = budget
            .run(
                self.resolve_evidence_write(
                    tx.inner_mut(),
                    kind,
                    id,
                    digest,
                    human_management,
                    ability_write,
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(auth)
    }
    async fn resolve_evidence_read(
        &self,
        tx: &mut Transaction,
        kind: TokenKind,
        id: Option<&str>,
        digest: [u8; 32],
        human_management: bool,
        ability_write: bool,
    ) -> Result<(EngineAuthContext, bool), PortError> {
        let now = self.clock.now_ms()?;
        match kind {
            TokenKind::Session => {
                let current = rows!(tx, SessionsRow, fetch_optional,
                    "SELECT * FROM sessions WHERE token_hash=$1",
                    "SELECT * FROM v1_control.sessions WHERE token_hash=$1"; digest.as_slice())?
                .ok_or_else(denied)?;
                check_digest(&current.token_hash, &digest)?;
                let current_user = user_read(tx, &current.user_id).await?;
                let credential =
                    AuthenticatedCredential::Session(AuthSessionId::parse(&current.session_id)?);
                let auth = self
                    .credential_context(
                        tx,
                        &current_user,
                        credential,
                        human_management,
                        ability_write,
                        false,
                        None,
                    )
                    .await?;
                let needs_touch = current.last_used_at <= now.saturating_sub(TOUCH_WINDOW_MS);
                Ok((auth, needs_touch))
            }
            TokenKind::Pat => {
                let id = id.ok_or_else(denied)?;
                let current = pat(tx, id).await?;
                check_digest(&current.secret_hash, &digest)?;
                let current_user = user_read(tx, &current.user_id).await?;
                let auth = self
                    .credential_context(
                        tx,
                        &current_user,
                        AuthenticatedCredential::Pat(CredentialTokenId::parse(id)?),
                        false,
                        false,
                        false,
                        None,
                    )
                    .await?;
                let needs_touch = current
                    .last_used_at
                    .is_none_or(|time| time <= now.saturating_sub(TOUCH_WINDOW_MS));
                Ok((auth, needs_touch))
            }
            TokenKind::Access => {
                let id = id.ok_or_else(denied)?;
                let current = access(tx, id).await?;
                check_digest(&current.token_hash, &digest)?;
                let observed_grant = oauth_grant(tx, &current.grant_id).await?;
                let current_user = user_read(tx, &observed_grant.user_id).await?;
                let credential = AuthenticatedCredential::OAuth {
                    token: CredentialTokenId::parse(id)?,
                    grant: OAuthGrantId::parse(&current.grant_id)?,
                    family: current
                        .family_id
                        .as_deref()
                        .map(OAuthFamilyId::parse)
                        .transpose()?,
                };
                let auth = self
                    .credential_context(tx, &current_user, credential, false, false, false, None)
                    .await?;
                let needs_touch = current
                    .last_used_at
                    .is_none_or(|time| time <= now.saturating_sub(TOUCH_WINDOW_MS));
                Ok((auth, needs_touch))
            }
            _ => Err(denied()),
        }
    }
    async fn resolve_evidence_write(
        &self,
        tx: &mut Transaction,
        kind: TokenKind,
        id: Option<&str>,
        digest: [u8; 32],
        human_management: bool,
        ability_write: bool,
    ) -> Result<EngineAuthContext, PortError> {
        match kind {
            TokenKind::Session => {
                let observed = rows!(tx, SessionsRow, fetch_optional,
                    "SELECT * FROM sessions WHERE token_hash=$1",
                    "SELECT * FROM v1_control.sessions WHERE token_hash=$1"; digest.as_slice())?
                .ok_or_else(denied)?;
                let current_user = user(tx, &observed.user_id).await?;
                let current = session(tx, &observed.session_id).await?;
                check_digest(&current.token_hash, &digest)?;
                let credential =
                    AuthenticatedCredential::Session(AuthSessionId::parse(&current.session_id)?);
                let auth = self
                    .credential_context(
                        tx,
                        &current_user,
                        credential,
                        human_management,
                        ability_write,
                        true,
                        None,
                    )
                    .await?;
                let now = self.clock.now_ms()?;
                if current.last_used_at <= now.saturating_sub(TOUCH_WINDOW_MS) {
                    let expiry = now
                        .checked_add(30 * 24 * 60 * 60 * 1000)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    execute!(tx,
                        "UPDATE sessions SET last_used_at=$1,expires_at=$2 WHERE session_id=$3 AND revoked_at IS NULL AND expires_at>$1",
                        "UPDATE v1_control.sessions SET last_used_at=$1,expires_at=$2 WHERE session_id=$3 AND revoked_at IS NULL AND expires_at>$1"; now, expiry, &current.session_id)?;
                }
                Ok(auth)
            }
            TokenKind::Pat => {
                let id = id.ok_or_else(denied)?;
                let observed = pat(tx, id).await?;
                let current_user = user(tx, &observed.user_id).await?;
                let current = pat(tx, id).await?;
                check_digest(&current.secret_hash, &digest)?;
                let auth = self
                    .credential_context(
                        tx,
                        &current_user,
                        AuthenticatedCredential::Pat(CredentialTokenId::parse(id)?),
                        false,
                        false,
                        true,
                        None,
                    )
                    .await?;
                let now = self.clock.now_ms()?;
                if current
                    .last_used_at
                    .is_none_or(|time| time <= now.saturating_sub(TOUCH_WINDOW_MS))
                {
                    execute!(tx,"UPDATE pats SET last_used_at=$1 WHERE token_id=$2","UPDATE v1_control.pats SET last_used_at=$1 WHERE token_id=$2"; now, id)?;
                }
                Ok(auth)
            }
            TokenKind::Access => {
                let id = id.ok_or_else(denied)?;
                let observed = access(tx, id).await?;
                let observed_grant = oauth_grant(tx, &observed.grant_id).await?;
                let current_user = user(tx, &observed_grant.user_id).await?;
                let current = access(tx, id).await?;
                check_digest(&current.token_hash, &digest)?;
                let credential = AuthenticatedCredential::OAuth {
                    token: CredentialTokenId::parse(id)?,
                    grant: OAuthGrantId::parse(&current.grant_id)?,
                    family: current
                        .family_id
                        .as_deref()
                        .map(OAuthFamilyId::parse)
                        .transpose()?,
                };
                let auth = self
                    .credential_context(tx, &current_user, credential, false, false, true, None)
                    .await?;
                let now = self.clock.now_ms()?;
                if current
                    .last_used_at
                    .is_none_or(|time| time <= now.saturating_sub(TOUCH_WINDOW_MS))
                {
                    execute!(tx,"UPDATE oauth_access_tokens SET last_used_at=$1 WHERE token_id=$2","UPDATE v1_control.oauth_access_tokens SET last_used_at=$1 WHERE token_id=$2"; now, id)?;
                }
                Ok(auth)
            }
            _ => Err(denied()),
        }
    }
    pub async fn trusted_none(
        &self,
        perimeter: PerimeterAttestation,
        ctx: CallBudget,
    ) -> Result<EngineAuthContext, PortError> {
        let AuthenticationMode::TrustedNone { owner } = &self.config.authentication else {
            return Err(denied());
        };
        let budget = OperationBudget::new(ctx);
        let mut rtx = self.store.read(budget.clone()).await?;
        let auth = budget
            .run(
                async {
                    let current = user_read(rtx.inner_mut(), owner.as_str()).await?;
                    self.human_context(
                        rtx.inner_mut(),
                        &current,
                        AuthenticatedCredential::TrustedNone,
                        grant("none", owner.as_str()),
                        perimeter.human_management(),
                        perimeter.human_management() && perimeter.ability_write(),
                        false,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        Ok(auth)
    }
    pub async fn logout(&self, ctx: PreAuthContext) -> Result<(), PortError> {
        if ctx.evidence.kind() != AuthEvidenceKind::Session {
            return Err(denied());
        }
        if !ctx.evidence.human_management() {
            return Err(notarium_core::DomainError::AccessDenied.into());
        }
        let (_, digest) =
            token::parse(TokenKind::Session, ctx.evidence.secret()).map_err(|_| denied())?;
        let budget = OperationBudget::new(ctx.budget);
        let observed=budget.run(async{read_rows!(&self.store.backend,SessionsRow,fetch_optional,"SELECT * FROM sessions WHERE token_hash=$1","SELECT * FROM v1_control.sessions WHERE token_hash=$1";digest.as_slice())?.ok_or_else(denied)},CommitEffect::NotCommitted).await?;
        let event_digest =
            token::digest(format!("notarium:logout-event:v1:{}", observed.session_id).as_bytes());
        let event = RequestId::from_bytes(event_digest[..16].try_into().expect("digest prefix"));
        let mut tx = self.store.write(budget.clone()).await?;
        budget.run(async {
            let current_user=user(tx.inner_mut(),&observed.user_id).await?;
            let current=session(tx.inner_mut(),&observed.session_id).await?;
            check_digest(&current.token_hash,&digest)?;
            if current.revoked_at.is_none() {
                let now=self.clock.now_ms()?;
                live_session(&current,&current_user,now)?;
                execute!(tx.inner_mut(),"UPDATE sessions SET revoked_at=$1 WHERE session_id=$2","UPDATE v1_control.sessions SET revoked_at=$1 WHERE session_id=$2";now,&current.session_id)?;
                super::outbox::enqueue_at(tx.inner_mut(),event.clone(),RevocationSelector::Session(AuthSessionId::parse(&current.session_id)?),RevocationReason::Logout,current.auth_version,now).await?;
            } else {
                // A revoked credential can resume only its own exact logout.
                rows!(tx.inner_mut(),RevocationEventsRow,fetch_optional,"SELECT * FROM revocation_events WHERE event_id=$1","SELECT * FROM v1_control.revocation_events WHERE event_id=$1";event.as_str())?.ok_or_else(denied)?;
            }
            Ok(())
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, std::slice::from_ref(&event))
            .await?;
        self.flush_event(&budget, &event).await
    }
}
pub(super) async fn pat(tx: &mut Transaction, id: &str) -> Result<PatsRow, PortError> {
    rows!(tx,PatsRow,fetch_optional,"SELECT * FROM pats WHERE token_id=$1","SELECT * FROM v1_control.pats WHERE token_id=$1";id)?.ok_or_else(denied)
}
async fn access(tx: &mut Transaction, id: &str) -> Result<OauthAccessTokensRow, PortError> {
    rows!(tx,OauthAccessTokensRow,fetch_optional,"SELECT * FROM oauth_access_tokens WHERE token_id=$1","SELECT * FROM v1_control.oauth_access_tokens WHERE token_id=$1";id)?.ok_or_else(denied)
}
async fn oauth_grant(tx: &mut Transaction, id: &str) -> Result<OauthGrantsRow, PortError> {
    rows!(tx,OauthGrantsRow,fetch_optional,"SELECT * FROM oauth_grants WHERE grant_id=$1","SELECT * FROM v1_control.oauth_grants WHERE grant_id=$1";id)?.ok_or_else(denied)
}

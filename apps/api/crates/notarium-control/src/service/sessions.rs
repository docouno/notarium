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
use std::collections::BTreeSet;

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
fn bearer_scope(value: &str) -> Result<BearerScope, PortError> {
    match value {
        "read" => Ok(BearerScope::Read),
        "write" => Ok(BearerScope::Write),
        _ => Err(denied()),
    }
}
fn is_search_indexing(auth: &EngineAuthContext) -> bool {
    auth.kind() == &PrincipalKind::SearchIndexing
        || matches!(
            auth.credential(),
            Some(AuthenticatedCredential::SearchIndexing { .. })
        )
}

/// Credential validation precedes membership queries. Write callers hold the
/// owner lock; authoring can then take exclusive Space locks in stable order.
pub(super) enum CredentialAuthority {
    Human {
        credential: AuthenticatedCredential,
        source: GrantId,
    },
    Bearer {
        credential: BearerCredential,
        source: GrantId,
        scope: BearerScope,
        ability_write: bool,
        selected_spaces: Option<BTreeSet<SpaceId>>,
    },
}

impl CredentialAuthority {
    pub(super) fn authorize_ability_space(
        &self,
        auth: &EngineAuthContext,
        space: &SpaceId,
    ) -> Result<(), PortError> {
        auth.authorize_ability_mutation()?;
        let allowed = match self {
            Self::Human { source, .. } => source == auth.grant() && auth.human_management(),
            Self::Bearer {
                source,
                scope,
                ability_write,
                selected_spaces,
                ..
            } => {
                source == auth.grant()
                    && *scope == BearerScope::Write
                    && *ability_write
                    && selected_spaces
                        .as_ref()
                        .is_none_or(|ids| ids.contains(space))
            }
        };
        if !allowed {
            return Err(notarium_core::DomainError::AbilityWriteForbidden.into());
        }
        Ok(())
    }
}

pub(super) async fn credential_expiry(
    tx: &mut Transaction,
    credential: &AuthenticatedCredential,
) -> Result<Option<i64>, PortError> {
    match credential {
        AuthenticatedCredential::Session(id) => Ok(Some(rows!(
            tx, (i64,), fetch_one,
            "SELECT expires_at FROM sessions WHERE session_id=$1",
            "SELECT expires_at FROM v1_control.sessions WHERE session_id=$1"; id.as_str()
        )?.0)),
        AuthenticatedCredential::Pat(id) => Ok(rows!(
            tx, (Option<i64>,), fetch_one,
            "SELECT expires_at FROM pats WHERE token_id=$1",
            "SELECT expires_at FROM v1_control.pats WHERE token_id=$1"; id.as_str()
        )?.0),
        AuthenticatedCredential::OAuth { token, .. } => Ok(Some(rows!(
            tx, (i64,), fetch_one,
            "SELECT expires_at FROM oauth_access_tokens WHERE token_id=$1",
            "SELECT expires_at FROM v1_control.oauth_access_tokens WHERE token_id=$1"; token.as_str()
        )?.0)),
        AuthenticatedCredential::ScheduledRun { run, .. } => Ok(Some(rows!(
            tx, (i64,), fetch_one,
            "SELECT expires_at FROM agent_schedule_runs WHERE run_id=$1",
            "SELECT expires_at FROM v1_control.agent_schedule_runs WHERE run_id=$1"; run.as_str()
        )?.0)),
        AuthenticatedCredential::TrustedNone | AuthenticatedCredential::SearchIndexing { .. } => Ok(None),
    }
}

impl ControlService {
    pub(super) async fn revalidate_chat_viewer(
        &self,
        ctx: AccountContext,
    ) -> Result<(EngineAuthContext, Option<std::time::Instant>), PortError> {
        if !matches!(
            ctx.auth().kind(),
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. }
        ) {
            return Err(denied());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        self.current_auth_with_expiry(&budget, &ctx.budget.request, ctx.auth())
            .await
    }

    pub(super) async fn current_auth_with_expiry(
        &self,
        budget: &OperationBudget,
        request: &RequestId,
        authority: &EngineAuthContext,
    ) -> Result<(EngineAuthContext, Option<std::time::Instant>), PortError> {
        let (mut tx, auth) = self
            .open_revalidated_read(budget, request, authority)
            .await?;
        let expiry = budget
            .run(
                credential_expiry(tx.inner_mut(), auth.credential().ok_or_else(denied)?),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let deadline = if let Some(expiry) = expiry {
            let start = std::time::Instant::now();
            let now = self.clock.now_ms()?;
            if expiry <= now {
                return Err(denied());
            }
            Some(
                start
                    .checked_add(std::time::Duration::from_millis(expiry.abs_diff(now)))
                    .ok_or_else(denied)?,
            )
        } else {
            None
        };
        Ok((auth, deadline))
    }

    pub(super) fn reject_search_indexing(&self, auth: &EngineAuthContext) -> Result<(), PortError> {
        if is_search_indexing(auth) {
            return Err(access_denied());
        }
        Ok(())
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
        self.revalidate_inner(tx, auth, keeper, true, false).await
    }
    pub(super) async fn revalidate_for_embedding(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        keeper: Option<&super::schedules::PrecheckedKeeper>,
    ) -> Result<EngineAuthContext, PortError> {
        self.revalidate_inner(tx, auth, keeper, true, true).await
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
        self.revalidate_inner(tx, auth, keeper, false, false).await
    }
    async fn revalidate_inner(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        keeper: Option<&super::schedules::PrecheckedKeeper>,
        lock: bool,
        allow_search_indexing: bool,
    ) -> Result<EngineAuthContext, PortError> {
        if !allow_search_indexing {
            self.reject_search_indexing(auth)?;
        }
        let current_user = if lock {
            user(tx, auth.principal().as_str()).await?
        } else {
            user_read(tx, auth.principal().as_str()).await?
        };
        let credential = auth.credential().cloned().ok_or_else(denied)?;
        let current = self
            .credential_context(
                tx,
                &current_user,
                credential,
                auth.human_management(),
                auth.has_cap(Cap::AbilityWrite),
                lock,
                keeper,
                allow_search_indexing,
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
        self.open_revalidated_read_inner(budget, request, auth, false)
            .await
    }
    pub(super) async fn open_revalidated_read_for_search_indexing(
        &self,
        budget: &OperationBudget,
        request: &RequestId,
        auth: &EngineAuthContext,
    ) -> Result<(crate::store::ReadTransaction, EngineAuthContext), PortError> {
        self.open_revalidated_read_inner(budget, request, auth, true)
            .await
    }
    async fn open_revalidated_read_inner(
        &self,
        budget: &OperationBudget,
        request: &RequestId,
        auth: &EngineAuthContext,
        allow_search_indexing: bool,
    ) -> Result<(crate::store::ReadTransaction, EngineAuthContext), PortError> {
        if !allow_search_indexing {
            self.reject_search_indexing(auth)?;
        }
        let keeper = self.precheck_keeper_catalog(auth, budget, request).await?;
        let mut rtx = self.store.read(budget.clone()).await?;
        match budget
            .run(
                self.revalidate_inner(
                    rtx.inner_mut(),
                    auth,
                    keeper.as_ref(),
                    false,
                    allow_search_indexing,
                ),
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

    pub(super) async fn revalidate_proposal_human(
        &self,
        ctx: AccountContext,
        access: ProposalHumanAccess,
    ) -> Result<EngineAuthContext, PortError> {
        let prior = ctx.auth();
        prior.authorize_proposal_confirmation()?;
        let credential = prior.credential().cloned().ok_or_else(denied)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let fresh = budget
            .run(
                async {
                    let tx = rtx.inner_mut();
                    let user = user_read(tx, prior.principal().as_str()).await?;
                    let CredentialAuthority::Human { credential, source } = self
                        .credential_authority(tx, &user, credential, false)
                        .await?
                    else {
                        return Err(denied());
                    };
                    let spaces = self.active_space_grants(tx, &user, false).await?;
                    let live = VerifiedHuman::attest(
                        PrincipalId::parse(&user.user_id)?,
                        source,
                        spaces,
                        false,
                    )
                    .with_human_management(true)
                    .with_credential(credential);
                    Ok(EngineAuthContext::for_proposal_human(prior, live, access)?)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(rtx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(fresh)
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
        allow_search_indexing: bool,
    ) -> Result<EngineAuthContext, PortError> {
        if let AuthenticatedCredential::SearchIndexing { space, provider } = &credential {
            if !allow_search_indexing {
                return Err(access_denied());
            }
            if current_user.disabled_at.is_some() {
                return Err(denied());
            }
            let member = if lock {
                rows!(
                    tx,
                    SpaceMembersRow,
                    fetch_optional,
                    "SELECT m.* FROM space_members m JOIN space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.space_id=$2 AND m.admission='active' AND s.state='active'",
                    "SELECT m.* FROM v1_control.space_members m JOIN v1_control.space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.space_id=$2 AND m.admission='active' AND s.state='active' FOR SHARE OF m,s";
                    &current_user.user_id,
                    space.as_str()
                )?
            } else {
                rows!(
                    tx,
                    SpaceMembersRow,
                    fetch_optional,
                    "SELECT m.* FROM space_members m JOIN space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.space_id=$2 AND m.admission='active' AND s.state='active'",
                    "SELECT m.* FROM v1_control.space_members m JOIN v1_control.space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.space_id=$2 AND m.admission='active' AND s.state='active'";
                    &current_user.user_id,
                    space.as_str()
                )?
            }
            .ok_or_else(denied)?;
            if !matches!(member.role.as_str(), "owner" | "editor" | "viewer") {
                return Err(denied());
            }
            let source = grant("search-indexing", &current_user.user_id);
            return Ok(EngineAuthContext::for_search_indexing(
                PrincipalId::parse(&current_user.user_id)?,
                source,
                space.clone(),
                provider.clone(),
            ));
        }
        if matches!(credential, AuthenticatedCredential::ScheduledRun { .. }) {
            return self
                .scheduled_context(tx, current_user, credential, lock, keeper)
                .await;
        }
        match self
            .credential_authority(tx, current_user, credential, lock)
            .await?
        {
            CredentialAuthority::Human { credential, source } => {
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
            CredentialAuthority::Bearer {
                credential,
                source,
                scope,
                ability_write,
                selected_spaces,
            } => {
                let mut spaces = self.active_space_grants(tx, current_user, lock).await?;
                let narrowed = selected_spaces.is_some();
                if let Some(selected) = selected_spaces {
                    spaces.retain(|id, _| selected.contains(id));
                }
                let auth = EngineAuthContext::for_bearer(VerifiedBearer::attest(
                    PrincipalId::parse(&current_user.user_id)?,
                    source,
                    credential,
                    spaces,
                    scope,
                    ability_write,
                ));
                Ok(if narrowed {
                    auth.mark_spaces_narrowed()
                } else {
                    auth
                })
            }
        }
    }
    pub(super) async fn credential_authority(
        &self,
        tx: &mut Transaction,
        current_user: &UsersRow,
        credential: AuthenticatedCredential,
        lock: bool,
    ) -> Result<CredentialAuthority, PortError> {
        if current_user.disabled_at.is_some() {
            return Err(denied());
        }
        let now = self.clock.now_ms()?;
        match credential {
            AuthenticatedCredential::ScheduledRun { .. }
            | AuthenticatedCredential::SearchIndexing { .. } => Err(denied()),
            AuthenticatedCredential::Session(id) => {
                live_session(&session(tx, id.as_str()).await?, current_user, now)?;
                let source = grant("session", id.as_str());
                Ok(CredentialAuthority::Human {
                    credential: AuthenticatedCredential::Session(id),
                    source,
                })
            }
            AuthenticatedCredential::TrustedNone => {
                if !matches!(&self.config.authentication,AuthenticationMode::TrustedNone{owner} if owner.as_str()==current_user.user_id)
                {
                    return Err(denied());
                }
                Ok(CredentialAuthority::Human {
                    credential: AuthenticatedCredential::TrustedNone,
                    source: grant("none", &current_user.user_id),
                })
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
                Ok(CredentialAuthority::Bearer {
                    credential: BearerCredential::Pat(id),
                    source,
                    scope: bearer_scope(&current.scope)?,
                    ability_write: current.ability_write == 1,
                    selected_spaces: selected(
                        current.selected_spaces.as_deref(),
                        self.config.max_auth_spaces,
                    )?,
                })
            }
            AuthenticatedCredential::OAuth {
                token,
                grant: grant_id,
                family,
            } => {
                let current = access(tx, token.as_str()).await?;
                let consent = oauth_grant(tx, grant_id.as_str()).await?;
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
                if let Some(id) = &family {
                    let family = if lock {
                        rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1 FOR SHARE";id.as_str())?.ok_or_else(denied)?
                    } else {
                        rows!(tx,OauthRefreshFamiliesRow,fetch_optional,"SELECT * FROM oauth_refresh_families WHERE family_id=$1","SELECT * FROM v1_control.oauth_refresh_families WHERE family_id=$1";id.as_str())?.ok_or_else(denied)?
                    };
                    if family.grant_id != consent.grant_id || family.revoked_at.is_some() {
                        return Err(denied());
                    }
                }
                let scope = match (bearer_scope(&current.scope)?, bearer_scope(&consent.scope)?) {
                    (BearerScope::Write, BearerScope::Write) => BearerScope::Write,
                    _ => BearerScope::Read,
                };
                let token_spaces = selected(
                    current.selected_spaces.as_deref(),
                    self.config.max_auth_spaces,
                )?;
                let consent_spaces = selected(
                    consent.selected_spaces.as_deref(),
                    self.config.max_auth_spaces,
                )?;
                let selected_spaces = match (token_spaces, consent_spaces) {
                    (Some(mut token), Some(consent)) => {
                        token.retain(|id| consent.contains(id));
                        Some(token)
                    }
                    (token, consent) => token.or(consent),
                };
                Ok(CredentialAuthority::Bearer {
                    credential: BearerCredential::OAuth {
                        token,
                        grant: grant_id,
                        family,
                    },
                    source: grant("oauth", &consent.grant_id),
                    scope,
                    ability_write: current.ability_write == 1 && consent.ability_write == 1,
                    selected_spaces,
                })
            }
        }
    }
    pub(super) async fn admit_search_indexing(
        &self,
        authority: &ServiceAuthority,
        space: &CatalogSpace,
        revision_actor: &PrincipalId,
        provider: &ProviderResourceId,
        budget: CallBudget,
    ) -> Result<SpaceContext, PortError> {
        authority.require(ServicePurpose::Search)?;
        let budget_guard = OperationBudget::new(budget.clone());
        let mut tx = self.store.read(budget_guard.clone()).await?;
        let auth = budget_guard
            .run(
                async {
                    let user = match space.space.kind {
                        SpaceKind::Shared => user_read(tx.inner_mut(), revision_actor.as_str()).await?,
                        SpaceKind::Personal => rows!(
                            tx.inner_mut(), UsersRow, fetch_optional,
                            "SELECT u.* FROM users u JOIN space_members m ON u.user_id=m.user_id WHERE u.personal_space_id=$1 AND m.space_id=$1 AND m.role='owner' AND m.admission='active'",
                            "SELECT u.* FROM v1_control.users u JOIN v1_control.space_members m ON u.user_id=m.user_id WHERE u.personal_space_id=$1 AND m.space_id=$1 AND m.role='owner' AND m.admission='active'";
                            space.space.id.as_str()
                        )?.ok_or_else(denied)?,
                    };
                    self.credential_context(
                        tx.inner_mut(),
                        &user,
                        AuthenticatedCredential::SearchIndexing {
                            space: space.space.id.clone(),
                            provider: provider.clone(),
                        },
                        false,
                        false,
                        false,
                        None,
                        true,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget_guard
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let budget = budget_guard.context(budget.request);
        SpaceContext::new(auth, space.history.clone(), budget).map_err(Into::into)
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
        budget.run_commit(tx.commit()).await?;
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
                        false,
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
                        false,
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
                    .credential_context(
                        tx,
                        &current_user,
                        credential,
                        false,
                        false,
                        false,
                        None,
                        false,
                    )
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
                        false,
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
                        false,
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
                    .credential_context(
                        tx,
                        &current_user,
                        credential,
                        false,
                        false,
                        true,
                        None,
                        false,
                    )
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
                    self.credential_context(
                        rtx.inner_mut(),
                        &current,
                        AuthenticatedCredential::TrustedNone,
                        perimeter.human_management(),
                        perimeter.human_management() && perimeter.ability_write(),
                        false,
                        None,
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

use super::{AuthenticationMode, ControlService};
use crate::{
    auth::token,
    error::invalid,
    store::{
        Transaction,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::*,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::*,
    ports::*,
};
use std::collections::BTreeMap;

pub(super) fn denied() -> PortError {
    DomainError::AuthenticationFailed.into()
}
pub(super) fn access_denied() -> PortError {
    DomainError::AccessDenied.into()
}
pub(super) fn account_info(row: &UsersRow) -> Result<AccountInfo, PortError> {
    Ok(AccountInfo {
        id: PrincipalId::parse(&row.user_id)?,
        username: row.username.clone(),
        email: row.email.clone(),
        display_name: row.display_name.clone(),
        is_admin: row.is_admin == 1,
        disabled: row.disabled_at.is_some(),
        personal_space: row
            .personal_space_id
            .as_deref()
            .map(SpaceId::parse)
            .transpose()?,
        revision: ControlRevision::new(row.revision as u64)?,
    })
}
pub(super) fn expect_revision(row: &UsersRow, expected: ControlRevision) -> Result<(), PortError> {
    if row.revision as u64 != expected.get() {
        return Err(DomainError::ControlRevisionConflict {
            current: ControlRevision::new(row.revision as u64)?,
        }
        .into());
    }
    Ok(())
}
pub(super) fn next(value: i64) -> Result<i64, PortError> {
    value
        .checked_add(1)
        .ok_or_else(|| invalid(ValidationReason::InvalidState))
}
pub(super) fn grant(kind: &str, id: &str) -> GrantId {
    let bytes = token::digest(format!("notarium:credential-grant:v1:{kind}:{id}").as_bytes());
    GrantId::from_bytes(bytes[..16].try_into().expect("digest prefix"))
}
pub(super) fn check_digest(stored: &[u8], actual: &[u8; 32]) -> Result<(), PortError> {
    let expected = stored.try_into().map_err(|_| denied())?;
    if !token::verify(expected, actual) {
        return Err(denied());
    }
    Ok(())
}
pub(super) async fn user(tx: &mut Transaction, id: &str) -> Result<UsersRow, PortError> {
    rows!(tx,UsersRow,fetch_optional,"SELECT * FROM users WHERE user_id=$1","SELECT * FROM v1_control.users WHERE user_id=$1 FOR UPDATE";id)?.ok_or_else(denied)
}
pub(super) async fn user_read(tx: &mut Transaction, id: &str) -> Result<UsersRow, PortError> {
    rows!(tx,UsersRow,fetch_optional,"SELECT * FROM users WHERE user_id=$1","SELECT * FROM v1_control.users WHERE user_id=$1";id)?.ok_or_else(denied)
}
pub(super) async fn session(tx: &mut Transaction, id: &str) -> Result<SessionsRow, PortError> {
    rows!(tx,SessionsRow,fetch_optional,"SELECT * FROM sessions WHERE session_id=$1","SELECT * FROM v1_control.sessions WHERE session_id=$1";id)?.ok_or_else(denied)
}
pub(super) fn live_session(row: &SessionsRow, user: &UsersRow, now: i64) -> Result<(), PortError> {
    if row.user_id != user.user_id
        || row.revoked_at.is_some()
        || row.expires_at <= now
        || row.auth_version != user.auth_version
        || user.disabled_at.is_some()
    {
        return Err(denied());
    }
    Ok(())
}
pub(super) async fn mint_session(
    tx: &mut Transaction,
    user: &UsersRow,
    now: i64,
) -> Result<IssuedSession, PortError> {
    let minted = token::mint(token::TokenKind::Session)?;
    let id = AuthSessionId::from_bytes(token::random()?);
    let expires_at = now
        .checked_add(30 * 24 * 60 * 60 * 1000)
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    let record = TargetRecord::from(SessionsRow {
        session_id: id.to_string(),
        token_hash: minted.digest.to_vec(),
        user_id: user.user_id.clone(),
        created_at: now,
        expires_at,
        last_used_at: now,
        revoked_at: None,
        auth_version: user.auth_version,
    });
    record.validate()?;
    record.insert(tx).await?;
    Ok(IssuedSession {
        account: account_info(user)?,
        id,
        token: minted.secret,
        expires_at_ms: expires_at,
    })
}
impl ControlService {
    /// All credential/account management mutations require an interactive human
    /// with checked perimeter/CSRF attestation (`human_management`) and lock
    /// involved user rows in lexical order.
    pub(super) async fn manager(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        target: &PrincipalId,
    ) -> Result<(UsersRow, UsersRow), PortError> {
        auth.authorize_human_management()?;
        let actor_id = auth.principal().as_str();
        let target_id = target.as_str();
        let users = rows!(tx,UsersRow,fetch_all,
            "SELECT * FROM users WHERE user_id IN ($1,$2) ORDER BY user_id",
            "SELECT * FROM v1_control.users WHERE user_id IN ($1,$2) ORDER BY user_id FOR UPDATE";actor_id,target_id)?;
        let actor = users
            .iter()
            .find(|u| u.user_id == actor_id)
            .ok_or_else(denied)?;
        self.live_human(tx, auth, actor).await?;
        if actor_id != target_id && actor.is_admin != 1 {
            return Err(access_denied());
        }
        let target = users
            .iter()
            .find(|u| u.user_id == target_id)
            .ok_or(DomainError::ResourceNotFound)?;
        Ok((actor.clone(), target.clone()))
    }
    /// Read-only inspection for an interactive human (`DirectHuman`) without
    /// requiring mutation CSRF attestation or acquiring row write locks.
    pub(super) async fn manager_read(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        target: &PrincipalId,
    ) -> Result<(UsersRow, UsersRow), PortError> {
        if auth.kind() != &PrincipalKind::DirectHuman {
            return Err(access_denied());
        }
        let actor_id = auth.principal().as_str();
        let target_id = target.as_str();
        let users = rows!(tx,UsersRow,fetch_all,
            "SELECT * FROM users WHERE user_id IN ($1,$2) ORDER BY user_id",
            "SELECT * FROM v1_control.users WHERE user_id IN ($1,$2) ORDER BY user_id";actor_id,target_id)?;
        let actor = users
            .iter()
            .find(|u| u.user_id == actor_id)
            .ok_or_else(denied)?;
        self.live_human(tx, auth, actor).await?;
        if actor_id != target_id && actor.is_admin != 1 {
            return Err(access_denied());
        }
        let target = users
            .iter()
            .find(|u| u.user_id == target_id)
            .ok_or(DomainError::ResourceNotFound)?;
        Ok((actor.clone(), target.clone()))
    }
    pub(super) async fn live_human(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        user: &UsersRow,
    ) -> Result<(), PortError> {
        if user.disabled_at.is_some() || user.user_id != auth.principal().as_str() {
            return Err(denied());
        }
        match auth.credential() {
            Some(AuthenticatedCredential::Session(id)) => {
                live_session(&session(tx, id.as_str()).await?, user, self.clock.now_ms()?)
            }
            Some(AuthenticatedCredential::TrustedNone) if matches!(&self.config.authentication,AuthenticationMode::TrustedNone{owner} if owner==auth.principal()) => {
                Ok(())
            }
            _ => Err(denied()),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn human_context(
        &self,
        tx: &mut Transaction,
        user: &UsersRow,
        credential: AuthenticatedCredential,
        source: GrantId,
        human_management: bool,
        ability_write: bool,
        lock: bool,
    ) -> Result<EngineAuthContext, PortError> {
        if user.disabled_at.is_some() {
            return Err(denied());
        }
        // EngineAuthContext is intentionally finite. Exceeding the configured
        // bound fails the whole admission instead of silently dropping Spaces.
        let limit = i64::from(self.config.max_auth_spaces) + 1;
        let memberships = if lock {
            rows!(tx,SpaceMembersRow,fetch_all,
                "SELECT m.* FROM space_members m JOIN space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.admission='active' AND s.state='active' ORDER BY m.space_id LIMIT $2",
                "SELECT m.* FROM v1_control.space_members m JOIN v1_control.space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.admission='active' AND s.state='active' ORDER BY m.space_id LIMIT $2 FOR SHARE OF m,s";&user.user_id,limit)?
        } else {
            rows!(tx,SpaceMembersRow,fetch_all,
                "SELECT m.* FROM space_members m JOIN space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.admission='active' AND s.state='active' ORDER BY m.space_id LIMIT $2",
                "SELECT m.* FROM v1_control.space_members m JOIN v1_control.space_admission s ON s.space_id=m.space_id WHERE m.user_id=$1 AND m.admission='active' AND s.state='active' ORDER BY m.space_id LIMIT $2";&user.user_id,limit)?
        };
        if memberships.len() > usize::from(self.config.max_auth_spaces) {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        let mut spaces = BTreeMap::new();
        for member in memberships {
            let role = match member.role.as_str() {
                "owner" => SpaceRole::Owner,
                "editor" => SpaceRole::Editor,
                "viewer" => SpaceRole::Viewer,
                _ => return Err(denied()),
            };
            spaces.insert(
                SpaceId::parse(&member.space_id)?,
                SpaceGrant {
                    role,
                    read_classes: DocClass::all(),
                    write_classes: if role == SpaceRole::Viewer {
                        Default::default()
                    } else {
                        DocClass::all()
                    },
                    project_root: None,
                },
            );
        }
        Ok(EngineAuthContext::for_human(
            VerifiedHuman::attest(
                PrincipalId::parse(&user.user_id)?,
                source,
                spaces,
                ability_write,
            )
            .with_human_management(human_management)
            .with_credential(credential),
        ))
    }
    pub(super) async fn revoke_principal(
        &self,
        tx: &mut Transaction,
        user: &UsersRow,
        now: i64,
    ) -> Result<RequestId, PortError> {
        execute!(tx,"UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL","UPDATE v1_control.sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL";now,&user.user_id)?;
        execute!(tx,"UPDATE pats SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL","UPDATE v1_control.pats SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL";now,&user.user_id)?;
        execute!(tx,"UPDATE oauth_grants SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL","UPDATE v1_control.oauth_grants SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL";now,&user.user_id)?;
        execute!(tx,"UPDATE one_time_tokens SET used_at=$1 WHERE user_id=$2 AND used_at IS NULL","UPDATE v1_control.one_time_tokens SET used_at=$1 WHERE user_id=$2 AND used_at IS NULL";now,&user.user_id)?;
        super::outbox::enqueue(
            tx,
            RevocationSelector::Principal(PrincipalId::parse(&user.user_id)?),
            RevocationReason::PermissionChanged,
            next(user.auth_version)?,
            now,
        )
        .await
    }
}

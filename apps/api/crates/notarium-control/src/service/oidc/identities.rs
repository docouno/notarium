use super::super::{
    authority,
    commands::{Command, SavedResult},
};
use super::{OidcService, claims::VerifiedIdentity, denied, flows::Flow};
use crate::{
    auth::{password, token},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError},
    ids::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};

fn info(row: UserOidcIdentitiesRow) -> Result<OidcIdentity, PortError> {
    Ok(OidcIdentity {
        issuer: row.issuer,
        subject: row.subject,
        account: PrincipalId::parse(&row.user_id)?,
        created_at_ms: row.created_at,
    })
}
fn valid_identity(issuer: &str, subject: &str) -> Result<(), PortError> {
    if issuer.len() + subject.len() > 2048
        || subject.is_empty()
        || subject.len() > 1024
        || subject.chars().any(char::is_control)
    {
        return Err(denied());
    }
    Ok(())
}
async fn identity(
    tx: &mut Transaction,
    issuer: &str,
    subject: &str,
) -> Result<Option<UserOidcIdentitiesRow>, PortError> {
    rows!(tx,UserOidcIdentitiesRow,fetch_optional,"SELECT * FROM user_oidc_identities WHERE issuer=$1 AND subject=$2","SELECT * FROM v1_control.user_oidc_identities WHERE issuer=$1 AND subject=$2";issuer,subject)
}
async fn bind(
    tx: &mut Transaction,
    user: &UsersRow,
    issuer: &str,
    subject: &str,
    now: i64,
) -> Result<(OidcIdentity, i64), PortError> {
    if let Some(existing) = identity(tx, issuer, subject).await? {
        if existing.user_id != user.user_id {
            return Err(DomainError::AccessDenied.into());
        }
        return Ok((info(existing)?, user.revision));
    }
    let (count,) = rows!(tx,(i64,),fetch_one,"SELECT COUNT(*) FROM user_oidc_identities WHERE user_id=$1","SELECT COUNT(*) FROM v1_control.user_oidc_identities WHERE user_id=$1";&user.user_id)?;
    if count >= 64 {
        return Err(super::limited());
    }
    // Two different users may prove the same external identity concurrently.
    // The unique key arbitrates without replacing the first owner's binding.
    execute!(tx,"INSERT INTO user_oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO NOTHING","INSERT INTO v1_control.user_oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO NOTHING";issuer,subject,&user.user_id,now)?;
    let saved = identity(tx, issuer, subject).await?.ok_or_else(denied)?;
    if saved.user_id != user.user_id {
        return Err(DomainError::AccessDenied.into());
    }
    let revision = authority::next(user.revision)?;
    execute!(tx,"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&user.user_id)?;
    Ok((info(saved)?, revision))
}
impl OidcService {
    pub(super) async fn complete_identity(
        &self,
        budget: &OperationBudget,
        flow: &Flow,
        verified: VerifiedIdentity,
    ) -> Result<OidcOutcome, PortError> {
        valid_identity(&verified.issuer, &verified.subject)?;
        let mut tx = self.control.store.write(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let now = self.control.clock.now_ms()?;
                    if flow.expires <= now {
                        return Err(denied());
                    }
                    if let Some(bound) = &flow.bound {
                        let user = authority::user(tx.inner_mut(), bound.user.as_str()).await?;
                        let session =
                            authority::session(tx.inner_mut(), bound.session.as_str()).await?;
                        authority::live_session(&session, &user, now)?;
                        if user.auth_version != bound.auth_version {
                            return Err(denied());
                        }
                        let hash = token::digest(flow.transaction.as_str().as_bytes());
                        let command = Command::new(
                            AccountCommandIdentity {
                                actor: bound.user.clone(),
                                owner: bound.user.clone(),
                                key: CommandKey::from_bytes(
                                    hash[..16].try_into().expect("digest prefix"),
                                ),
                                hash: ContentDigest::from_bytes(hash),
                                expected: ControlRevision::new(user.revision as u64)?,
                            },
                            "link-oidc",
                            (&verified.issuer, &verified.subject),
                        )?;
                        let (identity, revision) = bind(
                            tx.inner_mut(),
                            &user,
                            &verified.issuer,
                            &verified.subject,
                            now,
                        )
                        .await?;
                        command
                            .save(
                                tx.inner_mut(),
                                ControlRevision::new(revision as u64)?,
                                &SavedResult {
                                    value: identity.clone(),
                                    events: vec![],
                                },
                                now,
                            )
                            .await?;
                        Ok(OidcOutcome::Linked(identity))
                    } else {
                        let Some(observed) =
                            identity(tx.inner_mut(), &verified.issuer, &verified.subject).await?
                        else {
                            return Ok(OidcOutcome::IdentityUnbound(UnboundOidcIdentity {
                                issuer: verified.issuer,
                                subject: verified.subject,
                                contact_email: verified.contact_email,
                            }));
                        };
                        let user = authority::user(tx.inner_mut(), &observed.user_id).await?;
                        let current = identity(tx.inner_mut(), &verified.issuer, &verified.subject)
                            .await?
                            .ok_or_else(denied)?;
                        if current.user_id != user.user_id || user.disabled_at.is_some() {
                            return Err(denied());
                        }
                        Ok(OidcOutcome::Authenticated(
                            authority::mint_session(tx.inner_mut(), &user, now).await?,
                        ))
                    }
                },
                CommitEffect::Unknown,
            )
            .await?;
        budget.run_commit(tx.commit()).await?;
        Ok(result)
    }
    pub(super) async fn bind_identity(
        &self,
        ctx: AccountContext,
        request: AccountMutation<BindOidcIdentity>,
    ) -> Result<ControlCommit<OidcIdentity>, PortError> {
        ctx.auth().authorize_human_management()?;
        self.provider(&request.input.issuer)?;
        valid_identity(&request.input.issuer, &request.input.subject)?;
        let _admission = self.admit()?;
        let command = Command::new(request.identity, "bind-oidc", &request.input)?;
        command.require(ctx.auth().principal(), &request.input.account)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (revision, saved) = budget
            .run(
                async {
                    let (actor, user) = self
                        .control
                        .manager(tx.inner_mut(), ctx.auth(), &request.input.account)
                        .await?;
                    if actor.is_admin != 1 {
                        return Err(DomainError::AccessDenied.into());
                    }
                    if let Some(replay) = command.replay::<OidcIdentity>(tx.inner_mut()).await? {
                        return Ok(replay);
                    }
                    authority::expect_revision(&user, command.identity.expected)?;
                    let now = self.control.clock.now_ms()?;
                    let (identity, revision) = bind(
                        tx.inner_mut(),
                        &user,
                        &request.input.issuer,
                        &request.input.subject,
                        now,
                    )
                    .await?;
                    let revision = ControlRevision::new(revision as u64)?;
                    let saved = SavedResult {
                        value: identity,
                        events: vec![],
                    };
                    command.save(tx.inner_mut(), revision, &saved, now).await?;
                    Ok((revision, saved))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run_commit(tx.commit()).await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
    pub(super) async fn unlink_identity(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UnlinkOidcIdentity>,
    ) -> Result<ControlCommit<()>, PortError> {
        ctx.auth().authorize_human_management()?;
        valid_identity(&request.input.issuer, &request.input.subject)?;
        let _admission = self.admit()?;
        let command = Command::new(request.identity, "unlink-oidc", &request.input)?;
        command.require(ctx.auth().principal(), &request.input.account)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.control.store.write(budget.clone()).await?;
        let (revision,_)=budget.run(async {
            let (_,user)=self.control.manager(tx.inner_mut(),ctx.auth(),&request.input.account).await?;
            if let Some(replay)=command.replay::<()>(tx.inner_mut()).await? {return Ok(replay);}
            authority::expect_revision(&user,command.identity.expected)?;
            let now=self.control.clock.now_ms()?;
            let current=identity(tx.inner_mut(),&request.input.issuer,&request.input.subject).await?.ok_or(DomainError::ResourceNotFound)?;
            if current.user_id!=user.user_id {return Err(DomainError::ResourceNotFound.into());}
            if !user.password_hash.as_deref().is_some_and(password::supported) {
                let others=rows!(tx.inner_mut(),UserOidcIdentitiesRow,fetch_all,"SELECT * FROM user_oidc_identities WHERE user_id=$1 AND NOT (issuer=$2 AND subject=$3) ORDER BY issuer,subject LIMIT 65","SELECT * FROM v1_control.user_oidc_identities WHERE user_id=$1 AND NOT (issuer=$2 AND subject=$3) ORDER BY issuer,subject LIMIT 65";&user.user_id,&request.input.issuer,&request.input.subject)?;
                if !others.iter().any(|other|self.providers.contains_key(&other.issuer)) {return Err(DomainError::AccessDenied.into());}
            }
            // Removing a login method prevents future OIDC logins. Existing
            // native credentials retain their separate explicit revoke policy.
            execute!(tx.inner_mut(),"DELETE FROM user_oidc_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3","DELETE FROM v1_control.user_oidc_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3";&request.input.issuer,&request.input.subject,&user.user_id)?;
            let revision=authority::next(user.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&user.user_id)?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult {value:(),events:vec![]};command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        budget.run_commit(tx.commit()).await?;
        Ok(ControlCommit {
            revision,
            value: (),
        })
    }
}

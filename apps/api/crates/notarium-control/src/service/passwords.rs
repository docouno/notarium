use super::{AuthenticationMode, ControlService, authority::*};
use crate::{
    auth::password,
    error::invalid,
    store::{
        lease::OperationBudget,
        statements::{execute, read_rows},
        target::UsersRow,
    },
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::control::ControlCommit,
    ports::*,
};

// A syntactically valid canonical profile with an unknown preimage. Unknown and
// passwordless users take the same bounded worker path as a wrong password.
const DUMMY: &str = "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
impl ControlService {
    pub async fn login(
        &self,
        ctx: CallBudget,
        request: PasswordLogin,
    ) -> Result<IssuedSession, PortError> {
        let budget = OperationBudget::new(ctx);
        budget.check(CommitEffect::NotCommitted)?;
        if !matches!(self.config.authentication, AuthenticationMode::Password) {
            return Err(denied());
        }
        if request.identifier.is_empty()
            || request.identifier.len() > 254
            || request.identifier.contains('\0')
        {
            return Err(denied());
        }
        // Usernames never contain `@`; emails always contain `@`. Disjoint lookup
        // prevents any email/username cross-account ambiguity.
        let is_email = request.identifier.contains('@');
        let lookup = if is_email {
            request.identifier.trim().to_lowercase()
        } else {
            request.identifier
        };
        let observed = budget
            .run(
                async {
                    if is_email {
                        read_rows!(
                            &self.store.backend,
                            UsersRow,
                            fetch_optional,
                            "SELECT * FROM users WHERE email=$1",
                            "SELECT * FROM v1_control.users WHERE email=$1";
                            &lookup
                        )
                    } else {
                        read_rows!(
                            &self.store.backend,
                            UsersRow,
                            fetch_optional,
                            "SELECT * FROM users WHERE username=$1",
                            "SELECT * FROM v1_control.users WHERE username=$1";
                            &lookup
                        )
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let hash = observed
            .as_ref()
            .filter(|user| user.disabled_at.is_none())
            .and_then(|u| u.password_hash.as_deref())
            .unwrap_or(DUMMY);
        let verification = budget
            .run(
                password::verify(request.password, hash),
                CommitEffect::NotCommitted,
            )
            .await?;
        let observed = observed
            .filter(|u| u.disabled_at.is_none() && u.password_hash.is_some() && verification.valid)
            .ok_or_else(denied)?;
        let mut tx = self.store.write(budget.clone()).await?;
        let issued=budget.run(async {
            let mut current=user(tx.inner_mut(),&observed.user_id).await?;
            if current.disabled_at.is_some() || current.auth_version!=observed.auth_version || current.password_hash!=observed.password_hash {return Err(denied());}
            if let Some(upgraded)=verification.upgraded_hash {
                execute!(tx.inner_mut(),"UPDATE users SET password_hash=$1 WHERE user_id=$2 AND password_hash=$3 AND auth_version=$4","UPDATE v1_control.users SET password_hash=$1 WHERE user_id=$2 AND password_hash=$3 AND auth_version=$4";&upgraded,&current.user_id,&current.password_hash,current.auth_version)?;
                current.password_hash=Some(upgraded);
            }
            mint_session(tx.inner_mut(),&current,self.clock.now_ms()?).await
        },CommitEffect::NotCommitted).await?;
        budget.commit_tx(tx).await?;
        Ok(issued)
    }
    pub async fn account(
        &self,
        ctx: AccountContext,
        id: PrincipalId,
    ) -> Result<AccountInfo, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let (_, row) = budget
            .run(
                self.manager_read(rtx.inner_mut(), ctx.auth(), &id),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        account_info(&row)
    }
    pub async fn change_password(
        &self,
        ctx: AccountContext,
        request: ChangePassword,
    ) -> Result<ControlCommit<AccountInfo>, PortError> {
        if !matches!(self.config.authentication, AuthenticationMode::Password) {
            return Err(denied());
        }
        ctx.auth().authorize_human_management()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let (actor, observed) = budget
            .run(
                self.manager_read(rtx.inner_mut(), ctx.auth(), &request.account),
                CommitEffect::NotCommitted,
            )
            .await?;
        expect_revision(&observed, request.expected)?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        if actor.user_id == observed.user_id {
            let current = request.current.ok_or_else(denied)?;
            let hash = observed.password_hash.as_deref().ok_or_else(denied)?;
            if !budget
                .run(password::verify(current, hash), CommitEffect::NotCommitted)
                .await?
                .valid
            {
                return Err(denied());
            }
        }
        let hash = budget
            .run(
                password::hash(request.replacement),
                CommitEffect::NotCommitted,
            )
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (event,updated)=budget.run(async {
            let (_,mut current)=self.manager(tx.inner_mut(),ctx.auth(),&request.account).await?;
            expect_revision(&current,request.expected)?;
            if current.auth_version!=observed.auth_version || current.password_hash!=observed.password_hash {return Err(denied());}
            let now=self.clock.now_ms()?;
            let event=self.revoke_principal(tx.inner_mut(),&current,now).await?;
            current.revision=next(current.revision)?;
            current.auth_version=next(current.auth_version)?;
            execute!(tx.inner_mut(),"UPDATE users SET password_hash=$1,revision=$2,auth_version=$3 WHERE user_id=$4","UPDATE v1_control.users SET password_hash=$1,revision=$2,auth_version=$3 WHERE user_id=$4";&hash,current.revision,current.auth_version,&current.user_id)?;
            Ok((event,account_info(&current)?))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, std::slice::from_ref(&event))
            .await?;
        self.flush_event(&budget, &event).await?;
        Ok(ControlCommit {
            revision: updated.revision,
            value: updated,
        })
    }
}

fn valid_email(value: &str) -> bool {
    if value.is_empty() || value.len() > 254 || value.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

pub(super) fn normalize_account(
    username: String,
    email: Option<String>,
    display_name: String,
) -> Result<(String, Option<String>, String), PortError> {
    if !(1..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        || !username.as_bytes()[0].is_ascii_alphanumeric()
        || !username.as_bytes()[username.len() - 1].is_ascii_alphanumeric()
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    let email = email.map(|v| v.trim().to_lowercase());
    if email.as_deref().is_some_and(|v| !valid_email(v))
        || display_name.len() > 256
        || display_name.contains('\0')
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok((username, email, display_name))
}

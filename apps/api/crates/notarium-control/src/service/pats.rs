use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    sessions::{pat, selected},
};
use crate::{
    auth::token::{self, TokenKind},
    error::invalid,
    store::{
        lease::OperationBudget,
        statements::{execute, page_rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};
fn scope(value: BearerScope) -> &'static str {
    match value {
        BearerScope::Read => "read",
        BearerScope::Write => "write",
    }
}
fn metadata(row: PatsRow, max: u16) -> Result<PatInfo, PortError> {
    Ok(PatInfo {
        id: CredentialTokenId::parse(&row.token_id)?,
        account: PrincipalId::parse(&row.user_id)?,
        name: row.name,
        scope: match row.scope.as_str() {
            "read" => BearerScope::Read,
            "write" => BearerScope::Write,
            _ => return Err(denied()),
        },
        selected_spaces: selected(row.selected_spaces.as_deref(), max)?
            .map(|s| s.into_iter().collect()),
        expires_at_ms: row.expires_at,
        last_used_at_ms: row.last_used_at,
        revoked_at_ms: row.revoked_at,
        created_at_ms: row.created_at,
    })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    owner: PrincipalId,
    revision: ControlRevision,
    last: CredentialTokenId,
}
impl ControlService {
    pub async fn create_pat(
        &self,
        ctx: AccountContext,
        request: CreatePat,
    ) -> Result<ControlCommit<IssuedPat>, PortError> {
        if request.name.is_empty()
            || request.name.len() > 256
            || request.name.contains('\0')
            || request
                .selected_spaces
                .as_ref()
                .is_some_and(|spaces| spaces.len() > usize::from(self.config.max_auth_spaces))
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let (_, current) = self
                        .manager(tx.inner_mut(), ctx.auth(), ctx.auth().principal())
                        .await?;
                    expect_revision(&current, request.expected)?;
                    let now = self.clock.now_ms()?;
                    if request.expires_at_ms.is_some_and(|time| time <= now) {
                        return Err(invalid(ValidationReason::InvalidTimestamp));
                    }
                    if let Some(spaces) = &request.selected_spaces {
                        let auth = self
                            .human_context(
                                tx.inner_mut(),
                                &current,
                                ctx.auth().credential().cloned().ok_or_else(denied)?,
                                ctx.auth().grant().clone(),
                                false,
                                false,
                                true,
                            )
                            .await?;
                        if spaces.iter().any(|id| !auth.spaces().contains_key(id)) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                    }
                    let spaces = request.selected_spaces.map(|spaces| {
                        spaces
                            .into_iter()
                            .collect::<std::collections::BTreeSet<_>>()
                    });
                    let selected_spaces = spaces
                        .map(|spaces| {
                            serde_json::to_string(&spaces)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))
                        })
                        .transpose()?;
                    let token = token::mint(TokenKind::Pat)?;
                    let row = PatsRow {
                        token_id: token.id.ok_or_else(denied)?,
                        secret_hash: token.digest.to_vec(),
                        user_id: current.user_id.clone(),
                        name: request.name,
                        scope: scope(request.scope).into(),
                        selected_spaces,
                        expires_at: request.expires_at_ms,
                        last_used_at: None,
                        revoked_at: None,
                        created_at: now,
                    };
                    let record = TargetRecord::from(row.clone());
                    record.validate()?;
                    record.insert(tx.inner_mut()).await?;
                    let revision = next(current.revision)?;
                    execute!(
                        tx.inner_mut(),
                        "UPDATE users SET revision=$1 WHERE user_id=$2",
                        "UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";
                        revision,
                        &current.user_id
                    )?;
                    Ok(ControlCommit {
                        revision: ControlRevision::new(revision as u64)?,
                        value: IssuedPat {
                            metadata: metadata(row, self.config.max_auth_spaces)?,
                            token: token.secret,
                        },
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
    pub async fn list_pats(
        &self,
        ctx: AccountContext,
        account: PrincipalId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<PatInfo>, PortError> {
        let cursor: Option<Cursor> = page
            .continuation()
            .map(|value| {
                serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))
            })
            .transpose()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let (_, current) = self
                        .manager_read(rtx.inner_mut(), ctx.auth(), &account)
                        .await?;
                    if let Some(cursor) = &cursor {
                        if cursor.version != 1 || cursor.owner != account {
                            return Err(invalid(ValidationReason::ScopeMismatch));
                        }
                        expect_revision(&current, cursor.revision)?;
                    }
                    let last = cursor.as_ref().map(|c| c.last.as_str()).unwrap_or("");
                    let rows = page_rows!(
                        rtx.inner_mut(),
                        PatsRow,
                        TargetTable::Pats,
                        page.limit(),
                        "SELECT * FROM pats WHERE user_id=$1 AND token_id>$2 ORDER BY token_id LIMIT $3",
                        "SELECT * FROM v1_control.pats WHERE user_id=$1 AND token_id>$2 ORDER BY token_id LIMIT $3";
                        account.as_str(),
                        last,
                        i64::from(page.limit()) + 1
                    )?;
                    let continuation = if rows.has_more {
                        let last = rows
                            .rows
                            .last()
                            .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
                        Some(
                            serde_json::to_string(&Cursor {
                                version: 1,
                                owner: account,
                                revision: ControlRevision::new(current.revision as u64)?,
                                last: CredentialTokenId::parse(&last.token_id)?,
                            })
                            .map_err(|_| invalid(ValidationReason::InvalidState))?,
                        )
                    } else {
                        None
                    };
                    Ok(ControlPage {
                        items: rows
                            .rows
                            .into_iter()
                            .map(|row| metadata(row, self.config.max_auth_spaces))
                            .collect::<Result<_, _>>()?,
                        continuation,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        Ok(result)
    }
    pub async fn revoke_pat(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RevokePat>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(
            request.identity,
            "revoke-pat",
            (&request.input.account, &request.input.token),
        )?;
        command.require(ctx.auth().principal(), &request.input.account)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let (_,current)=self.manager(tx.inner_mut(),ctx.auth(),&request.input.account).await?;
            if let Some(replay)=command.replay::<()>(tx.inner_mut()).await? {return Ok(replay);}
            expect_revision(&current,command.identity.expected)?;
            let pat=pat(tx.inner_mut(),request.input.token.as_str()).await?;
            if pat.user_id!=current.user_id {return Err(DomainError::ResourceNotFound.into());}
            let now=self.clock.now_ms()?;
            let mut events=super::outbox::pending(tx.inner_mut(),RevocationSelector::Grant(grant("pat",&pat.token_id))).await?;
            let revision=if pat.revoked_at.is_none() {
                execute!(tx.inner_mut(),"UPDATE pats SET revoked_at=$1 WHERE token_id=$2","UPDATE v1_control.pats SET revoked_at=$1 WHERE token_id=$2";now,&pat.token_id)?;
                let revision=next(current.revision)?;
                execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&current.user_id)?;
                events.push(super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Grant(grant("pat",&pat.token_id)),RevocationReason::CredentialRemoved,revision,now).await?);
                revision
            } else {current.revision};
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:(),events};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &saved.events).await?;
        for event in &saved.events {
            self.flush_event(&budget, event).await?;
        }
        Ok(ControlCommit {
            value: (),
            revision,
        })
    }
}

//! Durable reference preferences, separate from content ownership and permission.
mod favorites;
mod scopes;
mod selection;
mod sets;
use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    metadata::{digest, hidden},
};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::{SpaceKind, SpaceRole},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, NoteRef},
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct ScopeKey {
    kind: String,
    id: String,
    space: SpaceId,
}
fn scope_key(owner: &UsersRow, scope: &ContextScope) -> Result<ScopeKey, PortError> {
    Ok(match scope {
        ContextScope::Personal => ScopeKey {
            kind: "personal".into(),
            id: owner.user_id.clone(),
            space: SpaceId::parse(
                owner
                    .personal_space_id
                    .as_deref()
                    .ok_or(DomainError::ResourceNotFound)?,
            )?,
        },
        ContextScope::Space(space) => ScopeKey {
            kind: "space".into(),
            id: space.to_string(),
            space: space.clone(),
        },
        ContextScope::Project(project) => ScopeKey {
            kind: "project".into(),
            id: serde_json::to_string(project)
                .map_err(|_| invalid(ValidationReason::InvalidState))?,
            space: project.space_id.clone(),
        },
    })
}
fn decode_scope(key: &ScopeKey, owner: &str) -> Result<ContextScope, PortError> {
    match key.kind.as_str() {
        "personal" if key.id == owner => Ok(ContextScope::Personal),
        "space" if key.id == key.space.as_str() => Ok(ContextScope::Space(key.space.clone())),
        "project" => {
            let project: FolderRef = serde_json::from_str(&key.id)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if project.space_id != key.space {
                return Err(invalid(ValidationReason::InvalidState));
            }
            Ok(ContextScope::Project(project))
        }
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}

async fn bump_owner(tx: &mut Transaction, owner: &UsersRow) -> Result<ControlRevision, PortError> {
    let revision = next(owner.revision)?;
    execute!(tx,"UPDATE users SET revision=$1,metadata_revision=$2 WHERE user_id=$3","UPDATE v1_control.users SET revision=$1,metadata_revision=$2 WHERE user_id=$3";revision,next(owner.metadata_revision)?,&owner.user_id)?;
    Ok(ControlRevision::new(revision as u64)?)
}
impl ControlService {
    async fn context_manager(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
    ) -> Result<UsersRow, PortError> {
        ctx.auth().authorize_human_management()?;
        require_unpinned_human(ctx.auth())?;
        let owner = user(tx, ctx.auth().principal().as_str()).await?;
        self.live_human(tx, ctx.auth(), &owner).await?;
        Ok(owner)
    }
    async fn context_precheck_spaces(
        &self,
        ctx: &AccountContext,
        required: &BTreeMap<SpaceId, bool>,
    ) -> Result<BTreeMap<SpaceId, SpaceKind>, PortError> {
        let mut kinds = BTreeMap::new();
        for space in required.keys() {
            let catalog = self.catalog_space(ctx, space).await?;
            kinds.insert(space.clone(), catalog.space.kind);
        }
        Ok(kinds)
    }
    async fn context_write_spaces(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        owner: &UsersRow,
        required: &BTreeMap<SpaceId, bool>,
        spaces: &BTreeMap<SpaceId, bool>,
        space_kinds: &BTreeMap<SpaceId, SpaceKind>,
    ) -> Result<(), PortError> {
        if spaces.len() > 65 {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        for space in spaces.keys() {
            super::spaces::admission(tx, space, true).await?;
        }
        for (space, writable) in required {
            let original = ctx
                .auth()
                .spaces()
                .get(space)
                .ok_or(DomainError::ResourceNotFound)?;
            if original.read_classes.is_empty()
                || (*writable
                    && (original.role == SpaceRole::Viewer || original.write_classes.is_empty()))
            {
                return Err(access_denied());
            }
            let admission = super::spaces::admission(tx, space, false).await?;
            let member = rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),&owner.user_id)?.ok_or(DomainError::ResourceNotFound)?;
            if admission.state != "active"
                || member.admission != "active"
                || (*writable && !matches!(member.role.as_str(), "owner" | "editor"))
            {
                return Err(access_denied());
            }
            let kind = space_kinds
                .get(space)
                .copied()
                .ok_or(DomainError::ResourceNotFound)?;
            if kind == SpaceKind::Personal
                && owner.personal_space_id.as_deref() != Some(space.as_str())
            {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(())
    }
    async fn context_scope_revision(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        key: &ScopeKey,
    ) -> Result<ControlRevision, PortError> {
        Ok(ControlRevision::new(if key.kind == "personal" {
            owner.metadata_revision
        } else {
            super::spaces::admission(tx, &key.space, false)
                .await?
                .revision
        } as u64)?)
    }
    async fn bump_context_spaces(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        spaces: &BTreeMap<SpaceId, bool>,
    ) -> Result<ControlRevision, PortError> {
        for (space, writable) in spaces {
            if *writable {
                let row = super::spaces::admission(tx, space, false).await?;
                execute!(tx,"UPDATE space_admission SET revision=$1 WHERE space_id=$2","UPDATE v1_control.space_admission SET revision=$1 WHERE space_id=$2";next(row.revision)?,space.as_str())?;
            }
        }
        bump_owner(tx, owner).await
    }
    async fn context_scope_read(
        &self,
        ctx: &AccountContext,
        scope: &ContextScope,
        key: &ScopeKey,
    ) -> Result<(), PortError> {
        let grant = ctx
            .auth()
            .spaces()
            .get(&key.space)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.read_classes.is_empty() {
            return Err(DomainError::ResourceNotFound.into());
        }
        self.catalog_space(ctx, &key.space).await?;
        if let ContextScope::Project(project) = scope {
            self.catalog_project(ctx, project).await?;
        }
        Ok(())
    }
    pub async fn context_scope(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
    ) -> Result<ContextScopeInfo, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let db_result = budget
            .run(
                async {
                    let owner =
                        user_read(tx.inner_mut(), current.auth().principal().as_str()).await?;
                    let key = scope_key(&owner, &scope)?;
                    let revision = self
                        .context_scope_revision(tx.inner_mut(), &owner, &key)
                        .await?;
                    Ok::<_, PortError>((key, revision))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let (key, revision) = db_result?;
        budget
            .run(
                self.context_scope_read(&current, &scope, &key),
                CommitEffect::NotCommitted,
            )
            .await?;
        Ok(ContextScopeInfo { scope, revision })
    }
    async fn context_digest(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        extra: impl Serialize,
    ) -> Result<ContentDigest, PortError> {
        let owner = user_read(tx, ctx.auth().principal().as_str()).await?;
        let mut spaces = Vec::with_capacity(ctx.auth().spaces().len());
        for space in ctx.auth().spaces().keys() {
            spaces.push((
                space,
                super::spaces::admission(tx, space, false).await?.revision,
            ));
        }
        digest(ctx.auth(), (owner.metadata_revision, spaces, extra))
    }
}

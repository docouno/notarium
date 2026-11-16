//! Owner-bound episodes and independent per-Space delivery acknowledgements.
mod cursors;
use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    metadata::hidden,
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
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::FolderRef,
    ports::{control::*, *},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
enum Started {
    New(EpisodeId),
    Resumed(EpisodeId),
    Forked(EpisodeId),
    Ambiguous(Vec<EpisodeId>),
}
fn name(value: Option<&str>) -> Result<(), PortError> {
    if value.is_some_and(|value| {
        value.is_empty() || value.chars().count() > 128 || value.contains('\0')
    }) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
pub(super) async fn episode(
    tx: &mut Transaction,
    owner: &PrincipalId,
    id: &EpisodeId,
) -> Result<AgentEpisodesRow, PortError> {
    rows!(tx,AgentEpisodesRow,fetch_optional,
        "SELECT * FROM agent_episodes WHERE owner_id=$1 AND episode_id=$2",
        "SELECT * FROM v1_control.agent_episodes WHERE owner_id=$1 AND episode_id=$2";owner.as_str(),id.as_str())?
        .ok_or(DomainError::ResourceNotFound.into())
}
fn lifecycle(value: &str) -> Result<EpisodeLifecycle, PortError> {
    match value {
        "active" => Ok(EpisodeLifecycle::Active),
        "sleeping" => Ok(EpisodeLifecycle::Sleeping),
        "closed" => Ok(EpisodeLifecycle::Closed),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
async fn bump_owner(tx: &mut Transaction, owner: &UsersRow) -> Result<ControlRevision, PortError> {
    let revision = next(owner.revision)?;
    execute!(tx,"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&owner.user_id)?;
    Ok(ControlRevision::new(revision as u64)?)
}
impl ControlService {
    pub(super) async fn project_episode(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        row: AgentEpisodesRow,
    ) -> Result<AgentEpisode, PortError> {
        if row.owner_id != ctx.auth().principal().as_str() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let mut diagnostics = Vec::new();
        let project_hint = match (row.project_space, row.project_folder) {
            (Some(space), Some(folder)) => {
                let reference = FolderRef {
                    space_id: SpaceId::parse(&space)?,
                    folder_id: FolderId::parse(&folder)?,
                };
                match self.catalog_project(ctx, &reference).await {
                    Ok(_) => Some(reference),
                    Err(error) if hidden(&error) => {
                        diagnostics.push(EpisodeDiagnostic::ProjectUnavailable);
                        None
                    }
                    Err(error) => return Err(error),
                }
            }
            (None, None) => None,
            _ => return Err(invalid(ValidationReason::InvalidState)),
        };
        let active_role = if let Some(value) = row.active_role {
            let reference: AbilityRef = serde_json::from_str(&value)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if self
                .current_role_in_project(tx, ctx, &reference, project_hint.as_ref())
                .await?
            {
                Some(reference)
            } else {
                diagnostics.push(EpisodeDiagnostic::RoleUnavailable);
                None
            }
        } else {
            None
        };
        let id = EpisodeId::parse(&row.episode_id)?;
        let acknowledgements = self.acknowledgements(tx, ctx, Some(&id)).await?;
        Ok(AgentEpisode {
            id,
            owner: ctx.auth().principal().clone(),
            name: row.name,
            active_role,
            project_hint,
            lifecycle: lifecycle(&row.lifecycle)?,
            parent: row.parent_id.as_deref().map(EpisodeId::parse).transpose()?,
            revision: ControlRevision::new(row.revision as u64)?,
            acknowledgements,
            diagnostics,
        })
    }
    async fn project_started(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        result: Started,
    ) -> Result<EpisodeStartResult, PortError> {
        Ok(match result {
            Started::New(id) => {
                let row = episode(tx, ctx.auth().principal(), &id).await?;
                EpisodeStartResult::New(self.project_episode(tx, ctx, row).await?)
            }
            Started::Resumed(id) => {
                let row = episode(tx, ctx.auth().principal(), &id).await?;
                EpisodeStartResult::Resumed(self.project_episode(tx, ctx, row).await?)
            }
            Started::Forked(id) => {
                let row = episode(tx, ctx.auth().principal(), &id).await?;
                EpisodeStartResult::Forked(self.project_episode(tx, ctx, row).await?)
            }
            Started::Ambiguous(ids) => {
                if ids.len() > 200 {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                let mut choices = Vec::with_capacity(ids.len());
                for id in ids {
                    let row = episode(tx, ctx.auth().principal(), &id).await?;
                    choices.push(EpisodeChoice { id, name: row.name });
                }
                EpisodeStartResult::Ambiguous(choices)
            }
        })
    }
    pub async fn get_episode(
        &self,
        ctx: AccountContext,
        id: EpisodeId,
    ) -> Result<AgentEpisode, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let value = budget
            .run(
                async {
                    let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                    let row = episode(tx.inner_mut(), auth.principal(), &id).await?;
                    self.project_episode(
                        tx.inner_mut(),
                        &AccountContext::new(auth, budget.context(ctx.budget.request.clone())),
                        row,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(value)
    }
    pub async fn start_or_resume_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<StartEpisode>,
    ) -> Result<ControlCommit<EpisodeStartResult>, PortError> {
        match &request.input.selector {
            EpisodeSelector::New { name: value, .. } => name(value.as_deref())?,
            EpisodeSelector::Name(value) => name(Some(value))?,
            EpisodeSelector::Id(_) => (),
        }
        let command = Command::new(request.identity, "start-episode", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, value) = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            if let Some((revision, saved)) = command.replay::<Started>(tx.inner_mut()).await? {
                return Ok((revision, self.project_started(tx.inner_mut(), &current, saved.value).await?));
            }
            let owner = user(tx.inner_mut(), current.auth().principal().as_str()).await?;
            expect_revision(&owner, command.identity.expected)?;
            let now = self.clock.now_ms()?;
            let (existing, requested, chosen_name) = match &request.input.selector {
                EpisodeSelector::New { requested, name } => (None, requested.clone(), name.clone()),
                EpisodeSelector::Id(id) => (Some(episode(tx.inner_mut(), current.auth().principal(), id).await?), EpisodeId::from_bytes(crate::auth::token::random()?), None),
                EpisodeSelector::Name(name) => {
                    let matches = rows!(tx.inner_mut(),AgentEpisodesRow,fetch_all,
                        "SELECT * FROM agent_episodes WHERE owner_id=$1 AND name=$2 AND lifecycle<>'closed' ORDER BY episode_id LIMIT 201",
                        "SELECT * FROM v1_control.agent_episodes WHERE owner_id=$1 AND name=$2 AND lifecycle<>'closed' ORDER BY episode_id LIMIT 201";&owner.user_id,name)?;
                    if matches.len() > 200 { return Err(invalid(ValidationReason::BudgetExceeded)); }
                    if matches.len() > 1 {
                        let value = Started::Ambiguous(matches.iter().map(|row| EpisodeId::parse(&row.episode_id)).collect::<Result<_,_>>()?);
                        let revision = bump_owner(tx.inner_mut(), &owner).await?;
                        let saved = SavedResult { value, events: vec![] };
                        command.save(tx.inner_mut(), revision, &saved, now).await?;
                        return Ok((revision, self.project_started(tx.inner_mut(), &current, saved.value).await?));
                    }
                    (matches.into_iter().next(), EpisodeId::from_bytes(crate::auth::token::random()?), Some(name.clone()))
                },
            };
            let started = if let Some(mut old) = existing {
                if old.lifecycle == "closed" { return Err(invalid(ValidationReason::InvalidState)); }
                // An idle episode can resume without requiring an always-on timer.
                let idle = now.checked_sub(old.last_seen_at).is_some_and(|age| age >= 30 * 60 * 1000);
                if old.lifecycle == "sleeping" || idle {
                    old.revision = next(old.revision)?;
                    execute!(tx.inner_mut(),"UPDATE agent_episodes SET lifecycle='active',last_seen_at=$1,revision=$2 WHERE episode_id=$3","UPDATE v1_control.agent_episodes SET lifecycle='active',last_seen_at=$1,revision=$2 WHERE episode_id=$3";now,old.revision,&old.episode_id)?;
                    Started::Resumed(EpisodeId::parse(&old.episode_id)?)
                } else {
                    let row = AgentEpisodesRow { episode_id: requested.to_string(), owner_id: owner.user_id.clone(), name: old.name,
                        parent_id: Some(old.episode_id.clone()), active_role: old.active_role, project_space: old.project_space,
                        project_folder: old.project_folder, lifecycle: "active".into(), revision: 1, created_at: now,
                        last_seen_at: now, closed_at: None, calls: 0 };
                    let record = TargetRecord::AgentEpisodes(row); record.validate()?; record.insert(tx.inner_mut()).await?;
                    self.fork_acknowledgements(tx.inner_mut(), &old.episode_id, &requested).await?;
                    Started::Forked(requested)
                }
            } else {
                let collision = rows!(tx.inner_mut(),AgentEpisodesRow,fetch_optional,"SELECT * FROM agent_episodes WHERE episode_id=$1","SELECT * FROM v1_control.agent_episodes WHERE episode_id=$1";requested.as_str())?;
                if collision.is_some() { return Err(DomainError::ResourceNotFound.into()); }
                let row = AgentEpisodesRow { episode_id: requested.to_string(), owner_id: owner.user_id.clone(), name: chosen_name,
                    parent_id: None, active_role: None, project_space: request.input.project_hint.as_ref().map(|p| p.space_id.to_string()),
                    project_folder: request.input.project_hint.as_ref().map(|p| p.folder_id.to_string()), lifecycle: "active".into(),
                    revision: 1, created_at: now, last_seen_at: now, closed_at: None, calls: 0 };
                let record = TargetRecord::AgentEpisodes(row); record.validate()?; record.insert(tx.inner_mut()).await?;
                Started::New(requested)
            };
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            let saved = SavedResult { value: started, events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, self.project_started(tx.inner_mut(), &current, saved.value).await?))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit { value, revision })
    }
    pub async fn update_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeUpdate>,
    ) -> Result<ControlCommit<AgentEpisode>, PortError> {
        name(request.input.name.as_deref())?;
        let command = Command::new(request.identity, "update-episode", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, value) = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            if let Some((revision, saved)) = command.replay::<EpisodeId>(tx.inner_mut()).await? {
                let row = episode(tx.inner_mut(), current.auth().principal(), &saved.value).await?;
                return Ok((revision, self.project_episode(tx.inner_mut(), &current, row).await?));
            }
            let owner = user(tx.inner_mut(), current.auth().principal().as_str()).await?;
            expect_revision(&owner, command.identity.expected)?;
            let old = episode(tx.inner_mut(), current.auth().principal(), &request.input.episode).await?;
            if old.revision as u64 != request.input.expected.get() {
                return Err(DomainError::ControlRevisionConflict { current: ControlRevision::new(old.revision as u64)? }.into());
            }
            if old.lifecycle == "closed" { return Err(invalid(ValidationReason::InvalidState)); }
            if let Some(role) = &request.input.active_role
                && !self.current_role_in_project(tx.inner_mut(), &current, role, request.input.project_hint.as_ref()).await? { return Err(DomainError::ResourceNotFound.into()); }
            if let Some(project) = &request.input.project_hint { self.catalog_project(&current, project).await?; }
            let active_role = request.input.active_role.as_ref().map(serde_json::to_string).transpose().map_err(|_| invalid(ValidationReason::InvalidQuery))?;
            let project_space = request.input.project_hint.as_ref().map(|p| p.space_id.to_string());
            let project_folder = request.input.project_hint.as_ref().map(|p| p.folder_id.to_string());
            let state = match request.input.lifecycle { EpisodeLifecycle::Active => "active", EpisodeLifecycle::Sleeping => "sleeping", EpisodeLifecycle::Closed => "closed" };
            let now = self.clock.now_ms()?;
            let closed_at = (state == "closed").then_some(now);
            let episode_revision = next(old.revision)?;
            execute!(tx.inner_mut(),
                "UPDATE agent_episodes SET name=$1,active_role=$2,project_space=$3,project_folder=$4,lifecycle=$5,revision=$6,last_seen_at=$7,closed_at=$8 WHERE episode_id=$9",
                "UPDATE v1_control.agent_episodes SET name=$1,active_role=$2,project_space=$3,project_folder=$4,lifecycle=$5,revision=$6,last_seen_at=$7,closed_at=$8 WHERE episode_id=$9";
                &request.input.name,&active_role,&project_space,&project_folder,state,episode_revision,now,closed_at,&old.episode_id)?;
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            let saved = SavedResult { value: request.input.episode.clone(), events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            let row = episode(tx.inner_mut(), current.auth().principal(), &saved.value).await?;
            Ok((revision, self.project_episode(tx.inner_mut(), &current, row).await?))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit { revision, value })
    }
    /// Trusted accepted-call path. It cannot change role, project or acknowledgements.
    pub async fn touch_episode(&self, ctx: AccountContext, id: EpisodeId) -> Result<(), PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            let row = episode(tx.inner_mut(), auth.principal(), &id).await?;
            if row.lifecycle != "active" { return Err(invalid(ValidationReason::InvalidState)); }
            let now = self.clock.now_ms()?;
            if now.checked_sub(row.last_seen_at).is_some_and(|age| age >= 60_000) {
                execute!(tx.inner_mut(),"UPDATE agent_episodes SET last_seen_at=$1,calls=$2,revision=$3 WHERE episode_id=$4","UPDATE v1_control.agent_episodes SET last_seen_at=$1,calls=$2,revision=$3 WHERE episode_id=$4";now,next(row.calls)?,next(row.revision)?,id.as_str())?;
            }
            Ok(())
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
}

//! Owner-bound episodes and independent per-Space delivery acknowledgements.
mod cursors;
pub(crate) const OPEN_EPISODES_BY_NAME_SQLITE_SQL: &str = "SELECT * FROM agent_episodes WHERE owner_id=$1 AND name=$2 AND lifecycle<>'closed' AND episode_id>$3 ORDER BY episode_id LIMIT 64";
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
    auth::{ChatAudience, PrincipalKind},
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
pub(super) fn stored_project_ref(row: &AgentEpisodesRow) -> Result<Option<FolderRef>, PortError> {
    match (&row.project_space, &row.project_folder) {
        (Some(space), Some(folder)) => Ok(Some(FolderRef {
            space_id: SpaceId::parse(space)?,
            folder_id: FolderId::parse(folder)?,
        })),
        (None, None) => Ok(None),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}

pub(super) fn episode_project_admitted(
    auth: &notarium_core::auth::EngineAuthContext,
    personal_space: Option<&str>,
    project: Option<&FolderRef>,
    episode_name: Option<&str>,
    allow_shared_unnamed_chat: bool,
) -> bool {
    match project {
        Some(reference) => auth.spaces().get(&reference.space_id).is_some_and(|grant| {
            !grant.read_classes.is_empty()
                && grant
                    .project_root
                    .as_ref()
                    .is_none_or(|root| root == &reference.folder_id)
        }),
        None => {
            if !auth
                .spaces()
                .values()
                .any(|grant| !grant.read_classes.is_empty())
                || auth
                    .spaces()
                    .values()
                    .any(|grant| grant.project_root.is_some())
            {
                return false;
            }
            if !auth.is_space_narrowed() {
                return true;
            }
            if let Some(ps) = personal_space
                && let Ok(ps_id) = SpaceId::parse(ps)
                && auth.spaces().get(&ps_id).is_some_and(|grant| {
                    !grant.read_classes.is_empty() && grant.project_root.is_none()
                })
            {
                return true;
            }
            allow_shared_unnamed_chat
                && episode_name.is_none()
                && matches!(auth.kind(), PrincipalKind::AgentRun(_))
                && auth.chat_audience() == Some(ChatAudience::Shared)
        }
    }
}

pub(super) fn episode_visible_to_narrowed(
    auth: &notarium_core::auth::EngineAuthContext,
    personal_space: Option<&str>,
    project: Option<&FolderRef>,
    episode_name: Option<&str>,
    allow_shared_unnamed_chat: bool,
) -> bool {
    if !auth
        .spaces()
        .values()
        .any(|grant| !grant.read_classes.is_empty())
    {
        return false;
    }
    if auth.is_space_narrowed()
        || auth
            .spaces()
            .values()
            .any(|grant| grant.project_root.is_some())
    {
        episode_project_admitted(
            auth,
            personal_space,
            project,
            episode_name,
            allow_shared_unnamed_chat,
        )
    } else {
        true
    }
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
/// Activity and selection have independent concurrency boundaries. A tool heartbeat
/// cannot invalidate an in-flight role binding or overwrite a later heartbeat.
pub(super) async fn touch_active(
    tx: &mut Transaction,
    row: &AgentEpisodesRow,
    now: i64,
) -> Result<(), PortError> {
    if row.lifecycle == "active"
        && now
            .checked_sub(row.last_seen_at)
            .is_some_and(|age| age >= 60_000)
    {
        execute!(tx,
            "UPDATE agent_episodes SET last_seen_at=$1,calls=$2 WHERE episode_id=$3 AND last_seen_at=$4 AND lifecycle='active'",
            "UPDATE v1_control.agent_episodes SET last_seen_at=$1,calls=$2 WHERE episode_id=$3 AND last_seen_at=$4 AND lifecycle='active'";
            now,next(row.calls)?,&row.episode_id,row.last_seen_at)?;
    }
    Ok(())
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
pub(in super::super) struct LoadedEpisodeDb {
    pub(in super::super) row: AgentEpisodesRow,
    pub(in super::super) ack_rows: Vec<(SpaceId, Vec<u8>, i64)>,
    followed_role: Option<Result<AbilityRef, PortError>>,
}
enum LoadedStartedDb {
    New(LoadedEpisodeDb),
    Resumed(LoadedEpisodeDb),
    Forked(LoadedEpisodeDb),
    Ambiguous(Vec<EpisodeChoice>),
}
impl ControlService {
    pub(in super::super) async fn load_episode_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        id: &EpisodeId,
    ) -> Result<LoadedEpisodeDb, PortError> {
        self.load_episode_db_with_mode(tx, ctx, id, true).await
    }

    pub(in super::super) async fn load_episode_db_strict(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        id: &EpisodeId,
    ) -> Result<LoadedEpisodeDb, PortError> {
        self.load_episode_db_with_mode(tx, ctx, id, false).await
    }

    async fn load_episode_db_with_mode(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        id: &EpisodeId,
        allow_shared_unnamed_chat: bool,
    ) -> Result<LoadedEpisodeDb, PortError> {
        let row = episode(tx, ctx.auth().principal(), id).await?;
        if row.owner_id != ctx.auth().principal().as_str() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let owner = user_read(tx, ctx.auth().principal().as_str()).await?;
        if !episode_visible_to_narrowed(
            ctx.auth(),
            owner.personal_space_id.as_deref(),
            stored_project_ref(&row)?.as_ref(),
            row.name.as_deref(),
            allow_shared_unnamed_chat,
        ) {
            return Err(DomainError::ResourceNotFound.into());
        }
        let followed_role = if let Some(value) = &row.active_role {
            let reference: AbilityRef =
                serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidState))?;
            Some(
                match self.follow_ability_chain_db(tx, ctx, reference).await {
                    Ok(chain) if !chain.revision_mismatched => Ok(chain.terminal),
                    Ok(_) => Err(DomainError::ResourceNotFound.into()),
                    Err(error) => Err(error),
                },
            )
        } else {
            None
        };
        let ack_rows = self.acknowledgement_rows(tx, ctx, Some(id)).await?;
        Ok(LoadedEpisodeDb {
            row,
            ack_rows,
            followed_role,
        })
    }
    pub(in super::super) async fn resolve_episode_catalog(
        &self,
        ctx: &AccountContext,
        loaded: LoadedEpisodeDb,
    ) -> Result<(AgentEpisode, Option<(AbilityRef, AbilityDescriptor)>), PortError> {
        let mut space_cache = std::collections::BTreeMap::new();
        self.resolve_episode_catalog_cached(ctx, loaded, &mut space_cache)
            .await
    }
    pub(in super::super) async fn resolve_episode_catalog_cached(
        &self,
        ctx: &AccountContext,
        loaded: LoadedEpisodeDb,
        space_cache: &mut std::collections::BTreeMap<SpaceId, Option<CatalogSpace>>,
    ) -> Result<(AgentEpisode, Option<(AbilityRef, AbilityDescriptor)>), PortError> {
        let LoadedEpisodeDb {
            row,
            ack_rows,
            followed_role,
        } = loaded;
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
        let role_to_overlay = if let Some(followed) = followed_role {
            match self
                .check_active_role_catalog(ctx, followed, project_hint.as_ref())
                .await?
            {
                Some(raw) => Some((raw.reference.clone(), raw)),
                None => {
                    diagnostics.push(EpisodeDiagnostic::RoleUnavailable);
                    None
                }
            }
        } else {
            None
        };
        let id = EpisodeId::parse(&row.episode_id)?;
        let acknowledgements = self
            .resolve_acknowledgements_cached(ctx, ack_rows, space_cache)
            .await?;
        Ok((
            AgentEpisode {
                id,
                owner: ctx.auth().principal().clone(),
                name: row.name,
                active_role: None,
                project_hint,
                lifecycle: lifecycle(&row.lifecycle)?,
                parent: row.parent_id.as_deref().map(EpisodeId::parse).transpose()?,
                revision: ControlRevision::new(row.revision as u64)?,
                acknowledgements,
                diagnostics,
            },
            role_to_overlay,
        ))
    }
    async fn finish_episode_projection(
        &self,
        budget: &OperationBudget,
        effect: CommitEffect,
        ctx: &AccountContext,
        loaded: LoadedEpisodeDb,
    ) -> Result<AgentEpisode, PortError> {
        let (mut episode, role_to_overlay) = budget
            .run(self.resolve_episode_catalog(ctx, loaded), effect)
            .await?;
        if let Some((reference, raw)) = role_to_overlay {
            let mut rtx = self.store.read(budget.clone()).await?;
            let enabled = budget
                .run(
                    async {
                        Ok::<_, PortError>(
                            self.overlay(rtx.inner_mut(), ctx, raw, episode.project_hint.as_ref())
                                .await?
                                .enabled,
                        )
                    },
                    effect,
                )
                .await;
            budget.run(rtx.finish(), effect).await?;
            if enabled? {
                episode.active_role = Some(reference);
            } else {
                episode.diagnostics.push(EpisodeDiagnostic::RoleUnavailable);
            }
        }
        Ok(episode)
    }
    async fn load_started_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        result: Started,
    ) -> Result<LoadedStartedDb, PortError> {
        Ok(match result {
            Started::New(id) => {
                LoadedStartedDb::New(self.load_episode_db_strict(tx, ctx, &id).await?)
            }
            Started::Resumed(id) => {
                LoadedStartedDb::Resumed(self.load_episode_db_strict(tx, ctx, &id).await?)
            }
            Started::Forked(id) => {
                LoadedStartedDb::Forked(self.load_episode_db_strict(tx, ctx, &id).await?)
            }
            Started::Ambiguous(ids) => {
                if ids.len() > 200 {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                let owner = user_read(tx, ctx.auth().principal().as_str()).await?;
                let mut choices = Vec::with_capacity(ids.len());
                for id in ids {
                    let row = episode(tx, ctx.auth().principal(), &id).await?;
                    if !episode_visible_to_narrowed(
                        ctx.auth(),
                        owner.personal_space_id.as_deref(),
                        stored_project_ref(&row)?.as_ref(),
                        row.name.as_deref(),
                        false,
                    ) {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    choices.push(EpisodeChoice { id, name: row.name });
                }
                LoadedStartedDb::Ambiguous(choices)
            }
        })
    }
    pub async fn get_episode(
        &self,
        ctx: AccountContext,
        id: EpisodeId,
    ) -> Result<AgentEpisode, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let loaded = budget
            .run(
                self.load_episode_db(rtx.inner_mut(), &current, &id),
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        self.finish_episode_projection(&budget, CommitEffect::NotCommitted, &current, loaded?)
            .await
    }
    pub async fn start_or_resume_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<StartEpisode>,
    ) -> Result<ControlCommit<EpisodeStartResult>, PortError> {
        if matches!(
            ctx.auth().kind(),
            PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        let guard = request.input.guard;
        match &request.input.selector {
            EpisodeSelector::New { name: value, .. } => name(value.as_deref())?,
            EpisodeSelector::Name(value) => name(Some(value))?,
            EpisodeSelector::Id(_) | EpisodeSelector::Resume(_) => (),
        }
        #[derive(Serialize)]
        struct StartEpisodeHash<'a> {
            selector: &'a EpisodeSelector,
            project_hint: &'a Option<FolderRef>,
        }
        let command = Command::new(
            request.identity,
            "start-episode",
            &StartEpisodeHash {
                selector: &request.input.selector,
                project_hint: &request.input.project_hint,
            },
        )?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let prechecked_project = if matches!(
            request.input.selector,
            EpisodeSelector::New { .. } | EpisodeSelector::Name(_)
        ) && let Some(project) = &request.input.project_hint
        {
            let current_pre = self.current_account(&ctx, &budget).await?;
            budget
                .run(
                    self.catalog_project(&current_pre, project),
                    CommitEffect::NotCommitted,
                )
                .await
                .map(|_| ())
        } else {
            Ok(())
        };
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, current, started_value, replayed_loaded) = budget.run(async {
            let auth = self.revalidate_with_keeper(tx.inner_mut(), ctx.auth(), keeper.as_ref()).await?;
            if matches!(auth.kind(), PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)) {
                return Err(DomainError::AccessDenied.into());
            }
            if auth.taint().is_tainted() {
                return Err(DomainError::CrossSpaceTainted.into());
            }
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            let owner = user(tx.inner_mut(), current.auth().principal().as_str()).await?;
            if let Some((revision, saved)) = command.replay::<Started>(tx.inner_mut()).await? {
                let loaded = self.load_started_db(tx.inner_mut(), &current, saved.value).await?;
                return Ok((revision, current, None, Some(loaded)));
            }
            if guard == EpisodeRevisionGuard::Account {
                expect_revision(&owner, command.identity.expected)?;
            }
            let now = self.clock.now_ms()?;
            let (existing, requested, chosen_name) = match &request.input.selector {
                EpisodeSelector::New { requested, name } => (None, requested.clone(), name.clone()),
                EpisodeSelector::Id(id) | EpisodeSelector::Resume(id) => (Some(episode(tx.inner_mut(), current.auth().principal(), id).await?), EpisodeId::from_bytes(crate::auth::token::random()?), None),
                EpisodeSelector::Name(name) => {
                    let mut after = String::new();
                    let mut admitted_rows: Vec<AgentEpisodesRow> = Vec::new();
                    let mut scanned = 0usize;
                    loop {
                        let batch = rows!(
                            tx.inner_mut(),
                            AgentEpisodesRow,
                            fetch_all,
                            OPEN_EPISODES_BY_NAME_SQLITE_SQL,
                            "SELECT * FROM v1_control.agent_episodes WHERE owner_id=$1 AND name=$2 AND lifecycle<>'closed' AND episode_id>$3 ORDER BY episode_id LIMIT 64";
                            &owner.user_id,
                            name,
                            &after
                        )?;
                        let batch_len = batch.len();
                        for row in batch {
                            scanned = scanned.saturating_add(1);
                            after = row.episode_id.clone();
                            let project = stored_project_ref(&row)?;
                            if !episode_project_admitted(
                                current.auth(),
                                owner.personal_space_id.as_deref(),
                                project.as_ref(),
                                row.name.as_deref(),
                                false,
                            ) {
                                continue;
                            }
                            admitted_rows.push(row);
                            if admitted_rows.len() > 200 {
                                return Err(invalid(ValidationReason::BudgetExceeded));
                            }
                        }
                        if batch_len < 64 {
                            break;
                        }
                        if scanned >= 4096 {
                            return Err(invalid(ValidationReason::BudgetExceeded));
                        }
                    }
                    if admitted_rows.len() > 1 {
                        let admitted = admitted_rows
                            .iter()
                            .map(|row| EpisodeId::parse(&row.episode_id))
                            .collect::<Result<Vec<_>, _>>()?;
                        let value = Started::Ambiguous(admitted);
                        let revision = bump_owner(tx.inner_mut(), &owner).await?;
                        let saved = SavedResult { value, events: vec![] };
                        command.save(tx.inner_mut(), revision, &saved, now).await?;
                        return Ok((revision, current, Some(saved.value), None));
                    }
                    (
                        admitted_rows.into_iter().next(),
                        EpisodeId::from_bytes(crate::auth::token::random()?),
                        Some(name.clone()),
                    )
                },
            };
            let started = if let Some(mut old) = existing {
                if !episode_project_admitted(
                    current.auth(),
                    owner.personal_space_id.as_deref(),
                    stored_project_ref(&old)?.as_ref(),
                    old.name.as_deref(),
                    false,
                ) {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if guard == EpisodeRevisionGuard::Target && let Some(project) = &request.input.project_hint
                    && (old.project_space.as_deref() != Some(project.space_id.as_str())
                        || old.project_folder.as_deref() != Some(project.folder_id.as_str())) {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
                if old.lifecycle == "closed" { return Err(invalid(ValidationReason::InvalidState)); }
                // An idle episode can resume without requiring an always-on timer;
                // EpisodeSelector::Resume always wakes or touches in place without forking.
                let idle = now.checked_sub(old.last_seen_at).is_some_and(|age| age >= 30 * 60 * 1000);
                let resume_in_place = matches!(request.input.selector, EpisodeSelector::Resume(_));
                if old.lifecycle == "sleeping" || idle || resume_in_place {
                    old.revision = next(old.revision)?;
                    execute!(tx.inner_mut(),"UPDATE agent_episodes SET lifecycle='active',last_seen_at=$1,revision=$2 WHERE episode_id=$3","UPDATE v1_control.agent_episodes SET lifecycle='active',last_seen_at=$1,revision=$2 WHERE episode_id=$3";now,old.revision,&old.episode_id)?;
                    Started::Resumed(EpisodeId::parse(&old.episode_id)?)
                } else {
                    let row = AgentEpisodesRow { episode_id: requested.to_string(), owner_id: owner.user_id.clone(), name: old.name,
                        parent_id: Some(old.episode_id.clone()), active_role: old.active_role, project_space: old.project_space,
                        project_folder: old.project_folder, lifecycle: "active".into(), revision: 1, created_at: now,
                        last_seen_at: now, closed_at: None, calls: 0 };
                    let record = TargetRecord::from(row); record.validate()?; record.insert_or_conflict(tx.inner_mut()).await?;
                    self.fork_acknowledgements(tx.inner_mut(), &old.episode_id, &requested).await?;
                    Started::Forked(requested)
                }
            } else {
                prechecked_project?;
                if !episode_project_admitted(
                    current.auth(),
                    owner.personal_space_id.as_deref(),
                    request.input.project_hint.as_ref(),
                    chosen_name.as_deref(),
                    false,
                ) {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let collision = rows!(tx.inner_mut(),AgentEpisodesRow,fetch_optional,"SELECT * FROM agent_episodes WHERE episode_id=$1","SELECT * FROM v1_control.agent_episodes WHERE episode_id=$1";requested.as_str())?;
                if collision.is_some() { return Err(DomainError::ResourceNotFound.into()); }
                let row = AgentEpisodesRow { episode_id: requested.to_string(), owner_id: owner.user_id.clone(), name: chosen_name,
                    parent_id: None, active_role: None, project_space: request.input.project_hint.as_ref().map(|p| p.space_id.to_string()),
                    project_folder: request.input.project_hint.as_ref().map(|p| p.folder_id.to_string()), lifecycle: "active".into(),
                    revision: 1, created_at: now, last_seen_at: now, closed_at: None, calls: 0 };
                let record = TargetRecord::from(row); record.validate()?; record.insert_or_conflict(tx.inner_mut()).await?;
                Started::New(requested)
            };
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            let saved = SavedResult { value: started, events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, current, Some(saved.value), None))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        let value = async {
            let loaded = match replayed_loaded {
                Some(loaded) => loaded,
                None => {
                    let started_value =
                        started_value.ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                    let mut rtx = self.store.read(budget.clone()).await?;
                    let loaded = budget
                        .run(
                            self.load_started_db(rtx.inner_mut(), &current, started_value),
                            CommitEffect::Unknown,
                        )
                        .await;
                    budget.run(rtx.finish(), CommitEffect::Unknown).await?;
                    loaded?
                }
            };
            let value = match loaded {
                LoadedStartedDb::New(ep) => EpisodeStartResult::New(
                    self.finish_episode_projection(&budget, CommitEffect::Unknown, &current, ep)
                        .await?,
                ),
                LoadedStartedDb::Resumed(ep) => EpisodeStartResult::Resumed(
                    self.finish_episode_projection(&budget, CommitEffect::Unknown, &current, ep)
                        .await?,
                ),
                LoadedStartedDb::Forked(ep) => EpisodeStartResult::Forked(
                    self.finish_episode_projection(&budget, CommitEffect::Unknown, &current, ep)
                        .await?,
                ),
                LoadedStartedDb::Ambiguous(choices) => EpisodeStartResult::Ambiguous(choices),
            };
            Ok(value)
        }
        .await
        .map_err(post_commit_episode_read_error)?;
        Ok(ControlCommit { value, revision })
    }
    pub async fn named_episode_project_hint(
        &self,
        ctx: AccountContext,
        episode_name: String,
    ) -> Result<NamedEpisodePreview, PortError> {
        name(Some(&episode_name))?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let preview = budget
            .run(
                async {
                    let owner =
                        user_read(tx.inner_mut(), current.auth().principal().as_str()).await?;
                    let mut after = String::new();
                    let mut admitted: Vec<Option<FolderRef>> = Vec::with_capacity(2);
                    let mut scanned = 0usize;
                    loop {
                        let matches = rows!(
                            tx.inner_mut(),
                            AgentEpisodesRow,
                            fetch_all,
                            OPEN_EPISODES_BY_NAME_SQLITE_SQL,
                            "SELECT * FROM v1_control.agent_episodes WHERE owner_id=$1 AND name=$2 AND lifecycle<>'closed' AND episode_id>$3 ORDER BY episode_id LIMIT 64";
                            current.auth().principal().as_str(),
                            &episode_name,
                            &after
                        )?;
                        let batch_len = matches.len();
                        for row in matches {
                            scanned = scanned.saturating_add(1);
                            after = row.episode_id.clone();
                            let project = stored_project_ref(&row)?;
                            if !episode_project_admitted(
                                current.auth(),
                                owner.personal_space_id.as_deref(),
                                project.as_ref(),
                                row.name.as_deref(),
                                false,
                            ) {
                                continue;
                            }
                            admitted.push(project);
                            if admitted.len() >= 2 {
                                return Ok(NamedEpisodePreview::Ambiguous);
                            }
                        }
                        if batch_len < 64 {
                            break;
                        }
                        if scanned >= 4096 {
                            return Err(invalid(ValidationReason::BudgetExceeded));
                        }
                    }
                    match admitted.pop() {
                        None => Ok(NamedEpisodePreview::NoMatch),
                        Some(project) => Ok(NamedEpisodePreview::Unique(project)),
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        match preview? {
            NamedEpisodePreview::Unique(Some(reference)) => {
                match budget
                    .run(
                        self.catalog_project(&current, &reference),
                        CommitEffect::NotCommitted,
                    )
                    .await
                {
                    Ok(_) => Ok(NamedEpisodePreview::Unique(Some(reference))),
                    Err(error) if hidden(&error) => Ok(NamedEpisodePreview::ProjectUnavailable),
                    Err(error) => Err(error),
                }
            }
            other => Ok(other),
        }
    }
    pub async fn update_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeMutation>,
    ) -> Result<ControlCommit<AgentEpisode>, PortError> {
        Box::pin(self.update_episode_inner(ctx, request)).await
    }

    async fn update_episode_inner(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeMutation>,
    ) -> Result<ControlCommit<AgentEpisode>, PortError> {
        let (episode_id, expected, project_hint, active_role, full_fields) = match &request.input {
            EpisodeMutation::Full(update) => {
                if ctx.auth().bearer_scope() == Some(BearerScope::Read) {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                if matches!(
                    ctx.auth().kind(),
                    PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
                ) {
                    return Err(DomainError::AccessDenied.into());
                }
                if ctx.auth().taint().is_tainted() {
                    return Err(DomainError::CrossSpaceTainted.into());
                }
                name(update.name.as_deref())?;
                (
                    update.episode.clone(),
                    update.expected,
                    update.project_hint.clone(),
                    update.active_role.clone(),
                    Some((update.name.clone(), update.lifecycle)),
                )
            }
            EpisodeMutation::BindRole(bind) => {
                if matches!(
                    ctx.auth().kind(),
                    PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
                ) || ctx.auth().chat_audience() == Some(ChatAudience::Shared)
                    || ctx.auth().bearer_scope() == Some(BearerScope::Read)
                {
                    return Err(DomainError::AccessDenied.into());
                }
                if ctx.auth().taint().is_tainted() {
                    return Err(DomainError::CrossSpaceTainted.into());
                }
                (
                    bind.episode.clone(),
                    bind.expected,
                    bind.project_hint.clone(),
                    Some(bind.active_role.clone()),
                    None,
                )
            }
        };
        let command = match &request.input {
            EpisodeMutation::Full(update) => {
                Command::new(request.identity, "update-episode", update)?
            }
            EpisodeMutation::BindRole(bind) => {
                Command::new(request.identity, "update-episode", ("bind-role", bind))?
            }
        };
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (prechecked_project, prechecked_role, prechecked_preserved) = {
            let current = self.current_account(&ctx, &budget).await?;
            let project_check = if let Some(project) = &project_hint {
                budget
                    .run(
                        self.catalog_project(&current, project),
                        CommitEffect::NotCommitted,
                    )
                    .await
                    .map(|_| ())
            } else {
                Ok(())
            };
            let preserved = if full_fields.is_none() && project_hint.is_none() {
                let mut rtx = self.store.read(budget.clone()).await?;
                let existing = budget
                    .run(
                        episode(rtx.inner_mut(), current.auth().principal(), &episode_id),
                        CommitEffect::NotCommitted,
                    )
                    .await;
                budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
                match existing {
                    Ok(row) => match stored_project_ref(&row) {
                        Ok(Some(reference)) => {
                            let checked = match budget
                                .run(
                                    self.catalog_project(&current, &reference),
                                    CommitEffect::NotCommitted,
                                )
                                .await
                            {
                                Ok(_) => Ok(reference),
                                Err(error) if hidden(&error) => {
                                    Err(DomainError::ResourceNotFound.into())
                                }
                                Err(error) => Err(error),
                            };
                            Some(checked)
                        }
                        Ok(None) => None,
                        Err(error) => Some(Err(error)),
                    },
                    Err(PortError::Domain(DomainError::ResourceNotFound)) => None,
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            let role = if project_check.is_ok()
                && let Some(role) = &active_role
            {
                match budget
                    .run(
                        self.raw_ability(&current, role.identity()),
                        CommitEffect::NotCommitted,
                    )
                    .await
                {
                    Ok(raw) if raw.reference == *role => Ok(Some(raw)),
                    Ok(_) => Err(DomainError::ResourceNotFound.into()),
                    Err(error) if hidden(&error) => Err(DomainError::ResourceNotFound.into()),
                    Err(error) => Err(error),
                }
            } else {
                Ok(None)
            };
            (project_check, role, preserved)
        };
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, current, saved_id) = budget.run(async {
            let auth = self.revalidate_with_keeper(tx.inner_mut(), ctx.auth(), keeper.as_ref()).await?;
            if full_fields.is_some() {
                if auth.bearer_scope() == Some(BearerScope::Read) {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                if matches!(auth.kind(), PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)) {
                    return Err(DomainError::AccessDenied.into());
                }
                if auth.taint().is_tainted() {
                    return Err(DomainError::CrossSpaceTainted.into());
                }
            } else {
                if matches!(
                    auth.kind(),
                    PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
                ) || auth.chat_audience() == Some(ChatAudience::Shared)
                    || auth.bearer_scope() == Some(BearerScope::Read)
                {
                    return Err(DomainError::AccessDenied.into());
                }
                if auth.taint().is_tainted() {
                    return Err(DomainError::CrossSpaceTainted.into());
                }
            }
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            let owner = user(tx.inner_mut(), current.auth().principal().as_str()).await?;
            if let Some((revision, saved)) = command.replay::<EpisodeId>(tx.inner_mut()).await? {
                let replayed = episode(tx.inner_mut(), current.auth().principal(), &saved.value).await?;
                let replayed_project = stored_project_ref(&replayed)?;
                if !episode_project_admitted(
                    current.auth(),
                    owner.personal_space_id.as_deref(),
                    replayed_project.as_ref(),
                    replayed.name.as_deref(),
                    false,
                ) {
                    return Err(DomainError::ResourceNotFound.into());
                }
                return Ok((revision, current, saved.value));
            }
            prechecked_project?;
            let prechecked_role = prechecked_role?;
            if full_fields.is_some() {
                expect_revision(&owner, command.identity.expected)?;
            }
            let old = episode(tx.inner_mut(), current.auth().principal(), &episode_id).await?;
            let old_project = stored_project_ref(&old)?;
            if !episode_project_admitted(
                current.auth(),
                owner.personal_space_id.as_deref(),
                old_project.as_ref(),
                old.name.as_deref(),
                false,
            ) {
                return Err(DomainError::ResourceNotFound.into());
            }
            if old.revision as u64 != expected.get() {
                return Err(DomainError::ControlRevisionConflict { current: ControlRevision::new(old.revision as u64)? }.into());
            }
            if old.lifecycle == "closed" { return Err(invalid(ValidationReason::InvalidState)); }
            let is_full = full_fields.is_some();
            let effective_project = if !is_full && project_hint.is_none() {
                match old_project {
                    Some(preserved) => match prechecked_preserved {
                        Some(Ok(checked)) if checked == preserved => Some(preserved),
                        Some(Ok(_)) | None => return Err(DomainError::ResourceNotFound.into()),
                        Some(Err(error)) => return Err(error),
                    },
                    None => None,
                }
            } else {
                project_hint.clone()
            };
            let next_name_preview = match &full_fields {
                Some((name, _)) => name.as_deref(),
                None => old.name.as_deref(),
            };
            if !episode_project_admitted(
                current.auth(),
                owner.personal_space_id.as_deref(),
                effective_project.as_ref(),
                next_name_preview,
                false,
            ) {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let Some(raw) = prechecked_role
                && !self
                    .current_role_db_only(
                        tx.inner_mut(),
                        &current,
                        raw,
                        effective_project.as_ref(),
                    )
                    .await?
            {
                return Err(DomainError::ResourceNotFound.into());
            }
            let (next_name, next_lifecycle) = match full_fields {
                Some((name, lc)) => (name, lc),
                None => (old.name.clone(), lifecycle(&old.lifecycle)?),
            };
            let active_role = active_role.as_ref().map(serde_json::to_string).transpose().map_err(|_| invalid(ValidationReason::InvalidQuery))?;
            let project_space = effective_project.as_ref().map(|p| p.space_id.to_string());
            let project_folder = effective_project.as_ref().map(|p| p.folder_id.to_string());
            let state = match next_lifecycle { EpisodeLifecycle::Active => "active", EpisodeLifecycle::Sleeping => "sleeping", EpisodeLifecycle::Closed => "closed" };
            let now = self.clock.now_ms()?;
            let closed_at = (state == "closed").then_some(now);
            let episode_revision = next(old.revision)?;
            execute!(tx.inner_mut(),
                "UPDATE agent_episodes SET name=$1,active_role=$2,project_space=$3,project_folder=$4,lifecycle=$5,revision=$6,last_seen_at=$7,closed_at=$8 WHERE episode_id=$9",
                "UPDATE v1_control.agent_episodes SET name=$1,active_role=$2,project_space=$3,project_folder=$4,lifecycle=$5,revision=$6,last_seen_at=$7,closed_at=$8 WHERE episode_id=$9";
                &next_name,&active_role,&project_space,&project_folder,state,episode_revision,now,closed_at,&old.episode_id)?;
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            let saved = SavedResult { value: episode_id.clone(), events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, current, saved.value))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        let value = async {
            let mut rtx = self.store.read(budget.clone()).await?;
            let loaded = budget
                .run(
                    self.load_episode_db(rtx.inner_mut(), &current, &saved_id),
                    CommitEffect::Unknown,
                )
                .await;
            budget.run(rtx.finish(), CommitEffect::Unknown).await?;
            self.finish_episode_projection(&budget, CommitEffect::Unknown, &current, loaded?)
                .await
        }
        .await
        .map_err(post_commit_episode_read_error)?;
        Ok(ControlCommit { revision, value })
    }
    /// Trusted accepted-call path. It cannot change role, project or acknowledgements.
    pub async fn touch_episode(&self, ctx: AccountContext, id: EpisodeId) -> Result<(), PortError> {
        if matches!(
            ctx.auth().kind(),
            PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)
        ) {
            return Err(access_denied());
        }
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        budget
            .run(
                async {
                    let auth = self
                        .revalidate_with_keeper(tx.inner_mut(), ctx.auth(), keeper.as_ref())
                        .await?;
                    if matches!(
                        auth.kind(),
                        PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)
                    ) {
                        return Err(access_denied());
                    }
                    if auth.taint().is_tainted() {
                        return Err(DomainError::CrossSpaceTainted.into());
                    }
                    let owner = user_read(tx.inner_mut(), auth.principal().as_str()).await?;
                    let row = episode(tx.inner_mut(), auth.principal(), &id).await?;
                    if !episode_project_admitted(
                        &auth,
                        owner.personal_space_id.as_deref(),
                        stored_project_ref(&row)?.as_ref(),
                        row.name.as_deref(),
                        false,
                    ) {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if row.lifecycle != "active" {
                        return Err(invalid(ValidationReason::InvalidState));
                    }
                    touch_active(tx.inner_mut(), &row, self.clock.now_ms()?).await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await
    }
}

fn post_commit_episode_read_error(error: PortError) -> PortError {
    let diagnostic = ContentDigest::from_bytes(
        *blake3::hash(format!("episode-post-commit-read:{}", error.code()).as_bytes()).as_bytes(),
    );
    let make = || {
        notarium_core::error::OperationalFailure::new(
            diagnostic,
            CommitEffect::Unknown,
            notarium_core::error::RetryAdvice::RetrySameCommand,
            true,
        )
        .expect("same-command retry has durable identity")
    };
    match error {
        PortError::Cancelled(f)
            if f.effect() == CommitEffect::Unknown
                && f.retry() == notarium_core::error::RetryAdvice::RetrySameCommand =>
        {
            PortError::Cancelled(f)
        }
        PortError::DeadlineExceeded(f)
            if f.effect() == CommitEffect::Unknown
                && f.retry() == notarium_core::error::RetryAdvice::RetrySameCommand =>
        {
            PortError::DeadlineExceeded(f)
        }
        PortError::Unavailable(f)
            if f.effect() == CommitEffect::Unknown
                && f.retry() == notarium_core::error::RetryAdvice::RetrySameCommand =>
        {
            PortError::Unavailable(f)
        }
        PortError::Internal(f)
            if f.effect() == CommitEffect::Unknown
                && f.retry() == notarium_core::error::RetryAdvice::RetrySameCommand =>
        {
            PortError::Internal(f)
        }
        PortError::Cancelled(_) => PortError::Cancelled(make()),
        PortError::DeadlineExceeded(_) => PortError::DeadlineExceeded(make()),
        PortError::Unavailable(_) => PortError::Unavailable(make()),
        PortError::Internal(_) => PortError::Internal(make()),
        PortError::Domain(_) => PortError::Unavailable(make()),
    }
}

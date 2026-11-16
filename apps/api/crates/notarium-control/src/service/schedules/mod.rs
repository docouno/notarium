//! Atomic schedule claims and short-lived, independently revalidated run grants.
mod mutations;
mod queries;
mod runs;
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
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::*,
    classes::DocClass,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope},
    ports::{control::*, *},
    value::Timestamp,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
    time::Duration,
};

fn json(value: &impl Serialize) -> Result<String, PortError> {
    serde_json::to_string(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
fn parse<T: DeserializeOwned>(value: &str) -> Result<T, PortError> {
    serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidState))
}
fn ms(value: Timestamp) -> Result<i64, PortError> {
    if !value.nanosecond().is_multiple_of(1_000_000) {
        return Err(invalid(ValidationReason::InvalidTimestamp));
    }
    value
        .unix_seconds()
        .checked_mul(1000)
        .and_then(|v| v.checked_add(i64::from(value.nanosecond() / 1_000_000)))
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))
}
use crate::store::values::schedule_timestamp as timestamp;
fn validate(
    def: &ScheduleDefinition,
    next_slot: Timestamp,
    ceiling: RunLimits,
) -> Result<(), PortError> {
    if def.title.is_empty()
        || def.title.len() > 512
        || def.title.chars().count() > 128
        || def.title.contains('\0')
        || def.init_prompt.is_empty()
        || def.init_prompt.len() > 32768
        || def.init_prompt.contains('\0')
        || def.cron.len() > 256
        || def.timezone.len() > 128
        || !def.limits.fits(ceiling)
        || def
            .project
            .as_ref()
            .is_some_and(|p| p.space_id != def.space)
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    let cron =
        cron::Schedule::from_str(&def.cron).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let zone = chrono_tz::Tz::from_str(&def.timezone)
        .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let slot = ms(next_slot)?;
    let date = chrono::DateTime::from_timestamp_millis(slot)
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    if slot % 1000 != 0 || !cron.includes(date.with_timezone(&zone)) {
        return Err(invalid(ValidationReason::InvalidTimestamp));
    }
    Ok(())
}
fn schedule_info(row: &AgentSchedulesRow) -> Result<AgentSchedule, PortError> {
    let space = SpaceId::parse(&row.space_id)?;
    Ok(AgentSchedule {
        id: ScheduleId::parse(&row.schedule_id)?,
        owner: PrincipalId::parse(&row.owner_id)?,
        definition: ScheduleDefinition {
            space: space.clone(),
            project: row
                .project_folder_id
                .as_deref()
                .map(|id| {
                    FolderId::parse(id).map(|folder_id| FolderRef {
                        space_id: space,
                        folder_id,
                    })
                })
                .transpose()?,
            title: row.title.clone(),
            init_prompt: row.init_prompt.clone(),
            cron: row.cron_expr.clone(),
            timezone: row.timezone.clone(),
            approved_role: parse(&row.approved_role)?,
            limits: parse(&row.budgets)?,
        },
        paused_reason: row
            .paused_reason
            .as_ref()
            .map(|value| parse(&json(value)?))
            .transpose()?,
        revision: ControlRevision::new(row.revision as u64)?,
        config_revision: ControlRevision::new(row.config_revision as u64)?,
        next_slot: timestamp(row.next_slot_utc_ms)?,
    })
}
fn receipt(row: &AgentScheduleRunsRow) -> Result<ScheduleRunReceipt, PortError> {
    Ok(ScheduleRunReceipt {
        schedule: ScheduleId::parse(&row.schedule_id)?,
        run: AgentRunId::parse(&row.run_id)?,
        lease: LeaseEpoch::new(row.lease_epoch as u64)?,
        slot: timestamp(row.slot_utc_ms)?,
        reserved_next_slot: timestamp(row.reserved_next_slot)?,
        claimed_revision: ControlRevision::new(row.claimed_schedule_revision as u64)?,
        status: match row.status.as_str() {
            "claimed" => ScheduleRunStatus::Claimed,
            "running" => ScheduleRunStatus::Running,
            other => ScheduleRunStatus::Terminal(parse(&json(&other)?)?),
        },
    })
}
async fn schedule(
    tx: &mut Transaction,
    id: &ScheduleId,
    lock: bool,
) -> Result<AgentSchedulesRow, PortError> {
    let row = if lock {
        rows!(tx,AgentSchedulesRow,fetch_optional,"SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1 FOR UPDATE";id.as_str())?
    } else {
        rows!(tx,AgentSchedulesRow,fetch_optional,"SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1 FOR SHARE";id.as_str())?
    };
    row.ok_or(DomainError::ResourceNotFound.into())
}
fn expect(row: &AgentSchedulesRow, expected: ControlRevision) -> Result<(), PortError> {
    if row.revision as u64 != expected.get() {
        return Err(DomainError::ControlRevisionConflict {
            current: ControlRevision::new(row.revision as u64)?,
        }
        .into());
    }
    Ok(())
}
impl ControlService {
    async fn observe_schedule(
        &self,
        budget: &OperationBudget,
        id: &ScheduleId,
    ) -> Result<AgentSchedulesRow, PortError> {
        budget.run(async { read_rows!(&self.store.backend,AgentSchedulesRow,fetch_optional,
            "SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1";id.as_str())?.ok_or(DomainError::ResourceNotFound.into())
        },CommitEffect::NotCommitted).await
    }
    /// Caller locks the owner first. Space locks precede schedule/run locks on
    /// every dispatch and mutation path; membership mutation uses the same lock.
    async fn schedule_source(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        space: &SpaceId,
        credential: AuthenticatedCredential,
        source: GrantId,
    ) -> Result<Option<(EngineAuthContext, SpaceAdmissionRow)>, PortError> {
        let admission = rows!(tx,SpaceAdmissionRow,fetch_optional,"SELECT * FROM space_admission WHERE space_id=$1","SELECT * FROM v1_control.space_admission WHERE space_id=$1 FOR SHARE";space.as_str())?;
        let Some(admission) = admission else {
            return Ok(None);
        };
        let member = rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 FOR SHARE";space.as_str(),&owner.user_id)?;
        let Some(member) = member else {
            return Ok(None);
        };
        if admission.state != "active"
            || member.admission != "active"
            || !matches!(member.role.as_str(), "owner" | "editor")
            || owner.disabled_at.is_some()
        {
            return Ok(None);
        }
        let role = if member.role == "owner" {
            SpaceRole::Owner
        } else {
            SpaceRole::Editor
        };
        let auth = EngineAuthContext::for_human(
            VerifiedHuman::attest(
                PrincipalId::parse(&owner.user_id)?,
                source,
                BTreeMap::from([(
                    space.clone(),
                    SpaceGrant {
                        role,
                        read_classes: DocClass::all(),
                        write_classes: BTreeSet::from([DocClass::AgentMemory]),
                        project_root: None,
                    },
                )]),
                false,
            )
            .with_credential(credential),
        );
        Ok(Some((auth, admission)))
    }
    pub(super) async fn scheduled_context(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        credential: AuthenticatedCredential,
    ) -> Result<EngineAuthContext, PortError> {
        let AuthenticatedCredential::ScheduledRun {
            schedule: id,
            run,
            lease,
        } = &credential
        else {
            return Err(denied());
        };
        // This first read observes immutable owner/Space only, without reversing
        // the authority lock order. Changes to either are forbidden by the API.
        let observed = rows!(tx,AgentSchedulesRow,fetch_optional,"SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1";id.as_str())?.ok_or_else(denied)?;
        if observed.owner_id != owner.user_id {
            return Err(denied());
        }
        let space = SpaceId::parse(&observed.space_id)?;
        let (source, admission) = self
            .schedule_source(
                tx,
                owner,
                &space,
                credential.clone(),
                grant("scheduled-run", run.as_str()),
            )
            .await?
            .ok_or_else(denied)?;
        let current = schedule(tx, id, false).await?;
        let running = rows!(tx,AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE run_id=$1","SELECT * FROM v1_control.agent_schedule_runs WHERE run_id=$1 FOR SHARE";run.as_str())?.ok_or_else(denied)?;
        let now = self.clock.now_ms()?;
        if current.deleted_at.is_some()
            || current.paused_reason.is_some()
            || running.schedule_id != id.as_str()
            || running.lease_epoch as u64 != lease.get()
            || !matches!(running.status.as_str(), "claimed" | "running")
            || running.expires_at <= now
            || running.owner_auth_version != owner.auth_version
            || running.config_revision != current.config_revision
            || running.admission_epoch != admission.admission_epoch
        {
            return Err(denied());
        }
        let info = schedule_info(&current)?;
        let auth = source.for_keeper(
            run.clone(),
            space.clone(),
            info.definition
                .project
                .as_ref()
                .map(|p| p.folder_id.clone()),
            BTreeSet::from([info.definition.approved_role.id]),
        )?;
        let history: HistoryScope = parse(&running.history_scope)?;
        // The enclosing effect's operation budget also bounds this callback.
        let budget = CallBudget {
            request: RequestId::from_bytes(crate::auth::token::random()?),
            cancellation: Cancellation::default(),
            remaining: Duration::from_millis((running.expires_at - now) as u64)
                .min(Duration::from_secs(5)),
        };
        let ctx = AccountContext::new(auth.clone(), budget);
        let current = self.catalog_space(&ctx, &space).await?;
        current.history.check(&history)?;
        if let Some(project) = &info.definition.project {
            self.catalog_project(&ctx, project).await?;
        }
        Ok(auth)
    }
    async fn schedule_definition_authority(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        definition: &ScheduleDefinition,
    ) -> Result<HistoryScope, PortError> {
        let grant = ctx
            .auth()
            .spaces()
            .get(&definition.space)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.role == SpaceRole::Viewer
            || !grant.write_classes.contains(&DocClass::AgentMemory)
            || ctx.auth().taint().is_tainted()
        {
            return Err(access_denied());
        }
        let keeper = ctx.auth().for_keeper(
            AgentRunId::from_bytes([0; 16]),
            definition.space.clone(),
            definition.project.as_ref().map(|p| p.folder_id.clone()),
            BTreeSet::from([definition.approved_role.id.clone()]),
        )?;
        let limited = AccountContext::new(keeper, ctx.budget.clone());
        let space = self.catalog_space(&limited, &definition.space).await?;
        if let Some(project) = &definition.project {
            self.catalog_project(&limited, project).await?;
        }
        if !self
            .current_role_in_project(
                tx,
                &limited,
                &definition.approved_role,
                definition.project.as_ref(),
            )
            .await?
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        Ok(space.history)
    }
}

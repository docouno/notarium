//! Atomic schedule claims and short-lived, independently revalidated run grants.
mod approvals;
mod calendar;
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
use approvals::{ScheduleScope, package_ids};
use calendar::Calendar;
pub use calendar::compute_next_slot;
pub(crate) use calendar::validate_stored_calendar;
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
    floor_ms(value)
}
fn floor_ms(value: Timestamp) -> Result<i64, PortError> {
    value
        .unix_seconds()
        .checked_mul(1000)
        .and_then(|v| v.checked_add(i64::from(value.nanosecond() / 1_000_000)))
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))
}
use crate::store::values::schedule_timestamp as timestamp;
fn validate(
    def: &ScheduleDefinition,
    next_slot: Option<Timestamp>,
    ceiling: RunLimits,
    allow_legacy_fold: bool,
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
    let calendar = Calendar::parse(&def.cron, &def.timezone)?;
    if let Some(slot) = next_slot {
        calendar.validate_slot(ms(slot)?, allow_legacy_fold, true)?;
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
        approved_skills: parse(&row.approved_skills)?,
        paused_reason: row
            .paused_reason
            .as_ref()
            .map(|value| parse(&json(value)?))
            .transpose()?,
        revision: ControlRevision::new(row.revision as u64)?,
        config_revision: ControlRevision::new(row.config_revision as u64)?,
        next_slot: row.next_slot_utc_ms.map(timestamp).transpose()?,
    })
}
fn receipt(row: &AgentScheduleRunsRow) -> Result<ScheduleRunReceipt, PortError> {
    Ok(ScheduleRunReceipt {
        schedule: ScheduleId::parse(&row.schedule_id)?,
        run: AgentRunId::parse(&row.run_id)?,
        lease: LeaseEpoch::new(row.lease_epoch as u64)?,
        slot: timestamp(row.slot_utc_ms)?,
        reserved_next_slot: row.reserved_next_slot.map(timestamp).transpose()?,
        keeper_log: row
            .keeper_log_id
            .as_deref()
            .map(ChatThreadId::parse)
            .transpose()?,
        claimed_revision: ControlRevision::new(row.claimed_schedule_revision as u64)?,
        status: match row.status.as_str() {
            "claimed" => ScheduleRunStatus::Claimed,
            "running" => ScheduleRunStatus::Running,
            other => ScheduleRunStatus::Terminal(parse(&json(&other)?)?),
        },
    })
}
fn scoped_receipt(
    row: &AgentScheduleRunsRow,
    auth: &EngineAuthContext,
    space: &SpaceId,
) -> Result<ScheduleRunReceipt, PortError> {
    let mut value = receipt(row)?;
    if auth
        .spaces()
        .get(space)
        .and_then(|grant| grant.project_root.as_ref())
        .is_some_and(|project| row.keeper_project_folder_id.as_deref() != Some(project.as_str()))
    {
        value.keeper_log = None;
    }
    Ok(value)
}

fn schedule_log_id(
    schedule: &ScheduleId,
    owner: &str,
    space: &SpaceId,
    project: Option<&FolderId>,
) -> ChatThreadId {
    let mut hash = blake3::Hasher::new_derive_key("notarium-v1-keeper-log-scope");
    hash.update(schedule.as_str().as_bytes());
    hash.update(&[0]);
    hash.update(owner.as_bytes());
    hash.update(&[0]);
    hash.update(space.as_str().as_bytes());
    match project {
        Some(folder) => {
            hash.update(&[1]);
            hash.update(folder.as_str().as_bytes());
        }
        None => {
            hash.update(&[0]);
        }
    }
    let mut identifier = [0; 16];
    identifier.copy_from_slice(&hash.finalize().as_bytes()[..16]);
    ChatThreadId::from_bytes(identifier)
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
async fn schedule_read(
    tx: &mut Transaction,
    id: &ScheduleId,
) -> Result<AgentSchedulesRow, PortError> {
    rows!(tx,AgentSchedulesRow,fetch_optional,"SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1";id.as_str())?
        .ok_or(DomainError::ResourceNotFound.into())
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
pub(super) struct PrecheckedKeeper {
    pub(super) space: SpaceId,
    pub(super) history: HistoryScope,
    pub(super) project: Option<FolderId>,
    config_revision: i64,
    budget: CallBudget,
    descriptors: Vec<AbilityDescriptor>,
}
impl PrecheckedKeeper {
    pub(super) fn approved(&self) -> impl Iterator<Item = &AbilityRef> {
        self.descriptors.iter().map(|item| &item.reference)
    }
}
impl ControlService {
    pub(super) async fn precheck_keeper_catalog(
        &self,
        auth: &EngineAuthContext,
        budget: &OperationBudget,
        request: &RequestId,
    ) -> Result<Option<PrecheckedKeeper>, PortError> {
        let Some(AuthenticatedCredential::ScheduledRun {
            schedule,
            run,
            lease,
        }) = auth.credential()
        else {
            return Ok(None);
        };
        if auth.spaces().len() != 1 {
            return Err(denied());
        }
        let (space, grant) = auth.spaces().iter().next().ok_or_else(denied)?;
        let expected_log = schedule_log_id(
            schedule,
            auth.principal().as_str(),
            space,
            grant.project_root.as_ref(),
        );
        if auth.keeper_log() != Some(&expected_log) {
            return Err(denied());
        }
        let observed = self.observe_schedule(budget, schedule).await?;
        let info = schedule_info(&observed)?;
        let scope = ScheduleScope::from(&info.definition);
        if scope.space != space
            || scope.project.map(|p| &p.folder_id) != grant.project_root.as_ref()
        {
            return Err(denied());
        }
        budget
            .run(
                async {
                    let row = read_rows!(&self.store.backend,AgentScheduleRunsRow,fetch_optional,
                "SELECT * FROM agent_schedule_runs WHERE run_id=$1 AND schedule_id=$2",
                "SELECT * FROM v1_control.agent_schedule_runs WHERE run_id=$1 AND schedule_id=$2";
                run.as_str(),schedule.as_str())?
                    .ok_or_else(denied)?;
                    if row.config_revision != observed.config_revision
                        || row.lease_epoch as u64 != lease.get()
                        || row.keeper_log_id.as_deref() != Some(expected_log.as_str())
                        || row.expires_at <= self.clock.now_ms()?
                        || !matches!(row.status.as_str(), "claimed" | "running")
                    {
                        return Err(denied());
                    }
                    let skills: Vec<AbilityRef> = parse(&row.approved_skills)?;
                    if skills != info.approved_skills {
                        return Err(denied());
                    }
                    let ctx = AccountContext::new(auth.clone(), budget.context(request.clone()));
                    let history = self.schedule_history(&ctx, scope).await?;
                    let descriptors = self
                        .probe_schedule_approval(
                            &ctx,
                            scope,
                            &info.definition.approved_role,
                            &skills,
                        )
                        .await?;
                    Ok(Some(PrecheckedKeeper {
                        space: space.clone(),
                        history,
                        project: grant.project_root.clone(),
                        config_revision: observed.config_revision,
                        budget: ctx.budget,
                        descriptors,
                    }))
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    async fn observe_schedule(
        &self,
        budget: &OperationBudget,
        id: &ScheduleId,
    ) -> Result<AgentSchedulesRow, PortError> {
        budget.run(async { read_rows!(&self.store.backend,AgentSchedulesRow,fetch_optional,
            "SELECT * FROM agent_schedules WHERE schedule_id=$1","SELECT * FROM v1_control.agent_schedules WHERE schedule_id=$1";id.as_str())?.ok_or(DomainError::ResourceNotFound.into())
        },CommitEffect::NotCommitted).await
    }
    /// Caller locks the owner first on write paths. Space locks precede schedule/run locks on
    /// every dispatch and mutation path; membership mutation uses the same lock.
    async fn schedule_source(
        &self,
        tx: &mut Transaction,
        owner: &UsersRow,
        space: &SpaceId,
        credential: AuthenticatedCredential,
        source: GrantId,
        lock: bool,
    ) -> Result<Option<(EngineAuthContext, SpaceAdmissionRow)>, PortError> {
        let admission = if lock {
            rows!(tx,SpaceAdmissionRow,fetch_optional,"SELECT * FROM space_admission WHERE space_id=$1","SELECT * FROM v1_control.space_admission WHERE space_id=$1 FOR SHARE";space.as_str())?
        } else {
            rows!(tx,SpaceAdmissionRow,fetch_optional,"SELECT * FROM space_admission WHERE space_id=$1","SELECT * FROM v1_control.space_admission WHERE space_id=$1";space.as_str())?
        };
        let Some(admission) = admission else {
            return Ok(None);
        };
        let member = if lock {
            rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2 FOR SHARE";space.as_str(),&owner.user_id)?
        } else {
            rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),&owner.user_id)?
        };
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
        lock: bool,
        keeper: Option<&PrecheckedKeeper>,
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
                lock,
            )
            .await?
            .ok_or_else(denied)?;
        let current = if lock {
            schedule(tx, id, false).await?
        } else {
            schedule_read(tx, id).await?
        };
        let running = if lock {
            rows!(tx,AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE run_id=$1","SELECT * FROM v1_control.agent_schedule_runs WHERE run_id=$1 FOR SHARE";run.as_str())?
        } else {
            rows!(tx,AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE run_id=$1","SELECT * FROM v1_control.agent_schedule_runs WHERE run_id=$1";run.as_str())?
        }
        .ok_or_else(denied)?;
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
        let scope = ScheduleScope::from(&info.definition);
        let project_folder = scope.project.map(|project| project.folder_id.clone());
        let log = schedule_log_id(id, &current.owner_id, &space, project_folder.as_ref());
        if running.keeper_log_id.as_deref() != Some(log.as_str())
            || running.keeper_project_folder_id.as_deref()
                != project_folder.as_ref().map(FolderId::as_str)
        {
            return Err(denied());
        }
        let skills: Vec<AbilityRef> = parse(&running.approved_skills)?;
        if skills != info.approved_skills {
            return Err(denied());
        }
        let auth = scope
            .keeper(
                &source,
                run.clone(),
                package_ids(&info.definition.approved_role, &skills),
            )?
            .with_verified_keeper_log(log)?;
        let history: HistoryScope = parse(&running.history_scope)?;
        let prechecked = keeper.ok_or_else(denied)?;
        if prechecked.space != space
            || prechecked.project != project_folder
            || prechecked.config_revision != running.config_revision
        {
            return Err(denied());
        }
        prechecked.history.check(&history)?;
        let ctx = AccountContext::new(auth.clone(), prechecked.budget.clone());
        if !self
            .verify_schedule_approval_db(tx, &ctx, scope, &prechecked.descriptors)
            .await?
        {
            return Err(denied());
        }
        Ok(auth)
    }
}

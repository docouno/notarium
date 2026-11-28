//! Durable scheduling metadata. The ticker and agent loop belong to the caller.
use super::{
    context::*,
    control::{AbilityIdentity, AbilityRef},
};
use crate::{ids::*, model::FolderRef, value::Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunLimits {
    pub max_steps: u32,
    pub max_tokens: u64,
    pub timeout_ms: u64,
}
impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_steps: 25,
            max_tokens: 100_000,
            timeout_ms: 300_000,
        }
    }
}
impl RunLimits {
    pub const HARD_CEILING: Self = Self {
        max_steps: 1_000,
        max_tokens: 10_000_000,
        timeout_ms: 3_600_000,
    };
    pub fn fits(self, ceiling: Self) -> bool {
        self.max_steps > 0
            && self.max_steps <= ceiling.max_steps
            && self.max_tokens > 0
            && self.max_tokens <= ceiling.max_tokens
            && self.timeout_ms > 0
            && self.timeout_ms <= ceiling.timeout_ms
    }
}
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleDefinition {
    pub space: SpaceId,
    pub project: Option<FolderRef>,
    pub title: String,
    pub init_prompt: String,
    pub cron: String,
    pub timezone: String,
    pub approved_role: AbilityRef,
    pub limits: RunLimits,
}
impl std::fmt::Debug for ScheduleDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScheduleDefinition")
            .field("space", &self.space)
            .field("project", &self.project)
            .field("title", &"[redacted]")
            .field("init_prompt", &"[redacted]")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSchedule {
    pub id: ScheduleId,
    pub definition: ScheduleDefinition,
    /// The exact current dependencies reviewed by the owner.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approved_skills: Vec<AbilityRef>,
    pub next_slot: Timestamp,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSchedule {
    pub schedule: ScheduleId,
    pub expected: ControlRevision,
    pub definition: ScheduleDefinition,
    /// Omit during ordinary edits to retain the existing approval. An explicit
    /// empty set approves a role with no dependencies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_skills: Option<Vec<AbilityRef>>,
    /// An overdue slot may be retained for catch-up. A replacement due must
    /// match the calendar, be unissued and be at or after the control clock.
    pub next_slot: Option<Timestamp>,
    pub paused: bool,
}
#[derive(Clone, Debug)]
pub struct ScheduleAbilitySelection {
    pub space: SpaceId,
    pub project: Option<FolderRef>,
    pub role: AbilityIdentity,
}
#[derive(Clone, Debug)]
pub struct ScheduleAbilityCandidate {
    pub account_revision: ControlRevision,
    pub approved_role: AbilityRef,
    pub approved_skills: Vec<AbilityRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteSchedule {
    pub schedule: ScheduleId,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct AgentSchedule {
    pub id: ScheduleId,
    pub owner: PrincipalId,
    pub definition: ScheduleDefinition,
    pub approved_skills: Vec<AbilityRef>,
    pub paused_reason: Option<SchedulePauseReason>,
    pub revision: ControlRevision,
    pub config_revision: ControlRevision,
    pub next_slot: Option<Timestamp>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulePauseReason {
    OwnerRevoked,
    RoleChanged,
    SpaceUnavailable,
    BudgetExceeded,
    Manual,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimSchedule {
    pub schedule: ScheduleId,
    pub slot: Timestamp,
    pub current_role: AbilityRef,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub enum ScheduleClaim {
    Claimed {
        run: AgentRunId,
        lease: LeaseEpoch,
        schedule: Box<AgentSchedule>,
        /// Authority is returned only to the winning new claim. Replaying a
        /// receipt cannot recover it or authorize a second dispatch.
        context: Box<SpaceContext>,
    },
    AlreadyClaimed(ScheduleRunReceipt),
    /// A persisted due referred to an issued slot or its repeated civil time.
    /// The schedule advanced without issuing a second run.
    SkippedDuplicate(ScheduleRunReceipt),
    /// History for a legacy repeated civil time was incomplete. The cursor
    /// advanced without issuing a run or fabricating a historical receipt.
    SkippedUnverifiedFold,
    Paused(SchedulePauseReason),
}
#[derive(Clone, Debug)]
pub struct ScheduleResult {
    pub schedule: ScheduleId,
    pub run: AgentRunId,
    pub lease: LeaseEpoch,
    pub outcome: ScheduleOutcome,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleOutcome {
    Succeeded,
    Failed,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduleRunStatus {
    Claimed,
    Running,
    Terminal(ScheduleOutcome),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleRunReceipt {
    pub schedule: ScheduleId,
    pub run: AgentRunId,
    pub lease: LeaseEpoch,
    pub slot: Timestamp,
    pub reserved_next_slot: Option<Timestamp>,
    /// Absent for historical runs predating schedule-scoped logs.
    pub keeper_log: Option<ChatThreadId>,
    pub claimed_revision: ControlRevision,
    pub status: ScheduleRunStatus,
}
#[derive(Clone, Debug)]
pub enum ScheduleRunContext {
    Owner(Box<AccountContext>),
    Scheduler(MaintenanceContext),
}

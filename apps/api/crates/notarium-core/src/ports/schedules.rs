//! Durable scheduling metadata. The ticker and agent loop belong to the caller.
use super::{context::*, control::AbilityRef};
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
    pub next_slot: Timestamp,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSchedule {
    pub schedule: ScheduleId,
    pub expected: ControlRevision,
    pub definition: ScheduleDefinition,
    pub next_slot: Timestamp,
    pub paused: bool,
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
    pub paused_reason: Option<SchedulePauseReason>,
    pub revision: ControlRevision,
    pub config_revision: ControlRevision,
    pub next_slot: Timestamp,
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
    /// Computed by the scheduler, strictly after the claimed slot.
    pub next_slot: Timestamp,
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
    pub reserved_next_slot: Timestamp,
    pub claimed_revision: ControlRevision,
    pub status: ScheduleRunStatus,
}
#[derive(Clone, Debug)]
pub enum ScheduleRunContext {
    Owner(Box<AccountContext>),
    Scheduler(MaintenanceContext),
}

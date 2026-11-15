use super::{PortFuture, PortStream, context::*, types::*};
use crate::{auth::*, classes::*, ids::*, model::*, receipt::*, value::Timestamp};
use std::collections::{BTreeMap, BTreeSet};

/// Opaque continuation bound by the producer to scope, filters and revisions.
#[derive(Clone, Debug)]
pub struct ControlPageRequest {
    limit: u16,
    continuation: Option<String>,
}
impl ControlPageRequest {
    pub fn new(limit: u16, continuation: Option<String>) -> crate::DomainResult<Self> {
        if !(1..=200).contains(&limit)
            || continuation
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 4096)
        {
            return Err(crate::DomainError::validation(
                crate::error::ValidationReason::InvalidLimit,
            ));
        }
        Ok(Self {
            limit,
            continuation,
        })
    }
    pub fn limit(&self) -> u16 {
        self.limit
    }
    pub fn continuation(&self) -> Option<&str> {
        self.continuation.as_deref()
    }
}
#[derive(Clone, Debug)]
pub struct ControlPage<T> {
    pub items: Vec<T>,
    pub continuation: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PrincipalInfo {
    pub principal: PrincipalId,
    pub kind: PrincipalKind,
    pub grant: GrantId,
}
#[derive(Clone, Debug)]
pub struct AccessibleSpace {
    pub space: Space,
    pub role: SpaceRole,
    pub history: HistoryScope,
}
#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub folder: FolderRef,
    pub name: String,
}
#[derive(Clone, Debug)]
pub struct AccountMutation<T> {
    pub identity: AccountCommandIdentity,
    pub input: T,
}
#[derive(Clone, Debug)]
pub struct ControlCommit<T> {
    pub value: T,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct CreateSpace {
    pub id: SpaceId,
    pub kind: SpaceKind,
    pub name: String,
}
#[derive(Clone, Debug)]
pub struct MembershipChange {
    pub command: CommandKey,
    pub member: PrincipalId,
    pub role: Option<SpaceRole>,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct MembershipResult {
    pub space: SpaceId,
    pub member: PrincipalId,
    pub role: Option<SpaceRole>,
}
#[derive(Clone, Debug)]
pub struct SpaceLifecycleChange {
    pub command: CommandKey,
    pub lifecycle: SpaceLifecycle,
    pub expected: ControlRevision,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AbilityPlacement {
    OwnedProject(FolderRef),
    OwnedSpace(SpaceId),
    OwnedPersonal(PrincipalId),
    System,
}
impl AbilityPlacement {
    pub fn precedence(&self) -> u8 {
        match self {
            Self::OwnedProject(_) => 0,
            Self::OwnedSpace(_) => 1,
            Self::OwnedPersonal(_) => 2,
            Self::System => 3,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AbilityRef {
    pub id: AbilityId,
    pub placement: AbilityPlacement,
    pub revision: RevisionId,
}
#[derive(Clone, Debug)]
pub struct AbilityDescriptor {
    pub reference: AbilityRef,
    pub kind: AbilityKind,
    pub name: String,
    pub enabled: bool,
    pub healthy: bool,
    pub entrypoint: NoteRef,
    pub auxiliary_files: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct AbilityQuery {
    pub page: ControlPageRequest,
    pub project: Option<FolderRef>,
    pub kind: Option<AbilityKind>,
    pub name: Option<String>,
    pub authoring: bool,
}
#[derive(Clone, Debug)]
pub enum AbilityResolution {
    Resolved(Box<AbilityDescriptor>),
    Missing,
    Disabled,
    Unhealthy,
    WrongKind,
    OutOfScope,
}
#[derive(Clone, Debug)]
pub enum AbilitySelection {
    Exact(AbilityRef),
    Name {
        kind: AbilityKind,
        name: String,
        project: Option<FolderRef>,
    },
}
#[derive(Clone, Debug)]
pub struct AbilityBindingUpdate {
    pub ability: AbilityRef,
    pub enabled: bool,
    pub expected: ControlRevision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EpisodeLifecycle {
    Active,
    Sleeping,
    Closed,
}
#[derive(Clone, Debug)]
pub struct AgentEpisode {
    pub id: EpisodeId,
    pub owner: PrincipalId,
    pub name: Option<String>,
    pub active_role: Option<AbilityRef>,
    pub project_hint: Option<FolderRef>,
    pub lifecycle: EpisodeLifecycle,
    pub parent: Option<EpisodeId>,
    pub revision: ControlRevision,
    pub acknowledgements: BTreeMap<SpaceId, AcknowledgedCursor>,
}
#[derive(Clone, Debug)]
pub enum EpisodeSelector {
    New {
        requested: EpisodeId,
        name: Option<String>,
    },
    Id(EpisodeId),
    Name(String),
}
#[derive(Clone, Debug)]
pub struct StartEpisode {
    pub selector: EpisodeSelector,
    pub project_hint: Option<FolderRef>,
}
#[derive(Clone, Debug)]
pub enum EpisodeStartResult {
    New(AgentEpisode),
    Resumed(AgentEpisode),
    Forked(AgentEpisode),
    Ambiguous(Vec<AgentEpisode>),
}
#[derive(Clone, Debug)]
pub struct EpisodeUpdate {
    pub episode: EpisodeId,
    pub expected: ControlRevision,
    pub active_role: Option<AbilityRef>,
    pub project_hint: Option<FolderRef>,
    pub lifecycle: EpisodeLifecycle,
}
#[derive(Clone, Debug)]
pub enum AckOwner {
    Account,
    Episode(EpisodeId),
}
#[derive(Clone, Debug)]
pub struct AcknowledgeDelta {
    pub owner: AckOwner,
    pub delivered: ChangeCursor,
}
#[derive(Clone, Debug)]
pub struct ContextSelection {
    pub pinned: Vec<NoteRef>,
    pub favorites: Vec<NoteRef>,
    pub readable_spaces: Vec<SpaceId>,
}
#[derive(Clone, Debug)]
pub struct BootstrapContext {
    pub episode: AgentEpisode,
    pub selection: ContextSelection,
    pub owner_acknowledgements: BTreeMap<SpaceId, AcknowledgedCursor>,
    pub continuation: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AgentSchedule {
    pub id: ScheduleId,
    pub owner: PrincipalId,
    pub space: SpaceId,
    pub project_folder: Option<FolderId>,
    pub cron: String,
    pub timezone: String,
    pub approved_role: AbilityRef,
    pub write_classes: BTreeSet<DocClass>,
    pub budgets: CompletionBudget,
    pub coalesce_latest: bool,
    pub paused_reason: Option<SchedulePauseReason>,
    pub revision: ControlRevision,
    pub next_slot: Timestamp,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchedulePauseReason {
    OwnerRevoked,
    RoleChanged,
    SpaceUnavailable,
    BudgetExceeded,
    Manual,
}
#[derive(Clone, Debug)]
pub struct ClaimSchedule {
    pub schedule: ScheduleId,
    pub slot: Timestamp,
    pub current_role: AbilityRef,
    pub expected: ControlRevision,
    /// Computed by the scheduler; must be strictly after the claimed slot.
    pub next_slot: Timestamp,
}
#[derive(Clone, Debug)]
pub enum ScheduleClaim {
    Claimed {
        run: AgentRunId,
        lease: LeaseEpoch,
        schedule: Box<AgentSchedule>,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
#[derive(Clone, Debug)]
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
pub struct ProviderSelection {
    pub provider: ProviderResourceId,
    pub model: ModelProfileId,
    pub policy: ProviderPolicy,
}
#[derive(Clone, Debug)]
pub struct ProviderPreference {
    pub provider: ProviderResourceId,
    pub model: ModelProfileId,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct CompletionBudget {
    pub max_input_tokens: u32,
    pub max_output_tokens: u32,
    pub max_tool_calls: u16,
}
#[derive(Clone, Debug)]
pub struct CompletionRequest {
    pub intent: CommandKey,
    pub selection: ProviderSelection,
    pub messages: Vec<ProviderMessage>,
    pub budget: CompletionBudget,
}
#[derive(Clone, Debug)]
pub enum CompletionEvent {
    Text(String),
    ToolCall {
        call: CommandKey,
        name: String,
        arguments: BTreeMap<String, crate::value::YamlValue>,
    },
    Usage {
        input_tokens: u32,
        output_tokens: u32,
    },
    Finished,
}

pub trait ControlPort: Send + Sync {
    fn resolve_auth(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext>;
    fn whoami(&self, ctx: AccountContext) -> PortFuture<'_, PrincipalInfo>;
    fn list_spaces(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AccessibleSpace>>;
    fn list_projects(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>>;
    fn create_space(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSpace>,
    ) -> PortFuture<'_, ControlCommit<AccessibleSpace>>;
    fn change_membership(
        &self,
        ctx: SpaceContext,
        request: MembershipChange,
    ) -> PortFuture<'_, ControlCommit<MembershipResult>>;
    /// Resume only an existing exact command, including after self-removal.
    /// Fresh account authentication never grants new Space authority here.
    fn resume_membership_change(
        &self,
        ctx: AccountContext,
        scope: HistoryScope,
        request: MembershipChange,
    ) -> PortFuture<'_, ControlCommit<MembershipResult>>;
    fn change_space_lifecycle(
        &self,
        ctx: SpaceContext,
        request: SpaceLifecycleChange,
    ) -> PortFuture<'_, ControlCommit<AccessibleSpace>>;
    fn start_or_resume_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<StartEpisode>,
    ) -> PortFuture<'_, EpisodeStartResult>;
    fn get_episode(&self, ctx: AccountContext, episode: EpisodeId) -> PortFuture<'_, AgentEpisode>;
    fn update_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeUpdate>,
    ) -> PortFuture<'_, ControlCommit<AgentEpisode>>;
    fn acknowledge_delta(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AcknowledgeDelta>,
    ) -> PortFuture<'_, ControlCommit<AcknowledgedCursor>>;
    fn bootstrap_context(
        &self,
        ctx: AccountContext,
        episode: EpisodeId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, BootstrapContext>;
    fn discover_abilities(
        &self,
        ctx: AccountContext,
        request: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityDescriptor>>;
    fn resolve_ability(
        &self,
        ctx: AccountContext,
        request: AbilitySelection,
    ) -> PortFuture<'_, AbilityResolution>;
    fn get_ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
    ) -> PortFuture<'_, AbilityDescriptor>;
    fn update_ability_binding(
        &self,
        ctx: SpaceContext,
        request: AbilityBindingUpdate,
    ) -> PortFuture<'_, ControlCommit<AbilityDescriptor>>;
    fn resolve_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, ResolvedMemoryTarget>;
    fn create_schedule(
        &self,
        ctx: SpaceContext,
        schedule: AgentSchedule,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>>;
    fn get_schedule(
        &self,
        ctx: SpaceContext,
        schedule: ScheduleId,
    ) -> PortFuture<'_, AgentSchedule>;
    fn list_schedules(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentSchedule>>;
    fn update_schedule(
        &self,
        ctx: SpaceContext,
        schedule: AgentSchedule,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>>;
    fn delete_schedule(
        &self,
        ctx: SpaceContext,
        schedule: ScheduleId,
        expected: ControlRevision,
    ) -> PortFuture<'_, ControlRevision>;
    fn list_due_schedules(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentSchedule>>;
    fn get_schedule_run(
        &self,
        ctx: AccountContext,
        schedule: ScheduleId,
        run: AgentRunId,
    ) -> PortFuture<'_, ScheduleRunReceipt>;
    fn list_schedule_runs(
        &self,
        ctx: AccountContext,
        schedule: ScheduleId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ScheduleRunReceipt>>;
    fn claim_schedule(
        &self,
        ctx: SpaceContext,
        request: ClaimSchedule,
    ) -> PortFuture<'_, ScheduleClaim>;
    fn record_schedule_result(
        &self,
        ctx: SpaceContext,
        result: ScheduleResult,
    ) -> PortFuture<'_, ControlRevision>;
    fn select_provider(
        &self,
        ctx: SpaceContext,
        model: Option<ModelProfileId>,
    ) -> PortFuture<'_, ProviderSelection>;
    fn update_provider_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<ProviderPreference>,
    ) -> PortFuture<'_, ControlCommit<ProviderPreference>>;
    fn complete(
        &self,
        ctx: SpaceContext,
        request: CompletionRequest,
    ) -> PortFuture<'_, Box<dyn PortStream<CompletionEvent>>>;
}

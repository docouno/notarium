use super::{PortFuture, PortStream, context::*, provider::*, types::*};
use crate::{auth::*, classes::*, ids::*, model::*, receipt::*, value::Timestamp};
use std::collections::BTreeMap;

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
    pub account_revision: ControlRevision,
    pub personal_space: Option<SpaceId>,
    pub has_completion_provider: bool,
}
#[derive(Clone, Debug)]
pub struct AccessibleSpace {
    pub space: Space,
    pub slug: String,
    pub role: SpaceRole,
    pub history: HistoryScope,
    /// Upper cursor bound from a complete canonical command.
    pub last_seq: SpaceSeq,
}
#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub folder: FolderRef,
    pub name: String,
    pub project_slug: String,
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

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
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

    pub fn in_project(&self, project: &FolderRef) -> bool {
        match self {
            Self::OwnedProject(folder) => folder == project,
            Self::OwnedSpace(space) => space == &project.space_id,
            Self::OwnedPersonal(_) | Self::System => false,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AbilityIdentity {
    pub id: AbilityId,
    pub placement: AbilityPlacement,
}
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AbilityRef {
    pub id: AbilityId,
    pub placement: AbilityPlacement,
    pub revision: RevisionId,
}
impl AbilityRef {
    pub fn identity(&self) -> AbilityIdentity {
        AbilityIdentity {
            id: self.id.clone(),
            placement: self.placement.clone(),
        }
    }
}
/// Maximum number of auxiliary resource names in a published ability descriptor.
pub const MAX_ABILITY_AUX_FILES: usize = 256;
pub const MAX_ABILITY_AUX_PATH_BYTES: usize = 1024;
pub const MAX_ATTACHED_SKILLS: usize = 32;

#[derive(Clone, Debug)]
pub struct AbilityDescriptor {
    pub reference: AbilityRef,
    pub kind: AbilityKind,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub healthy: bool,
    pub lifecycle: Lifecycle,
    /// The canonical entrypoint of an owned package. Built-ins have no note.
    pub entrypoint: Option<NoteRef>,
    pub auxiliary_files: Vec<String>,
    pub attached_skills: Vec<AbilityRef>,
    /// Scope of the old publication when an ability was promoted to its Space.
    pub promoted_from: Option<AbilityRef>,
    /// Activation requires a Control binding even before the first binding commit.
    pub requires_explicit_binding: bool,
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
    Stale,
}
#[derive(Clone, Debug)]
pub enum AbilitySelection {
    Exact {
        reference: AbilityRef,
        project: Option<FolderRef>,
    },
    Name {
        kind: AbilityKind,
        name: String,
        project: Option<FolderRef>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum AbilityProjects {
    All,
    Selected(Vec<FolderRef>),
}
#[derive(Clone, Debug)]
pub struct AbilityInspection {
    pub descriptor: AbilityDescriptor,
    pub availability: AbilityProjects,
    pub binding_enabled: bool,
    pub preference_enabled: bool,
    pub binding_revision: ControlRevision,
    pub overlays: AbilityOverlayState,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum AbilityOverlayGuard {
    /// Enforce the account revision alongside the target binding revision.
    Account(ControlRevision),
    /// Authored per-overlay CAS (`None` requires absence of a binding row).
    Authored(Option<ControlRevision>),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityBindingUpdate {
    pub ability: AbilityRef,
    pub enabled: bool,
    pub expected: AbilityOverlayGuard,
    pub projects: AbilityProjects,
}
#[derive(Clone, Debug)]
pub struct AbilityBindingResult {
    pub reference: AbilityRef,
    pub descriptor: Option<AbilityDescriptor>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityPreferenceUpdate {
    pub ability: AbilityRef,
    pub enabled: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum AbilityPreferenceGuard {
    /// Enforce the owner's account revision; allows human management without `Cap::AbilityWrite`.
    Account,
    /// Authored per-overlay CAS (`None` requires absence of a preference row); requires `Cap::AbilityWrite`.
    Authored(Option<ControlRevision>),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityPreferenceChange {
    pub preference: AbilityPreferenceUpdate,
    pub expected: AbilityPreferenceGuard,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityTrailUpdate {
    pub source: AbilityRef,
    pub expected_destination: Option<AbilityRef>,
    pub destination: Option<AbilityRef>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AdoptAbilityPromotion {
    pub source: AbilityRef,
    pub destination: AbilityRef,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum AbilityTrailMutation {
    Set(AbilityTrailUpdate),
    AdoptPromotion(AdoptAbilityPromotion),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityOverlayState {
    pub binding_revision: Option<ControlRevision>,
    pub binding_enabled: bool,
    pub preference_revision: Option<ControlRevision>,
    pub preference_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<AbilityProjects>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AbilityPromotionResult {
    pub source: AbilityOverlayState,
    pub destination: AbilityOverlayState,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum AbilityTrailResult {
    Updated(Box<AbilityTrailUpdate>),
    Promoted(AbilityPromotionResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
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
    pub diagnostics: Vec<EpisodeDiagnostic>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EpisodeDiagnostic {
    ProjectUnavailable,
    RoleUnavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NamedEpisodePreview {
    NoMatch,
    Unique(Option<FolderRef>),
    ProjectUnavailable,
    Ambiguous,
}
#[derive(Clone, Debug)]
pub struct EpisodeChoice {
    pub id: EpisodeId,
    pub name: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum EpisodeSelector {
    New {
        requested: EpisodeId,
        name: Option<String>,
    },
    Id(EpisodeId),
    /// Resume an existing episode in place if sleeping or idle, or touch it if
    /// already active, without ever forking a new episode.
    Resume(EpisodeId),
    Name(String),
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum EpisodeRevisionGuard {
    #[default]
    Account,
    Target,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct StartEpisode {
    pub selector: EpisodeSelector,
    /// Initial hint for a new episode. Resume/fork retains the stored selection;
    /// changing an existing selection requires EpisodeUpdate and its CAS.
    pub project_hint: Option<FolderRef>,
    #[serde(default)]
    pub guard: EpisodeRevisionGuard,
}
#[derive(Clone, Debug)]
pub enum EpisodeStartResult {
    New(AgentEpisode),
    Resumed(AgentEpisode),
    Forked(AgentEpisode),
    Ambiguous(Vec<EpisodeChoice>),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct EpisodeUpdate {
    pub episode: EpisodeId,
    pub expected: ControlRevision,
    pub name: Option<String>,
    pub active_role: Option<AbilityRef>,
    pub project_hint: Option<FolderRef>,
    pub lifecycle: EpisodeLifecycle,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BindEpisodeRole {
    pub episode: EpisodeId,
    pub expected: ControlRevision,
    pub active_role: AbilityRef,
    pub project_hint: Option<FolderRef>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum EpisodeMutation {
    Full(EpisodeUpdate),
    BindRole(BindEpisodeRole),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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
    pub space: Option<SpaceId>,
    pub pinned: Vec<NoteRef>,
    pub favorites: Vec<NoteRef>,
    pub readable_spaces: Vec<SpaceId>,
    pub unavailable: u32,
}
#[derive(Clone, Debug)]
pub struct BootstrapContext {
    pub episode: AgentEpisode,
    pub selection: ContextSelection,
    pub owner_acknowledgements: BTreeMap<SpaceId, AcknowledgedCursor>,
    pub continuation: Option<String>,
}

#[derive(Clone, Debug)]
pub struct McpDedupKey {
    pub actor: String,
    pub request_key: CommandKey,
    pub request_hash: ContentDigest,
    pub operation: String,
}
#[derive(Clone, Debug)]
pub struct McpDedupRecord {
    pub key: McpDedupKey,
    pub safe_result: String,
    pub effect: super::telemetry::AgentEffect,
    pub ttl_ms: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpDedupHit {
    pub operation: String,
    pub safe_result: String,
    pub effect: super::telemetry::AgentEffect,
}

pub use super::schedules::*;

#[derive(Clone, Debug)]
pub struct ProviderSelection {
    pub provider: ProviderResourceId,
    pub model: ModelProfileId,
    pub runtime_epochs: ProviderRuntimeEpochs,
    pub project: Option<FolderRef>,
    pub project_only: Option<FolderRef>,
    pub policy: ProviderPolicy,
    pub completion: Option<CompletionModelLimits>,
    pub revocation_scope: ProviderRevocationScope,
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
    /// Project context for sources outside the primary history.
    pub secondary_projects: Vec<FolderRef>,
    pub messages: Vec<CompletionMessage>,
    pub tools: Vec<ProviderToolDefinition>,
    pub budget: CompletionBudget,
}
#[derive(Clone)]
pub enum CompletionEvent {
    Text(String),
    ToolCall(ProviderToolCall),
    Usage(ProviderUsage),
    Finished(CompletionFinish),
}
impl std::fmt::Debug for CompletionEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text(_) => f.write_str("Text([redacted])"),
            Self::ToolCall(call) => f.debug_tuple("ToolCall").field(call).finish(),
            Self::Usage(usage) => f.debug_tuple("Usage").field(usage).finish(),
            Self::Finished(reason) => f.debug_tuple("Finished").field(reason).finish(),
        }
    }
}

pub trait ControlPort: Send + Sync {
    fn resolve_auth(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext>;
    /// Refreshes a previously verified credential and intersects its current
    /// authority with the original delegation, project pin and branch taint.
    fn revalidate_auth(&self, ctx: AccountContext) -> PortFuture<'_, EngineAuthContext>;
    /// Revalidate stream authority and pin the natural expiry of this credential.
    fn revalidate_chat_viewer(
        &self,
        ctx: AccountContext,
    ) -> PortFuture<'_, (EngineAuthContext, Option<std::time::Instant>)>;
    /// Register and revalidate short-lived authority for one canonical write or
    /// its replay. The original grants also cover a proposal's source Space.
    fn fence_canonical_effect(
        &self,
        authority: EngineAuthContext,
        ctx: SpaceContext,
        effect: CanonicalEffect,
    ) -> PortFuture<'_, SpaceContext>;
    /// Rebuilds independent authority from the same live interactive credential.
    /// The read variant grants proposal admission without management or write authority.
    fn revalidate_proposal_human(
        &self,
        ctx: AccountContext,
        access: ProposalHumanAccess,
    ) -> PortFuture<'_, EngineAuthContext>;
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
    ) -> PortFuture<'_, ControlCommit<EpisodeStartResult>>;
    fn get_episode(&self, ctx: AccountContext, episode: EpisodeId) -> PortFuture<'_, AgentEpisode>;
    fn named_episode_project_hint(
        &self,
        ctx: AccountContext,
        name: String,
    ) -> PortFuture<'_, NamedEpisodePreview>;
    fn update_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeMutation>,
    ) -> PortFuture<'_, ControlCommit<AgentEpisode>>;
    fn touch_episode(&self, ctx: AccountContext, episode: EpisodeId) -> PortFuture<'_, ()>;
    fn acknowledge_delta(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AcknowledgeDelta>,
    ) -> PortFuture<'_, ControlCommit<AcknowledgedCursor>>;
    fn bootstrap_context(
        &self,
        ctx: AccountContext,
        episode: EpisodeId,
        // Optional current Space selection. An existing project must belong to
        // it; otherwise the caller must explicitly update the episode first.
        space: Option<SpaceId>,
        page: ControlPageRequest,
    ) -> PortFuture<'_, BootstrapContext>;
    fn discover_abilities(
        &self,
        ctx: AccountContext,
        request: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityInspection>>;
    fn resolve_ability(
        &self,
        ctx: AccountContext,
        request: AbilitySelection,
    ) -> PortFuture<'_, AbilityResolution>;
    fn get_ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
        project: Option<FolderRef>,
    ) -> PortFuture<'_, AbilityDescriptor>;
    fn inspect_ability(
        &self,
        ctx: AccountContext,
        identity: AbilityIdentity,
    ) -> PortFuture<'_, AbilityInspection>;
    fn follow_ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
    ) -> PortFuture<'_, AbilityRef>;
    fn update_ability_binding(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityBindingUpdate>,
    ) -> PortFuture<'_, ControlCommit<AbilityBindingResult>>;
    fn set_ability_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityPreferenceChange>,
    ) -> PortFuture<'_, ControlCommit<AbilityPreferenceUpdate>>;
    fn set_ability_trail(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityTrailMutation>,
    ) -> PortFuture<'_, ControlCommit<AbilityTrailResult>>;
    fn lookup_mcp_dedup(
        &self,
        ctx: AccountContext,
        key: McpDedupKey,
    ) -> PortFuture<'_, Option<McpDedupHit>>;
    fn record_mcp_dedup(
        &self,
        ctx: AccountContext,
        record: McpDedupRecord,
    ) -> PortFuture<'_, McpDedupHit>;
    fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot>;
    fn create_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSchedule>,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>>;
    fn schedule_ability_candidate(
        &self,
        ctx: AccountContext,
        selection: ScheduleAbilitySelection,
    ) -> PortFuture<'_, ScheduleAbilityCandidate>;
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
        ctx: AccountContext,
        request: AccountMutation<UpdateSchedule>,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>>;
    fn delete_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteSchedule>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_due_schedules(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentSchedule>>;
    fn list_expired_schedule_runs(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ScheduleRunReceipt>>;
    fn get_schedule_run(
        &self,
        ctx: ScheduleRunContext,
        schedule: ScheduleId,
        run: AgentRunId,
    ) -> PortFuture<'_, ScheduleRunReceipt>;
    fn list_schedule_runs(
        &self,
        ctx: ScheduleRunContext,
        schedule: ScheduleId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ScheduleRunReceipt>>;
    fn claim_schedule(
        &self,
        ctx: MaintenanceContext,
        request: ClaimSchedule,
    ) -> PortFuture<'_, ScheduleClaim>;
    fn record_schedule_result(
        &self,
        ctx: MaintenanceContext,
        result: ScheduleResult,
    ) -> PortFuture<'_, ScheduleRunReceipt>;
    fn ensure_run_inactive(
        &self,
        ctx: AccountContext,
        space: SpaceId,
        run: AgentRunId,
    ) -> PortFuture<'_, ()>;
    fn select_provider(
        &self,
        ctx: SpaceContext,
        request: SelectProvider,
    ) -> PortFuture<'_, ProviderSelection>;
    fn update_provider_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> PortFuture<'_, ControlCommit<SetProviderPreference>>;
    fn complete(
        &self,
        ctx: SpaceContext,
        request: CompletionRequest,
    ) -> PortFuture<'_, Box<dyn PortStream<CompletionEvent>>>;
}

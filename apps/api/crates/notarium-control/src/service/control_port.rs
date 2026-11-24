//! One concrete adapter binds all control operations to one authority owner.
use super::{ControlService, provider::ProviderService};
use notarium_core::{
    auth::{EngineAuthContext, ProposalHumanAccess},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::*,
    value::Timestamp,
};
use std::sync::Arc;

pub struct ControlPlane {
    control: Arc<ControlService>,
    provider: ProviderService,
}
impl ControlPlane {
    /// Derive the authority owner from the provider to make mismatched storage
    /// or revocation registries impossible in this composition.
    pub fn new(provider: ProviderService) -> Self {
        Self {
            control: provider.control_service(),
            provider,
        }
    }
    pub fn control_service(&self) -> &Arc<ControlService> {
        &self.control
    }
    pub fn provider_service(&self) -> &ProviderService {
        &self.provider
    }
}
impl ControlPort for ControlPlane {
    fn resolve_auth(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext> {
        Box::pin(self.control.resolve(ctx))
    }
    fn revalidate_auth(&self, ctx: AccountContext) -> PortFuture<'_, EngineAuthContext> {
        Box::pin(async move {
            let budget = crate::store::lease::OperationBudget::new(ctx.budget.clone());
            Ok(self
                .control
                .current_account(&ctx, &budget)
                .await?
                .auth()
                .clone())
        })
    }
    fn revalidate_chat_viewer(
        &self,
        ctx: AccountContext,
    ) -> PortFuture<'_, (EngineAuthContext, Option<std::time::Instant>)> {
        Box::pin(self.control.revalidate_chat_viewer(ctx))
    }
    fn fence_canonical_effect(
        &self,
        authority: EngineAuthContext,
        ctx: SpaceContext,
        effect: CanonicalEffect,
    ) -> PortFuture<'_, SpaceContext> {
        Box::pin(self.control.fence_canonical_effect(authority, ctx, effect))
    }
    fn revalidate_proposal_human(
        &self,
        ctx: AccountContext,
        access: ProposalHumanAccess,
    ) -> PortFuture<'_, EngineAuthContext> {
        Box::pin(self.control.revalidate_proposal_human(ctx, access))
    }
    fn whoami(&self, ctx: AccountContext) -> PortFuture<'_, PrincipalInfo> {
        Box::pin(self.control.whoami(ctx))
    }
    fn list_spaces(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AccessibleSpace>> {
        Box::pin(self.control.list_spaces(ctx, page))
    }
    fn list_projects(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>> {
        Box::pin(self.control.list_projects(ctx, page))
    }
    fn create_space(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSpace>,
    ) -> PortFuture<'_, ControlCommit<AccessibleSpace>> {
        Box::pin(self.control.create_space(ctx, request))
    }
    fn change_membership(
        &self,
        ctx: SpaceContext,
        request: MembershipChange,
    ) -> PortFuture<'_, ControlCommit<MembershipResult>> {
        Box::pin(self.control.change_membership(ctx, request))
    }
    fn resume_membership_change(
        &self,
        ctx: AccountContext,
        scope: HistoryScope,
        request: MembershipChange,
    ) -> PortFuture<'_, ControlCommit<MembershipResult>> {
        Box::pin(self.control.resume_membership_change(ctx, scope, request))
    }
    fn change_space_lifecycle(
        &self,
        ctx: SpaceContext,
        request: SpaceLifecycleChange,
    ) -> PortFuture<'_, ControlCommit<AccessibleSpace>> {
        Box::pin(self.control.change_space_lifecycle(ctx, request))
    }
    fn start_or_resume_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<StartEpisode>,
    ) -> PortFuture<'_, ControlCommit<EpisodeStartResult>> {
        Box::pin(self.control.start_or_resume_episode(ctx, request))
    }
    fn get_episode(&self, ctx: AccountContext, episode: EpisodeId) -> PortFuture<'_, AgentEpisode> {
        Box::pin(self.control.get_episode(ctx, episode))
    }
    fn named_episode_project_hint(
        &self,
        ctx: AccountContext,
        name: String,
    ) -> PortFuture<'_, NamedEpisodePreview> {
        Box::pin(self.control.named_episode_project_hint(ctx, name))
    }
    fn update_episode(
        &self,
        ctx: AccountContext,
        request: AccountMutation<EpisodeMutation>,
    ) -> PortFuture<'_, ControlCommit<AgentEpisode>> {
        Box::pin(self.control.update_episode(ctx, request))
    }
    fn touch_episode(&self, ctx: AccountContext, episode: EpisodeId) -> PortFuture<'_, ()> {
        Box::pin(self.control.touch_episode(ctx, episode))
    }
    fn acknowledge_delta(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AcknowledgeDelta>,
    ) -> PortFuture<'_, ControlCommit<AcknowledgedCursor>> {
        Box::pin(self.control.acknowledge_delta(ctx, request))
    }
    fn bootstrap_context(
        &self,
        ctx: AccountContext,
        episode: EpisodeId,
        // Optional current Space selection. An existing project must belong to
        // it; otherwise the caller must explicitly update the episode first.
        space: Option<SpaceId>,
        page: ControlPageRequest,
    ) -> PortFuture<'_, BootstrapContext> {
        Box::pin(self.control.bootstrap_context(ctx, episode, space, page))
    }
    fn discover_abilities(
        &self,
        ctx: AccountContext,
        request: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityInspection>> {
        Box::pin(self.control.discover_abilities(ctx, request))
    }
    fn resolve_ability(
        &self,
        ctx: AccountContext,
        request: AbilitySelection,
    ) -> PortFuture<'_, AbilityResolution> {
        Box::pin(self.control.resolve_ability(ctx, request))
    }
    fn get_ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
        project: Option<FolderRef>,
    ) -> PortFuture<'_, AbilityDescriptor> {
        Box::pin(self.control.get_ability(ctx, reference, project))
    }
    fn inspect_ability(
        &self,
        ctx: AccountContext,
        identity: AbilityIdentity,
    ) -> PortFuture<'_, AbilityInspection> {
        Box::pin(self.control.inspect_ability(ctx, identity))
    }
    fn update_ability_binding(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityBindingUpdate>,
    ) -> PortFuture<'_, ControlCommit<AbilityBindingResult>> {
        Box::pin(self.control.update_ability_binding(ctx, request))
    }
    fn set_ability_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityPreferenceChange>,
    ) -> PortFuture<'_, ControlCommit<AbilityPreferenceUpdate>> {
        Box::pin(self.control.set_ability_preference(ctx, request))
    }
    fn set_ability_trail(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AbilityTrailMutation>,
    ) -> PortFuture<'_, ControlCommit<AbilityTrailResult>> {
        Box::pin(self.control.set_ability_trail(ctx, request))
    }
    fn lookup_mcp_dedup(
        &self,
        ctx: AccountContext,
        key: McpDedupKey,
    ) -> PortFuture<'_, Option<McpDedupHit>> {
        Box::pin(self.control.lookup_mcp_dedup(ctx, key))
    }
    fn record_mcp_dedup(
        &self,
        ctx: AccountContext,
        record: McpDedupRecord,
    ) -> PortFuture<'_, McpDedupHit> {
        Box::pin(self.control.record_mcp_dedup(ctx, record))
    }
    fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot> {
        Box::pin(self.control.inspect_memory_target(ctx, target, category))
    }
    fn create_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSchedule>,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>> {
        Box::pin(self.control.create_schedule(ctx, request))
    }
    fn schedule_ability_candidate(
        &self,
        ctx: AccountContext,
        selection: ScheduleAbilitySelection,
    ) -> PortFuture<'_, ScheduleAbilityCandidate> {
        Box::pin(self.control.schedule_ability_candidate(ctx, selection))
    }
    fn get_schedule(
        &self,
        ctx: SpaceContext,
        schedule: ScheduleId,
    ) -> PortFuture<'_, AgentSchedule> {
        Box::pin(self.control.get_schedule(ctx, schedule))
    }
    fn list_schedules(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentSchedule>> {
        Box::pin(self.control.list_schedules(ctx, page))
    }
    fn update_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateSchedule>,
    ) -> PortFuture<'_, ControlCommit<AgentSchedule>> {
        Box::pin(self.control.update_schedule(ctx, request))
    }
    fn delete_schedule(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteSchedule>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(self.control.delete_schedule(ctx, request))
    }
    fn list_due_schedules(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentSchedule>> {
        Box::pin(self.control.list_due_schedules(ctx, now, page))
    }
    fn list_expired_schedule_runs(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ScheduleRunReceipt>> {
        Box::pin(self.control.list_expired_schedule_runs(ctx, now, page))
    }
    fn get_schedule_run(
        &self,
        ctx: ScheduleRunContext,
        schedule: ScheduleId,
        run: AgentRunId,
    ) -> PortFuture<'_, ScheduleRunReceipt> {
        Box::pin(self.control.get_schedule_run(ctx, schedule, run))
    }
    fn list_schedule_runs(
        &self,
        ctx: ScheduleRunContext,
        schedule: ScheduleId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ScheduleRunReceipt>> {
        Box::pin(self.control.list_schedule_runs(ctx, schedule, page))
    }
    fn claim_schedule(
        &self,
        ctx: MaintenanceContext,
        request: ClaimSchedule,
    ) -> PortFuture<'_, ScheduleClaim> {
        Box::pin(self.control.claim_schedule(ctx, request))
    }
    fn record_schedule_result(
        &self,
        ctx: MaintenanceContext,
        result: ScheduleResult,
    ) -> PortFuture<'_, ScheduleRunReceipt> {
        Box::pin(self.control.record_schedule_result(ctx, result))
    }
    fn ensure_run_inactive(
        &self,
        ctx: AccountContext,
        space: SpaceId,
        run: AgentRunId,
    ) -> PortFuture<'_, ()> {
        Box::pin(self.control.ensure_run_inactive(ctx, space, run))
    }
    fn select_provider(
        &self,
        ctx: SpaceContext,
        request: SelectProvider,
    ) -> PortFuture<'_, ProviderSelection> {
        Box::pin(self.provider.select_provider(ctx, request))
    }
    fn update_provider_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> PortFuture<'_, ControlCommit<SetProviderPreference>> {
        Box::pin(self.provider.set_preference(ctx, request))
    }
    fn complete(
        &self,
        ctx: SpaceContext,
        request: CompletionRequest,
    ) -> PortFuture<'_, Box<dyn PortStream<CompletionEvent>>> {
        Box::pin(self.provider.complete(ctx, request))
    }
}

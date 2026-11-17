use super::*;
impl AgentTelemetryPort for ControlService {
    fn telemetry_settings(&self, ctx: AccountContext) -> PortFuture<'_, TelemetrySettings> {
        Box::pin(Self::telemetry_settings(self, ctx))
    }
    fn update_telemetry_settings(
        &self,
        ctx: AccountContext,
        request: AccountMutation<TelemetrySettings>,
    ) -> PortFuture<'_, ControlCommit<TelemetrySettings>> {
        Box::pin(Self::update_telemetry_settings(self, ctx, request))
    }
    fn begin_agent_call(&self, ctx: AccountContext, request: BeginAgentCall) -> PortFuture<'_, ()> {
        Box::pin(Self::begin_agent_call(self, ctx, request))
    }
    fn finish_agent_call(
        &self,
        ctx: MaintenanceContext,
        request: FinishAgentCall,
    ) -> PortFuture<'_, ()> {
        Box::pin(Self::finish_agent_call(self, ctx, request))
    }
    fn record_agent_retrieval(
        &self,
        ctx: AccountContext,
        request: AgentRetrieval,
    ) -> PortFuture<'_, ()> {
        Box::pin(Self::record_agent_retrieval(self, ctx, request))
    }
    fn get_agent_call(
        &self,
        ctx: AccountContext,
        call: RequestId,
    ) -> PortFuture<'_, AgentCallInfo> {
        Box::pin(Self::get_agent_call(self, ctx, call))
    }
    fn list_agent_calls(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentCallInfo>> {
        Box::pin(Self::list_agent_calls(self, ctx, page))
    }
    fn cleanup_telemetry(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> PortFuture<'_, TelemetryCleanup> {
        Box::pin(Self::cleanup_telemetry(self, ctx, limit))
    }
}

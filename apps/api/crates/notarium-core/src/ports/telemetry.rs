//! Content-free telemetry. Raw prompts, headers, errors and tool results have
//! no representable field, even when detailed capture is explicitly enabled.
use super::{
    PortFuture,
    context::*,
    control::{AccountMutation, ControlCommit, ControlPage, ControlPageRequest},
};
use crate::{
    ids::*,
    model::{FolderRef, NoteRef},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOperation {
    Read,
    Search,
    List,
    Context,
    Ability,
    Memory,
    Mutation,
    Provider,
    Schedule,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTransport {
    Mcp,
    Http,
    Internal,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEffect {
    None,
    Read,
    Write,
    External,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOutcome {
    Succeeded,
    Failed,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFailure {
    Denied,
    InvalidRequest,
    Conflict,
    Unavailable,
    Cancelled,
    DeadlineExceeded,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum TelemetryResource {
    Space(SpaceId),
    Folder(FolderRef),
    Note(NoteRef),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentCounter {
    InputTokens,
    OutputTokens,
    CacheHits,
    Reads,
    Writes,
    ToolCalls,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CounterSample {
    pub counter: AgentCounter,
    pub value: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentStepSummary {
    pub operation: AgentOperation,
    pub outcome: AgentOutcome,
    pub duration_ms: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct AgentCallDetail {
    pub resources: Vec<TelemetryResource>,
    pub counters: Vec<CounterSample>,
    pub steps: Vec<AgentStepSummary>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeginAgentCall {
    pub call: RequestId,
    pub request: RequestId,
    pub episode: Option<EpisodeId>,
    pub operation: AgentOperation,
    pub transport: AgentTransport,
    pub effect: AgentEffect,
    pub input_bytes: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishAgentCall {
    pub call: RequestId,
    pub outcome: AgentOutcome,
    pub failure: Option<AgentFailure>,
    pub output_bytes: u64,
    pub detail: Option<AgentCallDetail>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalKind {
    FullText,
    Semantic,
    Hybrid,
    Exact,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRetrieval {
    pub id: RequestId,
    pub call: Option<RequestId>,
    pub kind: RetrievalKind,
    pub hits: Vec<NoteRef>,
    pub result_count: u32,
    pub top_score: Option<f64>,
}
#[derive(Clone, Debug)]
pub struct AgentCallInfo {
    pub start: BeginAgentCall,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub outcome: Option<AgentOutcome>,
    pub failure: Option<AgentFailure>,
    pub output_bytes: Option<u64>,
    pub detail: Option<AgentCallDetail>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelemetrySettings {
    pub detailed_enabled: bool,
    pub compact_retention_days: u16,
    pub detailed_retention_days: u16,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug)]
pub struct TelemetryCleanup {
    pub details: u16,
    pub retrievals: u16,
    pub calls: u16,
    pub commands: u16,
    pub has_more: bool,
}
pub trait AgentTelemetryPort: Send + Sync {
    fn telemetry_settings(&self, ctx: AccountContext) -> PortFuture<'_, TelemetrySettings>;
    fn update_telemetry_settings(
        &self,
        ctx: AccountContext,
        request: AccountMutation<TelemetrySettings>,
    ) -> PortFuture<'_, ControlCommit<TelemetrySettings>>;
    fn begin_agent_call(&self, ctx: AccountContext, request: BeginAgentCall) -> PortFuture<'_, ()>;
    /// The trusted middleware can finish an audit after its original credential
    /// expires. This path cannot mint account authority or execute a tool.
    fn finish_agent_call(
        &self,
        ctx: MaintenanceContext,
        request: FinishAgentCall,
    ) -> PortFuture<'_, ()>;
    fn record_agent_retrieval(
        &self,
        ctx: AccountContext,
        request: AgentRetrieval,
    ) -> PortFuture<'_, ()>;
    fn get_agent_call(&self, ctx: AccountContext, call: RequestId)
    -> PortFuture<'_, AgentCallInfo>;
    fn list_agent_calls(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<AgentCallInfo>>;
    fn cleanup_telemetry(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> PortFuture<'_, TelemetryCleanup>;
}

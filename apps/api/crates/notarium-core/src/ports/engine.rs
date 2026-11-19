use super::{PortFuture, SpaceContext, types::*};
use crate::{ids::*, model::*, query::*};

pub trait NoteReadPort: Send + Sync {
    /// Read exactly one committed protected package resource. The canonical owner
    /// checks Space/history, live package visibility and authorization before
    /// returning bytes; a missing revision/resource never falls back to latest.
    fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> PortFuture<'_, crate::classes::ClassifiedAbilityResource>;
    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot>;
    fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage>;
    fn recent_activity(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult>;
    fn read_changes(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult>;
}
pub trait NoteWritePort: Send + Sync {
    fn create_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<CreateNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn edit_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<EditNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn delete_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<DeleteNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn mint_and_purge(
        &self,
        ctx: SpaceContext,
        request: Mutation<MintAndPurge>,
    ) -> PortFuture<'_, Committed<MintAndPurgeResult>>;
    fn move_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn rename_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn move_folder(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveFolder>,
    ) -> PortFuture<'_, Committed<FolderRef>>;
    fn rename_folder(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameFolder>,
    ) -> PortFuture<'_, Committed<FolderRef>>;
    fn rename_project(
        &self,
        ctx: SpaceContext,
        request: Mutation<RenameProject>,
    ) -> PortFuture<'_, Committed<FolderRef>>;
    fn accept_batch(
        &self,
        ctx: SpaceContext,
        request: AcceptBatch,
    ) -> PortFuture<'_, BatchResult<NoteRevision>>;
    fn append_memory(
        &self,
        ctx: SpaceContext,
        request: Mutation<AppendMemory>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn link(&self, ctx: SpaceContext, request: Mutation<Link>) -> PortFuture<'_, Committed<Link>>;
    fn link_many(&self, ctx: SpaceContext, request: LinkBatch)
    -> PortFuture<'_, BatchResult<Link>>;
    fn publish_ability_package(
        &self,
        ctx: SpaceContext,
        request: Mutation<PublishAbilityPackage>,
    ) -> PortFuture<'_, Committed<AbilityPackageRevision>>;
    fn rollback_agent_run(
        &self,
        ctx: SpaceContext,
        request: Mutation<RollbackAgentRun>,
    ) -> PortFuture<'_, Committed<RollbackResult>>;
    fn accept_external_observation(
        &self,
        ctx: SpaceContext,
        request: Mutation<ExternalObservation>,
    ) -> PortFuture<'_, ExternalObservationResult>;
}
pub trait ChatPort: Send + Sync {
    fn read_chat(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatBranch>;
    fn create_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<CreateChat>,
    ) -> PortFuture<'_, Committed<ChatThread>>;
    fn fork_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<ForkChat>,
    ) -> PortFuture<'_, Committed<ChatThread>>;
    fn append_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<AppendChat>,
    ) -> PortFuture<'_, Committed<ChatEntry>>;
    fn queue_chat_input(
        &self,
        ctx: SpaceContext,
        request: Mutation<PendingChatInput>,
    ) -> PortFuture<'_, QueueInputOutcome>;
    fn consume_chat_input(
        &self,
        ctx: SpaceContext,
        request: Mutation<ConsumePending>,
    ) -> PortFuture<'_, Committed<ConsumedPending>>;
    fn redact_chat_entry(
        &self,
        ctx: SpaceContext,
        request: Mutation<RedactChatEntry>,
    ) -> PortFuture<'_, Committed<RedactedChat>>;
}
pub trait ViewGraphPort: Send + Sync {
    fn query_view(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<ViewQuery>,
    ) -> PortFuture<'_, ViewResult>;
    fn move_board_card(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveBoardCard>,
    ) -> PortFuture<'_, Committed<BoardMoveResult>>;
    fn query_graph(&self, ctx: SpaceContext, request: GraphQuery) -> PortFuture<'_, GraphResult>;
}
pub trait SearchPort: Send + Sync {
    fn search(&self, ctx: SpaceContext, request: SearchQuery) -> PortFuture<'_, SearchResult>;
    fn recall(&self, ctx: SpaceContext, request: RecallQuery) -> PortFuture<'_, SearchResult>;
}
pub trait ContentJobPort: Send + Sync {
    fn create_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<ContentJobKind>,
    ) -> PortFuture<'_, Committed<ContentJob>>;
    fn get_job(&self, ctx: SpaceContext, job: JobId) -> PortFuture<'_, ContentJob>;
    fn list_jobs(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<JobQuery, JobId>,
    ) -> PortFuture<'_, CursorPage<ContentJob, JobId>>;
    fn cancel_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<CancelJob>,
    ) -> PortFuture<'_, Committed<ContentJob>>;
}
pub trait EnginePort:
    NoteReadPort + NoteWritePort + ChatPort + ViewGraphPort + SearchPort + ContentJobPort
{
}
impl<T: NoteReadPort + NoteWritePort + ChatPort + ViewGraphPort + SearchPort + ContentJobPort>
    EnginePort for T
{
}

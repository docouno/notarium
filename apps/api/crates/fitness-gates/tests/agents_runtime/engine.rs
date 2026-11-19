use notarium_canonical::CanonicalStore;
use notarium_core::{
    DomainError,
    classes::ClassifiedAbilityResource,
    ids::*,
    model::{FolderRef, NoteRef},
    ports::*,
    query::*,
    receipt::CausalBasis,
};
use std::collections::BTreeMap;

pub struct TestEngine(pub CanonicalStore);

macro_rules! canonical_port {
    ($port:ident; $($method:ident($request:ty) -> $output:ty),+ $(,)?) => {
        impl $port for TestEngine {
            $(
                fn $method(&self, ctx: SpaceContext, request: $request) -> PortFuture<'_, $output> {
                    $port::$method(&self.0, ctx, request)
                }
            )+
        }
    };
}

canonical_port!(NoteWritePort;
    ensure_folder_path(Mutation<EnsureFolderPath>) -> FolderRef,
    create_note(Mutation<CreateNote>) -> Committed<NoteRevision>,
    edit_note(Mutation<EditNote>) -> Committed<NoteRevision>,
    delete_note(Mutation<DeleteNote>) -> Committed<NoteRevision>,
    mint_and_purge(Mutation<MintAndPurge>) -> Committed<MintAndPurgeResult>,
    move_note(Mutation<MoveNote>) -> Committed<NoteRevision>,
    rename_note(Mutation<RenameNote>) -> Committed<NoteRevision>,
    move_folder(Mutation<MoveFolder>) -> Committed<FolderRef>,
    rename_folder(Mutation<RenameFolder>) -> Committed<FolderRef>,
    rename_project(Mutation<RenameProject>) -> Committed<FolderRef>,
    accept_batch(AcceptBatch) -> BatchResult<NoteRevision>,
    append_memory(Mutation<AppendMemory>) -> Committed<MemoryAppendResult>,
    link(Mutation<Link>) -> Committed<Link>,
    link_many(LinkBatch) -> BatchResult<Link>,
    publish_ability_package(Mutation<PublishAbilityPackage>) -> Committed<AbilityPackageRevision>,
    trash_ability_package(Mutation<TrashAbilityPackage>) -> Committed<NoteRevision>,
    rollback_agent_run(Mutation<RollbackAgentRun>) -> Committed<RollbackResult>,
    accept_external_observation(Mutation<ExternalObservation>) -> ExternalObservationResult,
);

canonical_port!(ChatPort;
    read_chat(ChatRead) -> ChatBranch,
    read_chat_context(ChatRead) -> ChatBranch,
    read_chat_contents(ChatContentRead) -> Vec<HydratedChatEntry>,
    read_chat_proposal(ChatProposalRead) -> CanonicalChatProposal,
    stage_chat_blob(String) -> StagedChatBlob,
    discard_staged_chat_blob(StagedChatBlob) -> (),
    create_chat(Mutation<CreateChat>) -> Committed<ChatThread>,
    fork_chat(Mutation<ForkChat>) -> Committed<ChatThread>,
    append_chat(Mutation<AppendChat>) -> Committed<ChatEntry>,
    queue_chat_input(Mutation<PendingChatInput>) -> QueueInputOutcome,
    consume_chat_input(Mutation<ConsumePending>) -> Committed<ConsumedPending>,
    list_pending_chat_inputs(ChatThreadId) -> Vec<QueuedChatInput>,
    dismiss_chat_input(DismissPending) -> bool,
    claim_active_run(ClaimChatRun) -> ClaimChatRunOutcome,
    finish_run_if_queue_empty(ChatRunRequest) -> FinishChatRunOutcome,
    recover_active_run(ChatRunRequest) -> FinishChatRunOutcome,
    redact_chat_entry(Mutation<RedactChatEntry>) -> Committed<RedactedChat>,
);

canonical_port!(ContentJobPort;
    create_job(Mutation<ContentJobKind>) -> Committed<ContentJob>,
    get_job(JobId) -> ContentJob,
    list_jobs(ReadRequest<JobQuery, JobId>) -> CursorPage<ContentJob, JobId>,
    cancel_job(Mutation<CancelJob>) -> Committed<ContentJob>,
);

impl NoteReadPort for TestEngine {
    fn resolve_folder_path(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        path: String,
    ) -> PortFuture<'_, Option<FolderSnapshot>> {
        Box::pin(self.0.resolve_folder_path(ctx, base, path))
    }

    fn list_child_folders(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        after: Option<FolderId>,
        limit: PageLimit,
    ) -> PortFuture<'_, ChildFolders> {
        Box::pin(self.0.list_child_folders(ctx, base, after, limit))
    }

    fn resolve_note_target(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        target: String,
    ) -> PortFuture<'_, Option<NoteRef>> {
        Box::pin(self.0.resolve_note_target(ctx, parent, target))
    }

    fn space_schema(&self, ctx: SpaceContext) -> PortFuture<'_, BTreeMap<String, FieldSchema>> {
        Box::pin(self.0.space_schema(ctx))
    }

    fn project_note_counts(
        &self,
        _: SpaceContext,
        _: FolderRef,
        _: CausalBasis,
    ) -> PortFuture<'_, ProjectNoteCounts> {
        unavailable()
    }

    fn prepare_agent_run_rollback(
        &self,
        ctx: SpaceContext,
        run: AgentRunId,
    ) -> PortFuture<'_, RollbackAgentRun> {
        Box::pin(self.0.prepare_agent_run_rollback(ctx, run))
    }

    fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> PortFuture<'_, ClassifiedAbilityResource> {
        Box::pin(self.0.read_ability_resource(ctx, request))
    }

    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot> {
        Box::pin(self.0.get_note(ctx, request))
    }

    fn list_notes(&self, _: SpaceContext, _: ReadRequest<NoteQuery>) -> PortFuture<'_, FolderPage> {
        unavailable()
    }

    fn recent_activity(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(self.0.recent_activity(ctx, request))
    }

    fn read_changes(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(self.0.read_changes(ctx, request))
    }
}

impl ViewGraphPort for TestEngine {
    fn query_view(&self, _: SpaceContext, _: ReadRequest<ViewQuery>) -> PortFuture<'_, ViewResult> {
        unavailable()
    }

    fn move_board_card(
        &self,
        _: SpaceContext,
        _: Mutation<MoveBoardCard>,
    ) -> PortFuture<'_, Committed<BoardMoveResult>> {
        unavailable()
    }

    fn query_graph(&self, _: SpaceContext, _: GraphQuery) -> PortFuture<'_, GraphResult> {
        unavailable()
    }
}

impl SearchPort for TestEngine {
    fn search(&self, _: SpaceContext, _: SearchQuery) -> PortFuture<'_, SearchResult> {
        unavailable()
    }

    fn recall(&self, _: SpaceContext, _: RecallQuery) -> PortFuture<'_, SearchResult> {
        unavailable()
    }
}

fn unavailable<T: 'static>() -> PortFuture<'static, T> {
    Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
}

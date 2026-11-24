use super::{PortFuture, SpaceContext, types::*};
use crate::{ids::*, model::*, query::*, receipt::CausalBasis};
use std::collections::BTreeMap;

pub trait NoteReadPort: Send + Sync {
    fn resolve_folder_path(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        path: String,
    ) -> PortFuture<'_, Option<FolderSnapshot>>;
    fn list_child_folders(
        &self,
        ctx: SpaceContext,
        base: Option<FolderId>,
        after: Option<FolderId>,
        at_seq: Option<SpaceSeq>,
        limit: PageLimit,
    ) -> PortFuture<'_, ChildFolders>;
    fn resolve_note_target(
        &self,
        ctx: SpaceContext,
        parent: Option<FolderId>,
        slug_title_or_id: String,
    ) -> PortFuture<'_, Option<NoteRef>>;
    fn space_schema(&self, ctx: SpaceContext) -> PortFuture<'_, BTreeMap<String, FieldSchema>>;
    /// Aggregate only visible notes from the exact project and requested history.
    /// Counts and the source cut use the caller's live class and project grants.
    fn project_note_counts(
        &self,
        ctx: SpaceContext,
        project: FolderRef,
        causal: crate::receipt::CausalBasis,
    ) -> PortFuture<'_, ProjectNoteCounts>;
    /// Read exactly one committed protected package resource. The canonical owner
    /// checks Space/history, live package visibility and authorization before
    /// returning bytes; a missing revision/resource never falls back to latest.
    fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> PortFuture<'_, crate::classes::ClassifiedAbilityResource>;
    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot>;
    fn get_note_metadata(
        &self,
        ctx: SpaceContext,
        request: GetNote,
    ) -> PortFuture<'_, NoteMetadataSnapshot>;
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
    fn ensure_folder_path(
        &self,
        ctx: SpaceContext,
        request: Mutation<EnsureFolderPath>,
    ) -> PortFuture<'_, FolderRef>;
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
    ) -> PortFuture<'_, Committed<MemoryAppendResult>>;
    fn link(&self, ctx: SpaceContext, request: Mutation<Link>) -> PortFuture<'_, Committed<Link>>;
    fn link_many(&self, ctx: SpaceContext, request: LinkBatch)
    -> PortFuture<'_, BatchResult<Link>>;
    fn publish_ability_package(
        &self,
        ctx: SpaceContext,
        request: Mutation<PublishAbilityPackage>,
    ) -> PortFuture<'_, Committed<AbilityPackageRevision>>;
    fn trash_ability_package(
        &self,
        ctx: SpaceContext,
        request: Mutation<TrashAbilityPackage>,
    ) -> PortFuture<'_, Committed<NoteRevision>>;
    fn rollback_agent_run(
        &self,
        ctx: SpaceContext,
        request: Mutation<RollbackAgentRun>,
    ) -> PortFuture<'_, Committed<RollbackResult>>;
    /// Resolve the current rollback plan internally. The durable command is
    /// identified by the run, even after a successful rollback changes the plan.
    fn rollback_agent_run_by_id(
        &self,
        ctx: SpaceContext,
        request: Mutation<AgentRunId>,
    ) -> PortFuture<'_, Committed<RollbackResult>>;
    fn accept_external_observation(
        &self,
        ctx: SpaceContext,
        request: Mutation<ExternalObservation>,
    ) -> PortFuture<'_, ExternalObservationResult>;
}
pub trait ChatPort: Send + Sync {
    fn read_chat(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatBranch>;
    /// A bounded prompt window. A live prefix checkpoint is presented before
    /// its retained original suffix, with its durable sequence unchanged.
    /// Prompt windows omit historical empty human entries, which remain available
    /// through the audit reader.
    fn read_chat_context(&self, ctx: SpaceContext, request: ChatRead)
    -> PortFuture<'_, ChatBranch>;
    /// Read the oldest logical window when the suffix extends beyond a single page.
    fn read_chat_compaction_prefix(
        &self,
        ctx: SpaceContext,
        request: ChatRead,
    ) -> PortFuture<'_, ChatCompactionPrefix>;
    fn read_chat_contents(
        &self,
        ctx: SpaceContext,
        request: ChatContentRead,
    ) -> PortFuture<'_, Vec<HydratedChatEntry>>;
    fn read_chat_proposal(
        &self,
        ctx: SpaceContext,
        request: ChatProposalRead,
    ) -> PortFuture<'_, CanonicalChatProposal>;
    fn stage_chat_blob(&self, ctx: SpaceContext, text: String) -> PortFuture<'_, StagedChatBlob>;
    fn discard_staged_chat_blob(
        &self,
        ctx: SpaceContext,
        staged: StagedChatBlob,
    ) -> PortFuture<'_, ()>;
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
    fn submit_user_chat_input(
        &self,
        ctx: SpaceContext,
        request: SubmitUserChatInput,
    ) -> PortFuture<'_, SubmitUserChatOutcome>;
    fn lookup_user_chat_input(
        &self,
        ctx: SpaceContext,
        request: &SubmitUserChatInput,
    ) -> PortFuture<'_, Option<SubmitUserChatOutcome>>;
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
    fn list_pending_chat_inputs(
        &self,
        ctx: SpaceContext,
        thread: ChatThreadId,
    ) -> PortFuture<'_, Vec<QueuedChatInput>>;
    fn dismiss_chat_input(
        &self,
        ctx: SpaceContext,
        request: DismissPending,
    ) -> PortFuture<'_, bool>;
    fn claim_active_run(
        &self,
        ctx: SpaceContext,
        request: ClaimChatRun,
    ) -> PortFuture<'_, ClaimChatRunOutcome>;
    fn finish_run_if_queue_empty(
        &self,
        ctx: SpaceContext,
        request: ChatRunRequest,
    ) -> PortFuture<'_, FinishChatRunOutcome>;
    fn recover_active_run(
        &self,
        ctx: SpaceContext,
        request: ChatRunRequest,
    ) -> PortFuture<'_, FinishChatRunOutcome>;
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
pub trait LinkReadPort: Send + Sync {
    fn note_links(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        direction: NoteLinkDirection,
        after: Option<NoteLinkCursor>,
        limit: PageLimit,
    ) -> PortFuture<'_, NoteLinkPage>;
    fn chat_backlinks(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        causal: CausalBasis,
    ) -> PortFuture<'_, Vec<ChatBacklink>>;
    fn chat_backlinks_page(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        causal: CausalBasis,
        after: Option<ChatBacklinkCursor>,
        limit: PageLimit,
    ) -> PortFuture<'_, ChatBacklinkPage>;
}
/// Admit ranked note metadata before counting a result or loading its chunks.
/// The final consumer still validates the exact source when disclosing its content.
pub trait SearchRecipient: Send + Sync {
    /// A recipient that supplies only recall framing can skip metadata preflight.
    fn filters_notes(&self) -> bool {
        true
    }
    fn admit<'a>(&'a self, card: &'a crate::classes::ClassifiedMetadata) -> PortFuture<'a, bool>;
    /// Additional context tokens charged by recall for a delivered chunk.
    fn framing_tokens(&self, _note: &NoteId, _first_chunk: bool) -> u32 {
        0
    }
    /// Non-encrypted document classes the calling model may have observed when
    /// authoring this query. Remote query embedding must cover every class here.
    fn query_source_classes(&self) -> Option<std::collections::BTreeSet<crate::classes::DocClass>> {
        None
    }
    /// Project confinement of the calling model's provider policy when authoring
    /// this query: `Some(Some(project))` when confined to `project`, `Some(None)`
    /// when Space-wide/unconfined, or `None` when not an in-app provider call.
    fn query_source_project(&self) -> Option<Option<FolderRef>> {
        None
    }
}

pub trait SearchPort: Send + Sync {
    fn search(&self, ctx: SpaceContext, request: SearchQuery) -> PortFuture<'_, SearchResult> {
        self.search_for(ctx, request, None)
    }
    fn search_for<'a>(
        &'a self,
        ctx: SpaceContext,
        request: SearchQuery,
        recipient: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult>;
    fn recall(&self, ctx: SpaceContext, request: RecallQuery) -> PortFuture<'_, SearchResult> {
        self.recall_for(ctx, request, None)
    }
    fn recall_for<'a>(
        &'a self,
        ctx: SpaceContext,
        request: RecallQuery,
        recipient: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult>;
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

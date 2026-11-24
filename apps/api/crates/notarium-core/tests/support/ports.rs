//! Compile-time contract doubles. No runtime implementation or latency claim.
use notarium_core::{
    DomainError,
    auth::*,
    ids::*,
    model::*,
    ports::{control::*, *},
    query::*,
    receipt::*,
    value::Timestamp,
};

pub struct RejectingPorts;
macro_rules! reject {
    ($(fn $name:ident(&self $(, $arg:ident: $ty:ty)* $(,)?) -> $ret:ty;)*) => {
        $(fn $name(&self $(, $arg: $ty)*) -> $ret {
            let _ = ($($arg,)*);
            Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
        })*
    };
}
impl NoteReadPort for RejectingPorts {
    reject! {
    fn resolve_folder_path(&self, ctx: SpaceContext, base: Option<FolderId>, path: String) -> PortFuture<'_, Option<FolderSnapshot>>;
    fn list_child_folders(&self, ctx: SpaceContext, base: Option<FolderId>, after: Option<FolderId>, at_seq: Option<SpaceSeq>, limit: PageLimit) -> PortFuture<'_, ChildFolders>;
    fn resolve_note_target(&self, ctx: SpaceContext, parent: Option<FolderId>, slug_title_or_id: String) -> PortFuture<'_, Option<NoteRef>>;
    fn space_schema(&self, ctx: SpaceContext) -> PortFuture<'_, std::collections::BTreeMap<String, FieldSchema>>;
    fn project_note_counts(&self, ctx: SpaceContext, project: FolderRef, causal: CausalBasis) -> PortFuture<'_, ProjectNoteCounts>;
    fn read_ability_resource(&self, ctx: SpaceContext, request: ReadAbilityResource) -> PortFuture<'_, notarium_core::classes::ClassifiedAbilityResource>;
    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot>;
    fn get_note_metadata(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteMetadataSnapshot>;
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
}
impl NoteWritePort for RejectingPorts {
    reject! {
    fn ensure_folder_path(&self, ctx: SpaceContext, request: Mutation<EnsureFolderPath>) -> PortFuture<'_, FolderRef>;
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
    fn trash_ability_package(
            &self,
            ctx: SpaceContext,
            request: Mutation<TrashAbilityPackage>,
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
    fn rollback_agent_run(
            &self,
            ctx: SpaceContext,
            request: Mutation<RollbackAgentRun>,
        ) -> PortFuture<'_, Committed<RollbackResult>>;
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
}
impl ChatPort for RejectingPorts {
    reject! {
    fn read_chat(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatBranch>;
    fn read_chat_compaction_prefix(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatCompactionPrefix>;
    fn read_chat_context(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatBranch>;
    fn read_chat_contents(&self, ctx: SpaceContext, request: ChatContentRead) -> PortFuture<'_, Vec<HydratedChatEntry>>;
    fn read_chat_proposal(&self, ctx: SpaceContext, request: ChatProposalRead) -> PortFuture<'_, CanonicalChatProposal>;
    fn stage_chat_blob(&self, ctx: SpaceContext, text: String) -> PortFuture<'_, StagedChatBlob>;
    fn discard_staged_chat_blob(&self, ctx: SpaceContext, staged: StagedChatBlob) -> PortFuture<'_, ()>;
    fn list_pending_chat_inputs(&self, ctx: SpaceContext, thread: ChatThreadId) -> PortFuture<'_, Vec<QueuedChatInput>>;
    fn dismiss_chat_input(&self, ctx: SpaceContext, request: DismissPending) -> PortFuture<'_, bool>;
    fn claim_active_run(&self, ctx: SpaceContext, request: ClaimChatRun) -> PortFuture<'_, ClaimChatRunOutcome>;
    fn finish_run_if_queue_empty(&self, ctx: SpaceContext, request: ChatRunRequest) -> PortFuture<'_, FinishChatRunOutcome>;
    fn recover_active_run(&self, ctx: SpaceContext, request: ChatRunRequest) -> PortFuture<'_, FinishChatRunOutcome>;
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
    fn submit_user_chat_input(&self, ctx: SpaceContext, request: SubmitUserChatInput) -> PortFuture<'_, SubmitUserChatOutcome>;
    fn lookup_user_chat_input(&self, ctx: SpaceContext, request: &SubmitUserChatInput) -> PortFuture<'_, Option<SubmitUserChatOutcome>>;
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
}
impl ViewGraphPort for RejectingPorts {
    reject! {
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
}
impl SearchPort for RejectingPorts {
    fn search_for<'a>(
        &'a self,
        _: SpaceContext,
        _: SearchQuery,
        _: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
    fn recall_for<'a>(
        &'a self,
        _: SpaceContext,
        _: RecallQuery,
        _: Option<&'a dyn SearchRecipient>,
    ) -> PortFuture<'a, SearchResult> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
}
impl ContentJobPort for RejectingPorts {
    reject! {
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
}
impl ControlPort for RejectingPorts {
    reject! {
    fn resolve_auth(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext>;
    fn revalidate_auth(&self, ctx: AccountContext) -> PortFuture<'_, EngineAuthContext>;
    fn revalidate_chat_viewer(
        &self,
        ctx: AccountContext,
    ) -> PortFuture<'_, (EngineAuthContext, Option<std::time::Instant>)>;
    fn fence_canonical_effect(
        &self,
        authority: EngineAuthContext,
        ctx: SpaceContext,
        effect: CanonicalEffect,
    ) -> PortFuture<'_, SpaceContext>;
    fn revalidate_proposal_human(
        &self,
        ctx: AccountContext,
        access: ProposalHumanAccess,
    ) -> PortFuture<'_, EngineAuthContext>;
    fn whoami(&self, ctx: AccountContext) -> PortFuture<'_, PrincipalInfo>;
    fn list_spaces(&self, ctx: AccountContext, page: ControlPageRequest) -> PortFuture<'_, ControlPage<AccessibleSpace>>;
    fn list_projects(&self, ctx: AccountContext, page: ControlPageRequest) -> PortFuture<'_, ControlPage<ProjectInfo>>;
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
}
impl StructuralReadPort for RejectingPorts {
    reject! {
    fn acquire_snapshot(
            &self,
            ctx: SpaceContext,
            causal: CausalBasis,
        ) -> PortFuture<'_, Box<dyn StructuralSnapshot>>;
    fn hydrate(
            &self,
            ctx: SpaceContext,
            cut: SnapshotCut,
            notes: Vec<NoteId>,
        ) -> PortFuture<'_, Vec<Option<NoteCard>>>;
        }
    fn is_live_visible<'a>(
        &'a self,
        ctx: &'a SpaceContext,
        note: &'a NoteId,
    ) -> PortFuture<'a, bool> {
        let _ = (ctx, note);
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
}
impl ChangeBroadcast for RejectingPorts {
    reject! {
    fn subscribe(
            &self,
            ctx: MaintenanceContext,
            after: ChangeCursor,
        ) -> PortFuture<'_, Box<dyn ChangeSubscription>>;
    fn catch_up(
            &self,
            ctx: MaintenanceContext,
            request: ChangeRead,
        ) -> PortFuture<'_, ChangeReadResult>;
        }
}
impl EmbeddingProviderPort for RejectingPorts {
    reject! {
    fn embed(
            &self,
            ctx: SpaceContext,
            request: EmbeddingRequest,
        ) -> PortFuture<'_, EmbeddingResult>;
        }
}
impl LiveCollabInterceptor for RejectingPorts {
    reject! {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult>;
    fn reserve_rollback(
            &self,
            ctx: SpaceContext,
            note: NoteId,
            identity: CommandIdentity,
        ) -> PortFuture<'_, RollbackReservation>;
    fn filename_pin(&self, ctx: SpaceContext, note: NoteId) -> PortFuture<'_, FilenamePin>;
        }
}
impl EventBusPort for RejectingPorts {
    reject! {
    fn publish(&self, ctx: MaintenanceContext, event: SpaceEvent) -> PortFuture<'_, ()>;
    fn subscribe(
            &self,
            ctx: SpaceContext,
            after: ChangeCursor,
        ) -> PortFuture<'_, Box<dyn PortStream<SpaceEvent>>>;
        }
}
impl SessionRevocationPort for RejectingPorts {
    reject! {
    fn fence_inactive_provider(
            &self,
            ctx: MaintenanceContext,
            call: RequestId,
        ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>>;
    fn register_provider(
            &self,
            ctx: MaintenanceContext,
            selectors: Vec<RevocationSelector>,
            cancellation: Cancellation,
        ) -> PortFuture<'_, Box<dyn RevocationLease>>;
    fn register_canonical_effect(
            &self,
            ctx: MaintenanceContext,
            selectors: Vec<RevocationSelector>,
            cancellation: Cancellation,
        ) -> PortFuture<'_, std::sync::Arc<dyn CanonicalEffectRegistration>>;
    fn fence_provider(
            &self,
            ctx: MaintenanceContext,
            selectors: Vec<RevocationSelector>,
        ) -> PortFuture<'_, Box<dyn RevocationLease>>;
    fn revoke(
            &self,
            ctx: MaintenanceContext,
            selector: RevocationSelector,
            reason: RevocationReason,
        ) -> PortFuture<'_, ()>;
        }
}
impl BackupParticipantPort for RejectingPorts {
    reject! {
    fn prepare(
            &self,
            ctx: MaintenanceContext,
            backup: BackupId,
            budget: BackupBudget,
        ) -> PortFuture<'_, Box<dyn PreparedBackup>>;
    fn restore_cursors(
            &self,
            ctx: MaintenanceContext,
            restored: Vec<ChangeCursor>,
        ) -> PortFuture<'_, ()>;
        }
}
impl BoardMutationFactsProvider for RejectingPorts {
    fn evaluate_move<'a>(
        &'a self,
        _authority: &'a BoardPlannerAuthority,
        _ctx: SpaceContext,
        _cutoff: Option<SpaceSeq>,
        _intent: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
    fn evaluate_rollback<'a>(
        &'a self,
        _authority: &'a BoardPlannerAuthority,
        _ctx: SpaceContext,
        _request: RollbackBoardFactsRequest,
    ) -> PortFuture<'a, RollbackBoardFacts> {
        Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
    }
}

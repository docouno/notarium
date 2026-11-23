use notarium_agents::revocation::RevocationHub;
use notarium_canonical::CanonicalStore;
use notarium_core::{
    DomainError,
    classes::{ClassEgressFence, ClassifiedAbilityResource, ContentPart},
    document::ChunkDescriptor,
    error::{CommitEffect, OperationalFailure, PortError, RetryAdvice, ValidationReason},
    ids::*,
    model::{FolderRef, Lifecycle, NoteRef, SnapshotCut},
    ports::*,
    query::*,
    receipt::CausalBasis,
    span::ByteSpan,
    value::ScalarValue,
};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::oneshot;

pub struct TestEngine(pub CanonicalStore, pub Arc<ProjectionFixtures>);

pub struct TestRevocations(pub Arc<RevocationHub>, pub Arc<ProjectionFixtures>);

struct ObservingEffectRegistration {
    inner: Arc<dyn CanonicalEffectRegistration>,
    fixtures: Arc<ProjectionFixtures>,
    cancellation: Cancellation,
}

impl CanonicalEffectRegistration for ObservingEffectRegistration {
    fn restrict_until(&self, deadline: std::time::Instant) -> Result<(), PortError> {
        self.inner.restrict_until(deadline)
    }

    fn check(&self) -> Result<(), PortError> {
        self.inner.check()
    }

    fn begin(self: Arc<Self>) -> PortFuture<'static, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let lease = self.inner.clone().begin().await?;
            self.fixtures
                .admitted_sql_effects
                .fetch_add(1, Ordering::Relaxed);
            let pause = self.fixtures.active_sql_effect.lock().unwrap().take();
            if let Some(pause) = pause {
                let _ = pause.entered.send(self.cancellation.clone());
                let _ = pause.release.await;
            }
            Ok(lease)
        })
    }
}

impl SessionRevocationPort for TestRevocations {
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.0.register_provider(ctx, selectors, cancellation)
    }

    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        let fixtures = Arc::clone(&self.1);
        let cancel_clone = cancellation.clone();
        Box::pin(async move {
            let inner = self
                .0
                .register_canonical_effect(ctx, selectors, cancellation)
                .await?;
            Ok(Arc::new(ObservingEffectRegistration {
                inner,
                fixtures,
                cancellation: cancel_clone,
            }) as Arc<dyn CanonicalEffectRegistration>)
        })
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.0.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.0.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.0.revoke(ctx, selector, reason)
    }
}

#[derive(Default)]
pub struct ProjectionFixtures {
    pub(super) real: OnceLock<super::real_reads::DerivedReads>,
    pub admitted_sql_effects: AtomicUsize,
    seed: Mutex<Option<ProjectionFixture>>,
    directory: Mutex<BTreeMap<EffectiveReadId, NoteQuery>>,
    before_ability_trash: Mutex<Option<MutationPause>>,
    before_note_move: Mutex<Option<MutationPause>>,
    after_ability_publication: Mutex<Option<MutationPause>>,
    before_memory_append: Mutex<Option<MutationPause>>,
    lose_note_edit_ack: Mutex<bool>,
    before_chat_consume: Mutex<Option<MutationPause>>,
    before_chat_hydration: Mutex<Option<MutationPause>>,
    chat_consume: Mutex<ChatConsumeFixture>,
    before_chat_submit: Mutex<Option<MutationPause>>,
    before_chat_lookup: Mutex<Option<MutationPause>>,
    before_chat_redact: Mutex<Option<MutationPause>>,
    before_chat_rollback: Mutex<Option<MutationPause>>,
    before_chat_claim: Mutex<Option<MutationPause>>,
    after_chat_claim: Mutex<Option<MutationPause>>,
    arm_pause_chat_read_after_cleared: Mutex<Option<MutationPause>>,
    before_chat_read: Mutex<Option<MutationPause>>,
    active_sql_effect: Mutex<Option<MutationPause>>,
    submit_unknown_then_not_committed: Mutex<u8>,
    lose_claim_acks: Mutex<usize>,
    lose_finish_acks: Mutex<usize>,
    pub fail_finish_once: Mutex<bool>,
}

#[derive(Default)]
struct ChatConsumeFixture {
    attempts: Option<Vec<Mutation<ConsumePending>>>,
    lose_ack_once: bool,
}

struct MutationPause {
    entered: oneshot::Sender<Cancellation>,
    release: oneshot::Receiver<()>,
}

impl MutationPause {
    fn install(
        slot: &Mutex<Option<Self>>,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        let (entered, observed) = oneshot::channel();
        let (resume, release) = oneshot::channel();
        assert!(
            slot.lock()
                .unwrap()
                .replace(Self { entered, release })
                .is_none()
        );
        (observed, resume)
    }

    async fn enter(slot: &Mutex<Option<Self>>, cancellation: Cancellation) {
        let pause = slot.lock().unwrap().take();
        if let Some(pause) = pause {
            let _ = pause.entered.send(cancellation);
            let _ = pause.release.await;
        }
    }
}

#[derive(Clone)]
pub struct ProjectionFixture {
    pub view_owner: NoteRef,
    pub notes: Vec<NoteId>,
}

impl ProjectionFixtures {
    pub fn pause_ability_trash(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_ability_trash)
    }

    pub fn pause_chat_lookup(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_lookup)
    }

    pub fn pause_chat_redaction(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_redact)
    }

    pub fn pause_chat_rollback(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_rollback)
    }

    pub fn fail_chat_submit_unknown_then_not_committed(&self) {
        *self.submit_unknown_then_not_committed.lock().unwrap() = 2;
    }

    pub fn pause_peer_head_refresh_after_finish_cleared(
        &self,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.arm_pause_chat_read_after_cleared)
    }

    pub fn pause_note_move(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_note_move)
    }

    pub fn pause_ability_publication(
        &self,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.after_ability_publication)
    }

    pub fn pause_memory_append(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_memory_append)
    }

    pub fn lose_next_note_edit_ack(&self) {
        *self.lose_note_edit_ack.lock().unwrap() = true;
    }

    pub fn pause_chat_consume(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_consume)
    }

    pub fn pause_chat_hydration(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_hydration)
    }

    pub fn trace_chat_consume_with_lost_ack(&self) {
        let mut fixture = self.chat_consume.lock().unwrap();
        assert!(fixture.attempts.replace(Vec::new()).is_none());
        fixture.lose_ack_once = true;
    }

    pub fn chat_consume_attempts(&self) -> Vec<Mutation<ConsumePending>> {
        self.chat_consume.lock().unwrap().attempts.take().unwrap()
    }

    pub fn pause_chat_submit(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_submit)
    }

    pub fn pause_chat_claim(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_claim)
    }

    pub fn pause_and_lose_chat_claim_acks(
        &self,
        count: usize,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        *self.lose_claim_acks.lock().unwrap() = count;
        MutationPause::install(&self.after_chat_claim)
    }

    pub fn lose_chat_finish_acks(&self, count: usize) {
        *self.lose_finish_acks.lock().unwrap() = count;
    }

    pub fn pause_active_sql_effect(
        &self,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.active_sql_effect)
    }

    pub fn install(&self, fixture: ProjectionFixture) {
        *self.seed.lock().unwrap() = Some(fixture);
    }

    pub fn include_notes(&self, notes: impl IntoIterator<Item = NoteId>) {
        if let Some(seed) = self.seed.lock().unwrap().as_mut() {
            seed.notes.extend(notes);
        }
    }

    fn current(&self, ctx: &SpaceContext) -> Option<ProjectionFixture> {
        self.seed
            .lock()
            .unwrap()
            .as_ref()
            .filter(|fixture| fixture.view_owner.space_id == ctx.scope().space_id)
            .cloned()
    }
}

macro_rules! canonical_port {
    ($port:ident; $($method:ident($request:ty) -> $output:ty),+ $(,)? $(; $($custom:item)*)?) => {
        impl $port for TestEngine {
            $(
                fn $method(&self, ctx: SpaceContext, request: $request) -> PortFuture<'_, $output> {
                    $port::$method(&self.0, ctx, request)
                }
            )+
            $($($custom)*)?
        }
    };
}

canonical_port!(NoteWritePort;
    ensure_folder_path(Mutation<EnsureFolderPath>) -> FolderRef,
    create_note(Mutation<CreateNote>) -> Committed<NoteRevision>,
    delete_note(Mutation<DeleteNote>) -> Committed<NoteRevision>,
    mint_and_purge(Mutation<MintAndPurge>) -> Committed<MintAndPurgeResult>,
    rename_note(Mutation<RenameNote>) -> Committed<NoteRevision>,
    move_folder(Mutation<MoveFolder>) -> Committed<FolderRef>,
    rename_folder(Mutation<RenameFolder>) -> Committed<FolderRef>,
    rename_project(Mutation<RenameProject>) -> Committed<FolderRef>,
    accept_batch(AcceptBatch) -> BatchResult<NoteRevision>,
    link(Mutation<Link>) -> Committed<Link>,
    link_many(LinkBatch) -> BatchResult<Link>,
    rollback_agent_run(Mutation<RollbackAgentRun>) -> Committed<RollbackResult>,
    accept_external_observation(Mutation<ExternalObservation>) -> ExternalObservationResult;

    fn move_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_note_move, ctx.budget.cancellation.clone()).await;
            NoteWritePort::move_note(&self.0, ctx, request).await
        })
    }

    fn rollback_agent_run_by_id(
        &self,
        ctx: SpaceContext,
        request: Mutation<AgentRunId>,
    ) -> PortFuture<'_, Committed<RollbackResult>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_rollback, ctx.budget.cancellation.clone()).await;
            NoteWritePort::rollback_agent_run_by_id(&self.0, ctx, request).await
        })
    }

    fn edit_note(
        &self,
        ctx: SpaceContext,
        request: Mutation<EditNote>,
    ) -> PortFuture<'_, Committed<NoteRevision>> {
        Box::pin(async move {
            let committed = NoteWritePort::edit_note(&self.0, ctx, request).await?;
            if std::mem::take(&mut *self.1.lose_note_edit_ack.lock().unwrap()) {
                return Err(PortError::Unavailable(
                    OperationalFailure::new(
                        ContentDigest::from_bytes([169; 32]),
                        CommitEffect::Unknown,
                        RetryAdvice::RetrySameCommand,
                        true,
                    )
                    .unwrap(),
                ));
            }
            Ok(committed)
        })
    }

    fn append_memory(&self, ctx: SpaceContext, request: Mutation<AppendMemory>) -> PortFuture<'_, Committed<MemoryAppendResult>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_memory_append, ctx.budget.cancellation.clone()).await;
            NoteWritePort::append_memory(&self.0, ctx, request).await
        })
    }
    fn publish_ability_package(&self, ctx: SpaceContext, request: Mutation<PublishAbilityPackage>) -> PortFuture<'_, Committed<AbilityPackageRevision>> {
        Box::pin(async move {
            let cancellation = ctx.budget.cancellation.clone();
            let result = NoteWritePort::publish_ability_package(&self.0, ctx, request).await?;
            MutationPause::enter(&self.1.after_ability_publication, cancellation).await;
            Ok(result)
        })
    }
    fn trash_ability_package(&self, ctx: SpaceContext, request: Mutation<TrashAbilityPackage>) -> PortFuture<'_, Committed<NoteRevision>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_ability_trash, ctx.budget.cancellation.clone()).await;
            NoteWritePort::trash_ability_package(&self.0, ctx, request).await
        })
    }
);

canonical_port!(ChatPort;
    read_chat(ChatRead) -> ChatBranch,
    read_chat_compaction_prefix(ChatRead) -> ChatCompactionPrefix,
    read_chat_proposal(ChatProposalRead) -> CanonicalChatProposal,
    stage_chat_blob(String) -> StagedChatBlob,
    discard_staged_chat_blob(StagedChatBlob) -> (),
    create_chat(Mutation<CreateChat>) -> Committed<ChatThread>,
    fork_chat(Mutation<ForkChat>) -> Committed<ChatThread>,
    append_chat(Mutation<AppendChat>) -> Committed<ChatEntry>,
    queue_chat_input(Mutation<PendingChatInput>) -> QueueInputOutcome,
    list_pending_chat_inputs(ChatThreadId) -> Vec<QueuedChatInput>,
    dismiss_chat_input(DismissPending) -> bool,
    recover_active_run(ChatRunRequest) -> FinishChatRunOutcome;
    fn read_chat_contents(&self, ctx: SpaceContext, request: ChatContentRead) -> PortFuture<'_, Vec<HydratedChatEntry>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_hydration, ctx.budget.cancellation.clone()).await;
            ChatPort::read_chat_contents(&self.0, ctx, request).await
        })
    }
    fn read_chat_context(
        &self,
        ctx: SpaceContext,
        request: ChatRead,
    ) -> PortFuture<'_, ChatBranch> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_read, ctx.budget.cancellation.clone()).await;
            ChatPort::read_chat_context(&self.0, ctx, request).await
        })
    }
    fn redact_chat_entry(
        &self,
        ctx: SpaceContext,
        request: Mutation<RedactChatEntry>,
    ) -> PortFuture<'_, Committed<RedactedChat>> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_redact, ctx.budget.cancellation.clone()).await;
            ChatPort::redact_chat_entry(&self.0, ctx, request).await
        })
    }
    fn lookup_user_chat_input(
        &self,
        ctx: SpaceContext,
        request: &SubmitUserChatInput,
    ) -> PortFuture<'_, Option<SubmitUserChatOutcome>> {
        let request = request.clone();
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_lookup, ctx.budget.cancellation.clone()).await;
            ChatPort::lookup_user_chat_input(&self.0, ctx, &request).await
        })
    }
    fn submit_user_chat_input(&self, ctx: SpaceContext, request: SubmitUserChatInput) -> PortFuture<'_, SubmitUserChatOutcome> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_submit, ctx.budget.cancellation.clone()).await;
            let fault_stage = {
                let mut stage = self.1.submit_unknown_then_not_committed.lock().unwrap();
                let current = *stage;
                if current > 0 {
                    *stage = current - 1;
                }
                current
            };
            if fault_stage == 1 {
                return Err(PortError::Unavailable(
                    OperationalFailure::new(
                        ContentDigest::from_bytes([0xae; 32]),
                        CommitEffect::NotCommitted,
                        RetryAdvice::RetrySameCommand,
                        true,
                    )
                    .unwrap(),
                ));
            }
            let outcome = ChatPort::submit_user_chat_input(&self.0, ctx, request).await?;
            if fault_stage == 2 && matches!(outcome, SubmitUserChatOutcome::Queued(_)) {
                return Err(lost_chat_ack());
            }
            Ok(outcome)
        })
    }
    fn consume_chat_input(&self, ctx: SpaceContext, request: Mutation<ConsumePending>) -> PortFuture<'_, Committed<ConsumedPending>> {
        Box::pin(async move {
            if let Some(attempts) = &mut self.1.chat_consume.lock().unwrap().attempts {
                attempts.push(request.clone());
            }
            MutationPause::enter(&self.1.before_chat_consume, ctx.budget.cancellation.clone()).await;
            let committed = ChatPort::consume_chat_input(&self.0, ctx, request).await?;
            if matches!(&committed.value, ConsumedPending::Appended { .. })
                && std::mem::take(&mut self.1.chat_consume.lock().unwrap().lose_ack_once)
            {
                return Err(lost_chat_ack());
            }
            Ok(committed)
        })
    }
    fn claim_active_run(&self, ctx: SpaceContext, request: ClaimChatRun) -> PortFuture<'_, ClaimChatRunOutcome> {
        Box::pin(async move {
            let cancellation = ctx.budget.cancellation.clone();
            MutationPause::enter(&self.1.before_chat_claim, cancellation.clone()).await;
            let claim = ChatPort::claim_active_run(&self.0, ctx, request).await?;
            if claim == ClaimChatRunOutcome::Claimed && lose_ack(&self.1.lose_claim_acks) {
                MutationPause::enter(&self.1.after_chat_claim, cancellation).await;
                return Err(lost_chat_ack());
            }
            Ok(claim)
        })
    }
    fn finish_run_if_queue_empty(&self, ctx: SpaceContext, request: ChatRunRequest) -> PortFuture<'_, FinishChatRunOutcome> {
        Box::pin(async move {
            if std::mem::take(&mut *self.1.fail_finish_once.lock().unwrap()) {
                return Err(PortError::Internal(OperationalFailure::new(
                    ContentDigest::from_bytes([191; 32]), CommitEffect::NotCommitted, RetryAdvice::Never, false,
                ).unwrap()));
            }
            let finished = ChatPort::finish_run_if_queue_empty(&self.0, ctx, request).await?;
            if finished == FinishChatRunOutcome::Cleared {
                if let Some(pause) = self
                    .1
                    .arm_pause_chat_read_after_cleared
                    .lock()
                    .unwrap()
                    .take()
                {
                    assert!(
                        self.1
                            .before_chat_read
                            .lock()
                            .unwrap()
                            .replace(pause)
                            .is_none()
                    );
                }
                if lose_ack(&self.1.lose_finish_acks) {
                    return Err(lost_chat_ack());
                }
            }
            Ok(finished)
        })
    }
);

fn lose_ack(slot: &Mutex<usize>) -> bool {
    let mut remaining = slot.lock().unwrap();
    if *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    true
}

fn lost_chat_ack() -> PortError {
    PortError::Unavailable(
        OperationalFailure::new(
            ContentDigest::from_bytes([0xad; 32]),
            CommitEffect::Unknown,
            RetryAdvice::RetrySameCommand,
            true,
        )
        .unwrap(),
    )
}

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
        ctx: SpaceContext,
        project: FolderRef,
        causal: CausalBasis,
    ) -> PortFuture<'_, ProjectNoteCounts> {
        if let Some(real) = self.1.real.get() {
            return real.notes.project_note_counts(ctx, project, causal);
        }
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
        if let Some(real) = self.1.real.get() {
            return real.notes.get_note(ctx, request);
        }
        Box::pin(self.0.get_note(ctx, request))
    }

    fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage> {
        if let Some(real) = self.1.real.get() {
            return real.notes.list_notes(ctx, request);
        }
        Box::pin(async move { self.directory_page(&ctx, request).await })
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
    fn query_view(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<ViewQuery>,
    ) -> PortFuture<'_, ViewResult> {
        if let Some(real) = self.1.real.get() {
            return real.projection.query_view(ctx, request);
        }
        Box::pin(async move {
            let fixture = self.1.current(&ctx).ok_or(DomainError::ResourceNotFound)?;
            let ReadRequest::Open { query, .. } = request else {
                return Err(DomainError::ResourceNotFound.into());
            };
            if query.view.note != fixture.view_owner.note_id {
                return Err(DomainError::ResourceNotFound.into());
            }
            let cut = self.cut(&ctx).await?;
            let limit = usize::from(query.limit.get());
            let mut items = Vec::new();
            let read = EffectiveReadId::from_bytes([9; 16]);
            for note in fixture.notes.iter().take(limit) {
                let (card, _) = self.card(&ctx, note.clone()).await?;
                items.push(ViewRow {
                    card,
                    group: GroupKey::Absent,
                    rank: None,
                });
            }
            let next = if fixture.notes.len() > limit {
                Some(KeysetCursor {
                    version: 1,
                    scope: cut.scope.clone(),
                    fingerprint: ContentDigest::from_bytes([9; 32]),
                    effective_read: read.clone(),
                    generation: cut.generation,
                    base_cut: cut.projected_seq,
                    last: SortTuple {
                        cells: vec![SortCell::Absent],
                        entity_id: fixture.notes[limit - 1].clone(),
                    },
                })
            } else {
                None
            };
            Ok(ViewResult {
                rows: CursorPage {
                    items,
                    next,
                    scope: cut.scope,
                    canonical_seq: cut.canonical_seq,
                    projected_seq: cut.projected_seq,
                    incomplete: false,
                    diagnostics: vec![],
                },
                groups: vec![GroupCount {
                    group: GroupKey::Absent,
                    count: fixture.notes.len() as u64,
                }],
                effective_read: read,
            })
        })
    }

    fn move_board_card(
        &self,
        _: SpaceContext,
        _: Mutation<MoveBoardCard>,
    ) -> PortFuture<'_, Committed<BoardMoveResult>> {
        unavailable()
    }

    fn query_graph(&self, ctx: SpaceContext, request: GraphQuery) -> PortFuture<'_, GraphResult> {
        if let Some(real) = self.1.real.get() {
            return real.projection.query_graph(ctx, request);
        }
        Box::pin(async move {
            let fixture = self.1.current(&ctx).ok_or(DomainError::ResourceNotFound)?;
            let GraphTier::Neighborhood { note, hops: 1 } = request.tier else {
                return Err(DomainError::ResourceNotFound.into());
            };
            if note != fixture.view_owner.note_id {
                return Err(DomainError::ResourceNotFound.into());
            }
            let neighbor = fixture
                .notes
                .iter()
                .find(|candidate| **candidate != note)
                .cloned()
                .ok_or(DomainError::ResourceNotFound)?;
            let (card, _) = self.card(&ctx, neighbor.clone()).await?;
            let target = GraphNodeId::Note(neighbor);
            Ok(GraphResult {
                nodes: vec![GraphNode {
                    id: target.clone(),
                    card: Some(card),
                    member_count: 1,
                }],
                edges: vec![GraphEdge {
                    source: GraphNodeId::Note(note),
                    target,
                    weight: 1.0,
                }],
                hidden_count: 0,
                truncated: false,
                cut: self.cut(&ctx).await?,
            })
        })
    }
}

impl SearchPort for TestEngine {
    fn search(&self, ctx: SpaceContext, request: SearchQuery) -> PortFuture<'_, SearchResult> {
        if let Some(real) = self.1.real.get() {
            return real.search.search(ctx, request);
        }
        Box::pin(async move { self.retrieve(&ctx, request).await })
    }

    fn recall(&self, ctx: SpaceContext, request: RecallQuery) -> PortFuture<'_, SearchResult> {
        if let Some(real) = self.1.real.get() {
            return real.search.recall(ctx, request);
        }
        Box::pin(async move { self.retrieve(&ctx, request.query).await })
    }
}

impl TestEngine {
    async fn directory_page(
        &self,
        ctx: &SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> Result<FolderPage, PortError> {
        let fixture = self.1.current(ctx).ok_or(DomainError::ResourceNotFound)?;
        let cut = self.cut(ctx).await?;
        let stale = || DomainError::validation(ValidationReason::CursorStale);
        let (query, read, after) = match request {
            ReadRequest::Open { query, .. } => {
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).unwrap();
                (query, EffectiveReadId::from_bytes(nonce), None)
            }
            ReadRequest::Continue { cursor } => {
                ctx.scope().check(&cursor.scope)?;
                if cursor.base_cut != cut.projected_seq {
                    return Err(stale().into());
                }
                let query = self
                    .1
                    .directory
                    .lock()
                    .unwrap()
                    .get(&cursor.effective_read)
                    .cloned()
                    .ok_or_else(stale)?;
                (query, cursor.effective_read, Some(cursor.last.entity_id))
            }
        };
        let folder_id = query.folder.clone().ok_or(DomainError::ResourceNotFound)?;
        let mut cards = Vec::new();
        for note in fixture.notes {
            let snapshot = match self
                .0
                .get_note(
                    ctx.clone(),
                    GetNote {
                        note,
                        revision: None,
                        causal: CausalBasis::Await(Default::default()),
                    },
                )
                .await
            {
                Ok(snapshot) => snapshot,
                Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                Err(error) => return Err(error),
            };
            let Some(meta) = snapshot.provenance else {
                continue;
            };
            let document = snapshot.document.metadata();
            if snapshot.parent.as_ref() != Some(&folder_id)
                || meta.folder_page
                || document.lifecycle() != Lifecycle::Active
                || !query.classes.contains(&document.class())
            {
                continue;
            }
            cards.push((
                meta.modified_at,
                NoteListCard {
                    document: document.listing(ctx.auth())?,
                    title: meta.title,
                    path: meta.path,
                    tags: vec![],
                    view_type: None,
                },
            ));
        }
        cards.sort_by(|(time, card), (other, second)| {
            other.cmp(time).then_with(|| {
                card.document
                    .reference()
                    .note_id
                    .cmp(&second.document.reference().note_id)
            })
        });
        let start = match after {
            Some(after) => {
                1 + cards
                    .iter()
                    .position(|(_, card)| card.document.reference().note_id == after)
                    .ok_or_else(stale)?
            }
            None => 0,
        };
        let total = cards.len() as u64;
        let end = (start + usize::from(query.limit.get())).min(cards.len());
        let next = if end < cards.len() {
            let (updated, tail) = &cards[end - 1];
            self.1.directory.lock().unwrap().insert(read.clone(), query);
            Some(KeysetCursor {
                version: 1,
                scope: cut.scope.clone(),
                fingerprint: ContentDigest::from_bytes([8; 32]),
                effective_read: read,
                generation: cut.generation,
                base_cut: cut.projected_seq,
                last: SortTuple {
                    cells: vec![SortCell::Value(ScalarValue::Timestamp(*updated))],
                    entity_id: tail.document.reference().note_id.clone(),
                },
            })
        } else {
            None
        };
        Ok(FolderPage {
            folder: FolderRef {
                space_id: cut.scope.space_id.clone(),
                folder_id,
            },
            page: None,
            children: CursorPage {
                items: cards
                    .into_iter()
                    .skip(start)
                    .take(end - start)
                    .map(|(_, row)| row)
                    .collect(),
                next,
                scope: cut.scope,
                canonical_seq: cut.canonical_seq,
                projected_seq: cut.projected_seq,
                incomplete: false,
                diagnostics: vec![],
            },
            total,
        })
    }

    async fn cut(
        &self,
        ctx: &SpaceContext,
    ) -> Result<SnapshotCut, notarium_core::error::PortError> {
        let space = self.0.read_space(&ctx.scope().space_id).await?;
        ctx.check_current(&space.scope)?;
        Ok(SnapshotCut {
            scope: space.scope,
            generation: ProjectionGeneration::new(1)?,
            canonical_seq: space.last_seq,
            projected_seq: space.last_seq,
        })
    }

    async fn card(
        &self,
        ctx: &SpaceContext,
        note: NoteId,
    ) -> Result<(NoteCard, NoteSnapshot), notarium_core::error::PortError> {
        let snapshot = self
            .0
            .get_note(
                ctx.clone(),
                GetNote {
                    note,
                    revision: None,
                    causal: CausalBasis::Await(Default::default()),
                },
            )
            .await?;
        let provenance = snapshot
            .provenance
            .as_ref()
            .ok_or(DomainError::ResourceNotFound)?;
        let document = ClassEgressFence::search_metadata(snapshot.document.metadata(), ctx.auth())?;
        Ok((
            NoteCard {
                document,
                title: provenance.title.clone(),
                path: provenance.path.clone(),
                preview: String::new(),
            },
            snapshot,
        ))
    }

    async fn retrieve(
        &self,
        ctx: &SpaceContext,
        request: SearchQuery,
    ) -> Result<SearchResult, notarium_core::error::PortError> {
        let fixture = self.1.current(ctx).ok_or(DomainError::ResourceNotFound)?;
        let mut hits = Vec::new();
        if request.text == "runtime fixture" {
            for note in fixture.notes {
                let (card, snapshot) = self.card(ctx, note).await?;
                if request.folder.as_ref().is_some_and(|folder| {
                    !snapshot.document.in_project(&FolderRef {
                        space_id: ctx.scope().space_id.clone(),
                        folder_id: folder.clone(),
                    })
                }) {
                    continue;
                }
                let carrier = snapshot.document.explicit_read(ctx.auth())?.to_owned();
                let digest = snapshot.document.digest();
                let part = ContentPart::from_chunk(
                    Arc::new(snapshot.document),
                    ChunkDescriptor {
                        source: digest,
                        key: digest,
                        model: ModelProfileId::from_bytes([9; 16]),
                        context: vec![],
                        spans: vec![ByteSpan::new(0, carrier.len())?],
                        text: carrier,
                        tokens: 16,
                    },
                )?;
                hits.push(SearchHit {
                    card,
                    score: 1.0,
                    chunks: vec![ClassEgressFence::search_part(part, ctx.auth())?],
                });
                if hits.len() == usize::from(request.top_k.get()) {
                    break;
                }
            }
        }
        Ok(SearchResult {
            hits,
            chat_hits: Vec::new(),
            cut: self.cut(ctx).await?,
            degraded: None,
            truncated: false,
        })
    }
}

fn unavailable<T: 'static>() -> PortFuture<'static, T> {
    Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
}

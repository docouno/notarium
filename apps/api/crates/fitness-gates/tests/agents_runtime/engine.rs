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
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

pub struct TestEngine(pub CanonicalStore, pub Arc<ProjectionFixtures>);

#[derive(Default)]
pub struct ProjectionFixtures {
    seed: Mutex<Option<ProjectionFixture>>,
    directory: Mutex<BTreeMap<EffectiveReadId, NoteQuery>>,
    before_ability_trash: Mutex<Option<MutationPause>>,
    after_ability_publication: Mutex<Option<MutationPause>>,
    before_memory_append: Mutex<Option<MutationPause>>,
    before_chat_consume: Mutex<Option<MutationPause>>,
    chat_consume: Mutex<ChatConsumeFixture>,
    before_chat_submit: Mutex<Option<MutationPause>>,
    before_chat_claim: Mutex<Option<MutationPause>>,
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

    pub fn pause_ability_publication(
        &self,
    ) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.after_ability_publication)
    }

    pub fn pause_memory_append(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_memory_append)
    }

    pub fn pause_chat_consume(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        MutationPause::install(&self.before_chat_consume)
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
    edit_note(Mutation<EditNote>) -> Committed<NoteRevision>,
    delete_note(Mutation<DeleteNote>) -> Committed<NoteRevision>,
    mint_and_purge(Mutation<MintAndPurge>) -> Committed<MintAndPurgeResult>,
    move_note(Mutation<MoveNote>) -> Committed<NoteRevision>,
    rename_note(Mutation<RenameNote>) -> Committed<NoteRevision>,
    move_folder(Mutation<MoveFolder>) -> Committed<FolderRef>,
    rename_folder(Mutation<RenameFolder>) -> Committed<FolderRef>,
    rename_project(Mutation<RenameProject>) -> Committed<FolderRef>,
    accept_batch(AcceptBatch) -> BatchResult<NoteRevision>,
    link(Mutation<Link>) -> Committed<Link>,
    link_many(LinkBatch) -> BatchResult<Link>,
    rollback_agent_run(Mutation<RollbackAgentRun>) -> Committed<RollbackResult>,
    rollback_agent_run_by_id(Mutation<AgentRunId>) -> Committed<RollbackResult>,
    accept_external_observation(Mutation<ExternalObservation>) -> ExternalObservationResult;

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
    lookup_user_chat_input(&SubmitUserChatInput) -> Option<SubmitUserChatOutcome>,
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
    list_pending_chat_inputs(ChatThreadId) -> Vec<QueuedChatInput>,
    dismiss_chat_input(DismissPending) -> bool,
    finish_run_if_queue_empty(ChatRunRequest) -> FinishChatRunOutcome,
    recover_active_run(ChatRunRequest) -> FinishChatRunOutcome,
    redact_chat_entry(Mutation<RedactChatEntry>) -> Committed<RedactedChat>;
    fn submit_user_chat_input(&self, ctx: SpaceContext, request: SubmitUserChatInput) -> PortFuture<'_, SubmitUserChatOutcome> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_submit, ctx.budget.cancellation.clone()).await;
            ChatPort::submit_user_chat_input(&self.0, ctx, request).await
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
                return Err(PortError::Unavailable(OperationalFailure::new(
                    ContentDigest::from_bytes([0xad; 32]),
                    CommitEffect::Unknown,
                    RetryAdvice::RetrySameCommand,
                    true,
                ).unwrap()));
            }
            Ok(committed)
        })
    }
    fn claim_active_run(&self, ctx: SpaceContext, request: ClaimChatRun) -> PortFuture<'_, ClaimChatRunOutcome> {
        Box::pin(async move {
            MutationPause::enter(&self.1.before_chat_claim, ctx.budget.cancellation.clone()).await;
            ChatPort::claim_active_run(&self.0, ctx, request).await
        })
    }
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

    fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage> {
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
        Box::pin(async move { self.retrieve(&ctx, request).await })
    }

    fn recall(&self, ctx: SpaceContext, request: RecallQuery) -> PortFuture<'_, SearchResult> {
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
                if request.project.as_ref().is_some_and(|project| {
                    snapshot
                        .provenance
                        .as_ref()
                        .and_then(|value| value.project.as_ref())
                        != Some(project)
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
            cut: self.cut(ctx).await?,
            degraded: None,
            truncated: false,
        })
    }
}

fn unavailable<T: 'static>() -> PortFuture<'static, T> {
    Box::pin(async { Err(DomainError::ResourceNotFound.into()) })
}

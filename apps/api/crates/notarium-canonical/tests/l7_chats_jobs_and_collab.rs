#![forbid(unsafe_code)]

#[path = "l7_chats_jobs_and_collab/agent_turns.rs"]
mod agent_turns;
#[path = "l7_chats_jobs_and_collab/authority.rs"]
mod authority;
#[path = "l7_chats_jobs_and_collab/pg_read_cancellation.rs"]
mod pg_read_cancellation;
#[path = "l7_chats_jobs_and_collab/retirement.rs"]
mod retirement;
mod support;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{
    AppendCollabUpdate, CanonicalConfig, CanonicalRuntime, CanonicalStore, CheckpointCollabSession,
    CloseCollabSession, CollabCarrierSettlement, CollabRoomState, CreateFolderSpec,
    CreateSpaceSpec, JobCompletionOutcome, OpenCollabSession, RoomFenceTable, S3BucketModePolicy,
    blobs::{
        TerminalMarkerMeta,
        s3::{ReqwestS3Transport, S3RawRequest, S3RawResponse, S3Transport, admin_ensure_bucket},
    },
};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AgentRunId, ArtifactId, ChatThreadId, CommandKey, ContentDigest, GrantId, JobId,
        LeaseEpoch, NoteId, PendingInputId, PrincipalId, RequestId, SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, NoteRef},
    patch::CarrierEditOrigin,
    ports::{
        AppendChat, CallBudget, CancelJob, Cancellation, ChangeKind, ChangeRead, ChangeReadResult,
        ChatBody, ChatEntryKind, ChatInputBody, ChatPort, ChatRead, ChatRunRequest, ChatThreadKind,
        ClaimChatRun, ClaimChatRunOutcome, ConsumePending, ConsumedPending, ContentJobKind,
        ContentJobPort, CreateChat, CreateNote, DeleteDisposition, DeleteNote, EditNote, EntityId,
        FilenamePin, FinishChatRunOutcome, ForkChat, GetNote, InterceptedMutation,
        InterceptionResult, JobQuery, JobState, LiveCollabInterceptor, Mutation, NoteWritePort,
        PageLimit, PendingChatInput, PortFuture, Preconditions, QueueInputOutcome, RedactChatEntry,
        RollbackReservation, SpaceContext, StagedChatBlob,
    },
    query::ReadRequest,
    receipt::{CausalBasis, ChangeCursor, CommandIdentity, ReceiptSet},
    span::ByteSpan,
};
use notarium_syntax::{frontmatter, patch};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, random_bytes_16, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id, sample_run_id,
    sample_space_id,
};

fn make_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(60),
    }
}

fn owner_ctx(scope: &HistoryScope, principal: PrincipalId) -> SpaceContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([8u8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        true,
    );
    SpaceContext::new(
        EngineAuthContext::for_human(verified),
        scope.clone(),
        make_budget(),
    )
    .expect("owner SpaceContext")
}

async fn claim_run(
    store: &CanonicalStore,
    ctx: SpaceContext,
    audience: ChatAudience,
    thread: &ChatThreadId,
    run: &AgentRunId,
    leaf: ThreadEntrySeq,
) -> SpaceContext {
    let agent = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            ctx.scope().space_id.clone(),
            audience,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    let agent_ctx = SpaceContext::new(agent, ctx.scope().clone(), make_budget()).unwrap();
    assert_eq!(
        store
            .claim_active_run(
                agent_ctx.clone(),
                ClaimChatRun {
                    thread: thread.clone(),
                    run: run.clone(),
                    expected_leaf: leaf,
                    previous_run: None,
                }
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed,
    );
    agent_ctx
}

fn next_mutation<T>(scope: &HistoryScope, actor: &PrincipalId, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(random_bytes_16()),
            hash: ContentDigest::from_bytes(*blake3::hash(&random_bytes_16()).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn sample_thread_id(seed: u8) -> ChatThreadId {
    ChatThreadId::from_bytes([seed; 16])
}

struct TestCollabInterceptor {
    fences: Arc<RoomFenceTable>,
    open_race_after_reserve: AtomicBool,
    concurrent_rev_bump_after_reserve: AtomicBool,
    race_actor: PrincipalId,
    store_slot: std::sync::OnceLock<CanonicalStore>,
}

impl TestCollabInterceptor {
    fn new(fences: Arc<RoomFenceTable>, race_actor: PrincipalId) -> Self {
        Self {
            fences,
            open_race_after_reserve: AtomicBool::new(false),
            concurrent_rev_bump_after_reserve: AtomicBool::new(false),
            race_actor,
            store_slot: std::sync::OnceLock::new(),
        }
    }
}

impl LiveCollabInterceptor for TestCollabInterceptor {
    fn intercept(&self, request: InterceptedMutation) -> PortFuture<'_, InterceptionResult> {
        Box::pin(async move {
            let note = match &request.payload {
                notarium_core::ports::InterceptedPayload::EditNote { note, .. } => note.clone(),
                notarium_core::ports::InterceptedPayload::MoveBoardCard { card, .. } => {
                    card.note.clone()
                }
                notarium_core::ports::InterceptedPayload::ExternalObservation {
                    observation,
                    ..
                } => observation.note.clone(),
            };
            let scope = request.context.scope().clone();
            match self
                .fences
                .reserve_rollback(&scope, &note, request.identity.clone())
                .await?
            {
                RollbackReservation::SkippedRoomActive => Err(PortError::Domain(
                    DomainError::validation(ValidationReason::InvalidState),
                )),
                RollbackReservation::Closed(res) => {
                    if self.open_race_after_reserve.swap(false, Ordering::SeqCst) {
                        // Simulate a concurrent live collaborative room opening right AFTER
                        // ClosedRoomReservation was minted and BEFORE WriteBatchActor consumes it!
                        self.fences.open_room(&scope, &note).await?;
                    }
                    if self
                        .concurrent_rev_bump_after_reserve
                        .swap(false, Ordering::SeqCst)
                    {
                        // Simulate a concurrent head revision bump AFTER ClosedRoomReservation
                        // was minted so WriteBatchActor consumes the reservation (bumping fence epoch)
                        // and then aborts the item SAVEPOINT with RevisionConflict!
                        let st = self.store_slot.get().expect("store_slot initialized");
                        st.delete_note(
                            owner_ctx(&scope, self.race_actor.clone()),
                            next_mutation(
                                &scope,
                                &self.race_actor,
                                DeleteNote {
                                    note: note.clone(),
                                    disposition: DeleteDisposition::Trash,
                                },
                            ),
                        )
                        .await?;
                        st.delete_note(
                            owner_ctx(&scope, self.race_actor.clone()),
                            next_mutation(
                                &scope,
                                &self.race_actor,
                                DeleteNote {
                                    note: note.clone(),
                                    disposition: DeleteDisposition::Restore,
                                },
                            ),
                        )
                        .await?;
                    }
                    Ok(InterceptionResult::ClosedRoomReservation(res))
                }
            }
        })
    }

    fn reserve_rollback(
        &self,
        ctx: SpaceContext,
        note: NoteId,
        identity: CommandIdentity,
    ) -> PortFuture<'_, RollbackReservation> {
        Box::pin(async move {
            self.fences
                .reserve_rollback(ctx.scope(), &note, identity)
                .await
        })
    }

    fn filename_pin(&self, _ctx: SpaceContext, _note: NoteId) -> PortFuture<'_, FilenamePin> {
        Box::pin(async move { Ok(FilenamePin::Unpinned) })
    }
}

#[derive(Debug)]
struct QueueS3Audit {
    origin: ReqwestS3Transport,
    puts: Mutex<Vec<(blake3::Hash, String)>>,
    pause: Mutex<Option<(blake3::Hash, Arc<tokio::sync::Barrier>)>>,
    takeover: Mutex<Option<PausedQueuePut>>,
}

#[derive(Debug)]
struct PausedQueuePut {
    hash: blake3::Hash,
    uploaded: bool,
    reached: tokio::sync::oneshot::Sender<(String, Option<String>)>,
    resume: tokio::sync::oneshot::Receiver<()>,
}

impl QueueS3Audit {
    fn new(config: &notarium_canonical::S3Config) -> Self {
        Self {
            origin: ReqwestS3Transport::new(config).unwrap(),
            puts: Mutex::default(),
            pause: Mutex::default(),
            takeover: Mutex::default(),
        }
    }
}

impl S3Transport for QueueS3Audit {
    fn send<'a>(&'a self, req: S3RawRequest) -> PortFuture<'a, S3RawResponse> {
        if req.method == http::Method::PUT
            && let Some(key) = &req.key
            && key.contains("/cas-v1/")
            && !TerminalMarkerMeta::is_terminal_marker(&req.body)
        {
            let hash = blake3::hash(&req.body);
            self.puts.lock().unwrap().push((hash, key.clone()));
            let pause = self.takeover.lock().unwrap().take_if(|p| p.hash == hash);
            if let Some(pause) = pause {
                let key = key.clone();
                return Box::pin(async move {
                    if pause.uploaded {
                        let response = self.origin.send(req).await?;
                        pause.reached.send((key, response.version_id())).unwrap();
                        pause.resume.await.unwrap();
                        Ok(response)
                    } else {
                        pause.reached.send((key, None)).unwrap();
                        pause.resume.await.unwrap();
                        self.origin.send(req).await
                    }
                });
            }
            let barrier = self
                .pause
                .lock()
                .unwrap()
                .as_ref()
                .filter(|(target, _)| *target == hash)
                .map(|(_, barrier)| barrier.clone());
            if let Some(barrier) = barrier {
                return Box::pin(async move {
                    tokio::time::timeout(Duration::from_secs(10), barrier.wait())
                        .await
                        .expect("two independent S3 publication keys reached PUT");
                    self.origin.send(req).await
                });
            }
        }
        self.origin.send(req)
    }
}

enum QueuePhysical<'a> {
    Local(notarium_core::epoch::DataRoot),
    S3(&'a QueueS3Audit),
}

impl QueuePhysical<'_> {
    async fn assert_discarded(
        &self,
        store: &CanonicalStore,
        scope: &HistoryScope,
        body: &str,
        preflight: bool,
    ) {
        let prepared = store.prepare_blob(body.as_bytes()).unwrap();
        match self {
            Self::Local(root) => assert!(!root.blob(&scope.space_id, prepared.digest()).exists()),
            Self::S3(audit) => {
                let hash = blake3::hash(&prepared.s3_parts()[0].compressed);
                let keys: Vec<_> = audit
                    .puts
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(sent, _)| *sent == hash)
                    .map(|(_, key)| key.clone())
                    .collect();
                if preflight {
                    assert!(keys.is_empty(), "rejected input reached S3");
                }
                for key in keys {
                    let observed = audit
                        .origin
                        .send(S3RawRequest {
                            method: http::Method::GET,
                            key: Some(key),
                            query: Vec::new(),
                            headers: Vec::new(),
                            body: bytes::Bytes::new(),
                        })
                        .await
                        .unwrap();
                    assert_eq!(observed.status, 200);
                    assert!(TerminalMarkerMeta::is_terminal_marker(&observed.body));
                }
            }
        }
    }
}

async fn run_chat_skip_pointers_inline_cas_queue_and_redaction_suite(
    store: &CanonicalStore,
    physical: QueuePhysical<'_>,
) -> StaleCompactionCase {
    let is_sqlite = matches!(physical, QueuePhysical::Local(_));
    let scope = HistoryScope {
        space_id: sample_space_id(0x71),
        incarnation: sample_incarnation(0x71),
    };
    let owner = sample_principal_id(0x11);
    let other_user = sample_principal_id(0x22);
    let root_folder = sample_folder_id(0x01);

    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: root_folder,
            slug: "chat-suite".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create space");

    // Seed a note so chat entries can reference it before redaction.
    let ref_note = sample_note_id(0xA1);
    store
        .create_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: ref_note.clone(),
                    parent: None,
                    slug: "chat-ref".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Referenced Note\n\nBody.\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create referenced note");

    let project = sample_folder_id(0x70);
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: project.clone(),
            parent: None,
            slug: "chat-project".to_owned(),
            display_name: "Chat Project".to_owned(),
            is_project: true,
            project_slug: Some("chat-project".to_owned()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create project");

    // 1. Create Personal chat thread and test 512B vs 513B multi-byte UTF-8 inline/CAS boundary.
    let thread = sample_thread_id(0x31);
    let created = store
        .create_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: Some(project.clone()),
                    title: "Skip Pointer & Queue Suite".to_owned(),
                },
            ),
        )
        .await
        .expect("create chat")
        .value;
    assert_eq!(created.head, ThreadEntrySeq::ZERO);
    assert!(!created.tainted);

    // Exact 512 UTF-8 bytes ending with 4-byte emoji '🦀' (508 ASCII + 4B emoji = 512B) -> Inline!
    let exact_512 = format!("{}🦀", "a".repeat(508));
    assert_eq!(exact_512.len(), 512);
    let e1 = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text(exact_512.clone()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .expect("512B UTF-8 inline append")
        .value;
    assert_eq!(e1.body, ChatBody::Inline(exact_512.clone()));
    assert_eq!(e1.depth, 0);
    assert!(e1.is_chain_node);
    assert!(e1.ancestors.is_empty());

    // 513 UTF-8 bytes with `ChatInputBody::Text` must fail closed (`InvalidRange`)!
    let body_513 = format!("{}🦀b", "a".repeat(508));
    assert_eq!(body_513.len(), 513);
    let too_big_inline = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: e1.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text(body_513.clone()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await;
    assert_validation_err(&too_big_inline, ValidationReason::InvalidRange);

    // `stage_chat_blob` rejects <= 512B!
    let bad_stage = store
        .stage_chat_blob(owner_ctx(&scope, owner.clone()), &exact_512)
        .await;
    assert_validation_err(&bad_stage, ValidationReason::InvalidRange);

    // Unowned / forged `StagedChatBlob::attest_canonical` rejected!
    let unowned_staged = StagedChatBlob::attest_canonical(
        scope.space_id.clone(),
        owner.clone(),
        ContentDigest::from_bytes([0xEE; 32]),
        600,
    )
    .unwrap();
    let unowned_res = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: e1.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Staged(unowned_staged),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await;
    assert!(unowned_res.is_err(), "unowned digest must be rejected");

    // Wrong-author `StagedChatBlob` rejected (`InvalidAuthority`)!
    let wrong_owner_staged = StagedChatBlob::attest_canonical(
        scope.space_id.clone(),
        other_user.clone(),
        ContentDigest::from_bytes([0xDD; 32]),
        600,
    )
    .unwrap();
    let wrong_owner_res = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: e1.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Staged(wrong_owner_staged),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await;
    assert_validation_err(&wrong_owner_res, ValidationReason::InvalidAuthority);

    // Legitimate `stage_chat_blob` (>512B) + `append_chat` succeeds and stores `ChatBody::Blob(digest)`!
    let stage_ctx = owner_ctx(&scope, owner.clone());
    let source_request = stage_ctx.budget.request.clone();
    let staged_513 = store
        .stage_chat_blob(stage_ctx.clone(), &body_513)
        .await
        .expect("stage 513B chat blob");
    let duplicate = store
        .stage_chat_blob(stage_ctx.clone(), &body_513)
        .await
        .unwrap();
    let other_request = owner_ctx(&scope, owner.clone()).budget.request;
    let digest = staged_513.digest();
    let first = store
        .next_staged_chat_blob(stage_ctx.clone(), source_request.clone(), digest, None)
        .await
        .unwrap()
        .unwrap();
    let second = store
        .next_staged_chat_blob(
            stage_ctx.clone(),
            source_request.clone(),
            digest,
            first.lease(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    assert!([first.clone(), second.clone()].contains(&staged_513));
    assert!([first, second.clone()].contains(&duplicate));
    assert!(
        store
            .next_staged_chat_blob(
                stage_ctx.clone(),
                source_request.clone(),
                digest,
                second.lease()
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .next_staged_chat_blob(stage_ctx.clone(), other_request, digest, None)
            .await
            .unwrap()
            .is_none()
    );
    let tainted_ctx = owner_ctx(&scope, owner.clone());
    tainted_ctx.auth().taint().mark_external_read();
    assert!(
        store
            .next_staged_chat_blob(tainted_ctx, source_request.clone(), digest, None)
            .await
            .unwrap()
            .is_none()
    );
    store
        .discard_staged_chat_blob(stage_ctx.clone(), duplicate.clone())
        .await
        .unwrap();
    store
        .discard_staged_chat_blob(stage_ctx.clone(), duplicate)
        .await
        .unwrap();
    assert_eq!(
        store
            .next_staged_chat_blob(stage_ctx, source_request, digest, None)
            .await
            .unwrap(),
        Some(staged_513.clone())
    );
    let e2 = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: e1.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Staged(staged_513.clone()),
                    referenced_notes: vec![NoteRef {
                        space_id: scope.space_id.clone(),
                        note_id: ref_note.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .expect("append staged 513B chat")
        .value;
    assert_eq!(e2.body, ChatBody::Blob(staged_513.digest()));
    assert_eq!(e2.depth, 1);
    assert_eq!(e2.parent, Some(e1.seq));
    assert!(e2.ancestors.is_empty());

    // 2. Build branched DAG with skip-pointer boundary depths 15, 16, 17, 255, 256, 257 and large seq gaps!
    // Fork sibling branch B at e1 (depth 0), append 20 entries on branch B so main branch A has seq gaps.
    store
        .fork_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                ForkChat {
                    thread: thread.clone(),
                    parent: e1.seq,
                },
            ),
        )
        .await
        .expect("fork_chat to e1");

    let mut branch_b_tip = e1.seq;
    for idx in 0..20 {
        let eb = store
            .append_chat(
                owner_ctx(&scope, owner.clone()),
                next_mutation(
                    &scope,
                    &owner,
                    AppendChat {
                        tool_calls: Vec::new(),
                        provenance: None,
                        proposed_diff: None,
                        thread: thread.clone(),
                        parent: branch_b_tip,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text(format!("branch-b-{idx}")),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .expect("append branch B")
            .value;
        branch_b_tip = eb.seq;
    }

    // Now grow main branch A from e2 (depth 1) up to depth 260 (`0..=260` = 261 entries on branch A),
    // interleaving occasional branch B appends to force non-contiguous `entry_seq` gaps across skip boundaries!
    let mut chain_a = vec![e1.seq, e2.seq]; // index == depth!
    let mut cur_a = e2.seq;
    for target_depth in 2..=260usize {
        if target_depth == 16 || target_depth == 256 {
            // Inject sibling entry right before boundary depths 16 and 256 so `entry_seq` jumps!
            let eb = store
                .append_chat(
                    owner_ctx(&scope, owner.clone()),
                    next_mutation(
                        &scope,
                        &owner,
                        AppendChat {
                            tool_calls: Vec::new(),
                            provenance: None,
                            proposed_diff: None,
                            thread: thread.clone(),
                            parent: branch_b_tip,
                            kind: ChatEntryKind::Model,
                            body: ChatInputBody::Text(format!("sibling-gap-at-{target_depth}")),
                            referenced_notes: Vec::new(),
                            tainted: false,
                        },
                    ),
                )
                .await
                .expect("append sibling gap")
                .value;
            branch_b_tip = eb.seq;
        }

        let ea = store
            .append_chat(
                owner_ctx(&scope, owner.clone()),
                next_mutation(
                    &scope,
                    &owner,
                    AppendChat {
                        tool_calls: Vec::new(),
                        provenance: None,
                        proposed_diff: None,
                        thread: thread.clone(),
                        parent: cur_a,
                        kind: if target_depth % 2 == 0 {
                            ChatEntryKind::Human
                        } else {
                            ChatEntryKind::Model
                        },
                        body: ChatInputBody::Text(format!("branch-a-depth-{target_depth}")),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .expect("append branch A")
            .value;
        assert_eq!(ea.depth as usize, target_depth);
        assert!(ea.is_chain_node);

        // Verify exact skip-pointer contract (`depth - 16` and `depth - 256`) across all depths including 15, 16, 17, 255, 256, 257!
        let exp_parent = chain_a[target_depth - 1];
        assert_eq!(ea.parent, Some(exp_parent));
        let expected_ancestors = if target_depth < 16 {
            Vec::new()
        } else if target_depth < 256 {
            vec![chain_a[target_depth - 16]]
        } else {
            vec![chain_a[target_depth - 16], chain_a[target_depth - 256]]
        };
        assert_eq!(
            ea.ancestors, expected_ancestors,
            "unexpected skip pointers at depth {target_depth}"
        );

        chain_a.push(ea.seq);
        cur_a = ea.seq;
    }

    for limit in [128, 129, 200] {
        let page = store
            .read_chat(
                owner_ctx(&scope, owner.clone()),
                ChatRead {
                    thread: thread.clone(),
                    leaf: cur_a,
                    before: None,
                    max_entries: PageLimit::new(limit).unwrap(),
                },
            )
            .await
            .unwrap();
        let from = chain_a.len() - usize::from(limit);
        assert_eq!(
            page.entries
                .iter()
                .map(|entry| entry.seq)
                .collect::<Vec<_>>(),
            chain_a[from..]
        );
        assert_eq!(page.next_ancestor, Some(chain_a[from - 1]));
    }

    // Verify `read_chat` performs ZERO writes (`spaces.last_seq` and SQLite WAL unchanged)
    // while paginating multi-page windows and switching between branch A and branch B!
    let space_before_reads = store.read_space(&scope.space_id).await.unwrap();
    let wal_before = store.wal_telemetry();

    let mut reconstructed_a = Vec::new();
    let mut cursor_before = None;
    loop {
        let page = store
            .read_chat(
                owner_ctx(&scope, owner.clone()),
                ChatRead {
                    thread: thread.clone(),
                    leaf: cur_a,
                    before: cursor_before,
                    max_entries: PageLimit::new(40).unwrap(),
                },
            )
            .await
            .expect("read_chat page on branch A");
        let mut chunk: Vec<ThreadEntrySeq> = page.entries.iter().map(|e| e.seq).collect();
        chunk.extend(reconstructed_a);
        reconstructed_a = chunk;
        match page.next_ancestor {
            Some(anc) => cursor_before = Some(anc),
            None => break,
        }
    }
    assert_eq!(reconstructed_a, chain_a);

    let page_b = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: branch_b_tip,
                before: None,
                max_entries: PageLimit::new(50).unwrap(),
            },
        )
        .await
        .expect("read_chat branch B");
    assert_eq!(page_b.entries.first().unwrap().seq, e1.seq);
    assert_eq!(page_b.entries.last().unwrap().seq, branch_b_tip);
    assert!(!page_b.entries.iter().any(|e| e.seq == e2.seq));

    let project_ctx = |pin| {
        let owner = owner_ctx(&scope, owner.clone());
        let mut grants = owner.auth().spaces().clone();
        grants.get_mut(&scope.space_id).unwrap().project_root = Some(pin);
        SpaceContext::new(
            owner.auth().for_pat(grants).unwrap(),
            scope.clone(),
            make_budget(),
        )
        .unwrap()
    };
    for before in [None, Some(e1.seq)] {
        let read = ChatRead {
            thread: thread.clone(),
            leaf: branch_b_tip,
            before,
            max_entries: PageLimit::new(4).unwrap(),
        };
        let branch = store
            .read_chat(project_ctx(project.clone()), read.clone())
            .await
            .unwrap();
        assert_eq!(branch.thread.project_folder, Some(project.clone()));
        assert!(matches!(
            store
                .read_chat(project_ctx(sample_folder_id(0x76)), read)
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }

    // Passing a `before` cursor from sibling branch B while reading leaf `cur_a` MUST fail closed!
    let cross_fork_read = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: cur_a,
                before: Some(branch_b_tip),
                max_entries: PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert_validation_err(&cross_fork_read, ValidationReason::InvalidRange);

    let space_after_reads = store.read_space(&scope.space_id).await.unwrap();
    assert_eq!(
        space_before_reads.last_seq, space_after_reads.last_seq,
        "read_chat must execute zero writes"
    );
    if is_sqlite {
        let wal_after = store.wal_telemetry().unwrap();
        assert_eq!(
            wal_before.unwrap().wal_bytes,
            wal_after.wal_bytes,
            "SQLite WAL bytes must not grow during read_chat"
        );
    }

    // 3. Bounded 16-item pending input queue (`17` concurrent `queue_chat_input` -> `16` Queued + `1` Full, zero leaked CAS refs).
    let run_id = sample_run_id(0x55);
    claim_run(
        store,
        owner_ctx(&scope, owner.clone()),
        ChatAudience::Personal,
        &thread,
        &run_id,
        cur_a,
    )
    .await;
    let mut large_candidates = BTreeSet::new();
    let mut handles = Vec::new();
    for idx in 0..17u8 {
        let st = store.clone();
        let sc = scope.clone();
        let own = owner.clone();
        let th = thread.clone();
        let run = run_id.clone();
        let input_id = PendingInputId::from_bytes([0x80 + idx; 16]);
        if idx % 2 == 0 {
            large_candidates.insert(input_id.clone());
        }
        handles.push(tokio::spawn(async move {
            let body = if idx % 2 == 0 {
                // >512B body exercises CAS staging and cleanup on queue overflow!
                format!("large-pending-{idx}-{}", "x".repeat(600))
            } else {
                format!("inline-pending-{idx}")
            };
            let submitter = owner_ctx(&sc, own.clone());
            submitter.auth().taint().mark_external_read();
            st.queue_chat_input(
                submitter,
                next_mutation(
                    &sc,
                    &own,
                    PendingChatInput {
                        id: input_id,
                        thread: th,
                        sender: own.clone(),
                        body,
                        queued_base_leaf: cur_a,
                        in_flight_run: run,
                        mentions_agent: idx % 3 == 0,
                    },
                ),
            )
            .await
            .expect("queue_chat_input call")
        }));
    }

    let mut queued_ids = Vec::new();
    let mut full_count = 0usize;
    for (idx, h) in handles.into_iter().enumerate() {
        match h.await.unwrap() {
            QueueInputOutcome::Queued(c) => {
                assert!((1..=16).contains(&c.value.position));
                queued_ids.push(c.value.input);
            }
            QueueInputOutcome::Full { limit } => {
                assert_eq!(limit, 16);
                full_count += 1;
                if idx % 2 == 0 {
                    physical
                        .assert_discarded(
                            store,
                            &scope,
                            &format!("large-pending-{idx}-{}", "x".repeat(600)),
                            false,
                        )
                        .await;
                }
            }
            QueueInputOutcome::Changed => panic!("run claim changed before queue settled"),
        }
    }
    assert_eq!(queued_ids.len(), 16);
    assert_eq!(full_count, 1);

    // Verify zero leaked CAS references for the rejected 17th item: active pending blob_refs
    // must match ONLY actually inserted `'pending'` rows with `payload_blake3 IS NOT NULL`!
    let expected_pending_blobs = store
        .execute_diagnostic_read_sql_for_test(
            None,
            "SELECT COUNT(*) FROM chat_pending_inputs WHERE status = 'pending' AND payload_blake3 IS NOT NULL",
        )
        .await
        .unwrap();
    let actual_pending_refs = store
        .execute_diagnostic_read_sql_for_test(
            None,
            "SELECT COUNT(*) FROM blob_references WHERE owner_kind = 'chat_pending_input'",
        )
        .await
        .unwrap();
    assert_eq!(
        actual_pending_refs, expected_pending_blobs,
        "17th Full queue_chat_input must leak zero CAS blob_refs"
    );

    // Pick a >512B queued item to verify CAS ref transfer on consume!
    let target_pending = queued_ids
        .iter()
        .find(|id| large_candidates.contains(*id))
        .cloned()
        .expect("at least one >512B pending item queued");

    let shared_idx = (0..17u8)
        .find(|idx| PendingInputId::from_bytes([0x80 + *idx; 16]) == target_pending)
        .unwrap();
    let shared = format!("large-pending-{shared_idx}-{}", "x".repeat(600));
    let never_staged = "always-full".repeat(75);
    let fresh_input = |body: String, id| {
        next_mutation(
            &scope,
            &owner,
            PendingChatInput {
                id: PendingInputId::from_bytes([id; 16]),
                thread: thread.clone(),
                sender: owner.clone(),
                body,
                queued_base_leaf: cur_a,
                in_flight_run: run_id.clone(),
                mentions_agent: false,
            },
        )
    };
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    for request in [
        fresh_input(never_staged.clone(), 0xec),
        fresh_input("inline full".into(), 0xed),
        fresh_input(shared.clone(), 0xee),
    ] {
        for _ in 0..2 {
            assert!(matches!(
                store
                    .queue_chat_input(owner_ctx(&scope, owner.clone()), request.clone())
                    .await
                    .unwrap(),
                QueueInputOutcome::Full { limit: 16 }
            ));
        }
    }
    physical
        .assert_discarded(store, &scope, &never_staged, true)
        .await;
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        head
    );
    assert_eq!(
        store
            .read_verified_blob(
                &scope,
                store.prepare_blob(shared.as_bytes()).unwrap().digest()
            )
            .await
            .unwrap(),
        shared.as_bytes()
    );
    let denied_body = "missing-thread".repeat(80);
    let mut missing = fresh_input(denied_body.clone(), 0xef);
    missing.input.thread = sample_thread_id(0xde);
    assert!(matches!(
        store
            .queue_chat_input(owner_ctx(&scope, owner.clone()), missing)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    physical
        .assert_discarded(store, &scope, &denied_body, true)
        .await;

    // `BranchChanged` when `current_leaf != queued_base_leaf` preserves `'pending'` status!
    let branch_changed = store
        .consume_chat_input(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                ConsumePending {
                    thread: thread.clone(),
                    input: target_pending.clone(),
                    expected_run: run_id.clone(),
                    current_leaf: branch_b_tip,
                },
            ),
        )
        .await
        .expect("consume BranchChanged")
        .value;
    assert!(matches!(
        branch_changed,
        ConsumedPending::BranchChanged { queued, current }
            if queued == cur_a && current == branch_b_tip
    ));

    // `Appended` when `current_leaf == cur_a` transfers CAS ref `ChatPendingInput -> ChatEntry`!
    let consumer = owner_ctx(&scope, owner.clone());
    assert!(!consumer.auth().taint().is_tainted());
    let consumed_ok = store
        .consume_chat_input(
            consumer.clone(),
            next_mutation(
                &scope,
                &owner,
                ConsumePending {
                    thread: thread.clone(),
                    input: target_pending.clone(),
                    expected_run: run_id.clone(),
                    current_leaf: cur_a,
                },
            ),
        )
        .await
        .expect("consume Appended")
        .value;
    let appended_from_queue = match consumed_ok {
        ConsumedPending::Appended { entry, .. } => entry,
        other => panic!("expected Appended, got {other:?}"),
    };
    assert!(matches!(appended_from_queue.body, ChatBody::Blob(_)));
    assert!(appended_from_queue.tainted);
    assert!(consumer.auth().taint().is_tainted());
    let retained = store.execute_diagnostic_read_sql_for_test(None,
        "SELECT COUNT(*) FROM chat_pending_inputs WHERE status = 'consumed' AND (inline_text <> '' OR payload_blake3 IS NOT NULL)"
    ).await.unwrap();
    assert_eq!(retained, 0);
    // Both requests may pass preflight for the last slot. The enabled-bucket
    // fixture holds their data PUTs until both private publications are registered.
    let race_body = "concurrent final queue slot".repeat(40);
    let prepared = store.prepare_blob(race_body.as_bytes()).unwrap();
    if let QueuePhysical::S3(audit) = &physical {
        let hash = blake3::hash(&prepared.s3_parts()[0].compressed);
        *audit.pause.lock().unwrap() = Some((hash, Arc::new(tokio::sync::Barrier::new(2))));
    }
    let first = fresh_input(race_body.clone(), 0xf1);
    let second = fresh_input(race_body.clone(), 0xf2);
    let (left, right) = tokio::join!(
        store.queue_chat_input(owner_ctx(&scope, owner.clone()), first.clone()),
        store.queue_chat_input(owner_ctx(&scope, owner.clone()), second.clone())
    );
    let (accepted, receipt) = match (left.unwrap(), right.unwrap()) {
        (QueueInputOutcome::Queued(a), QueueInputOutcome::Full { limit: 16 }) => (first, a.receipt),
        (QueueInputOutcome::Full { limit: 16 }, QueueInputOutcome::Queued(b)) => {
            (second, b.receipt)
        }
        other => panic!("expected one queued input and one full result: {other:?}"),
    };
    let QueueInputOutcome::Queued(replayed) = store
        .queue_chat_input(owner_ctx(&scope, owner.clone()), accepted)
        .await
        .unwrap()
    else {
        panic!("expected the accepted input receipt while full")
    };
    assert_eq!(replayed.receipt, receipt);
    assert_eq!(
        store
            .read_verified_blob(&scope, prepared.digest())
            .await
            .unwrap(),
        race_body.as_bytes()
    );
    if let QueuePhysical::S3(audit) = &physical {
        *audit.pause.lock().unwrap() = None;
        let hash = blake3::hash(&prepared.s3_parts()[0].compressed);
        let keys: Vec<_> = audit
            .puts
            .lock()
            .unwrap()
            .iter()
            .filter(|(sent, _)| *sent == hash)
            .map(|(_, key)| key.clone())
            .collect();
        assert_eq!(keys.len(), 2);
        let mut markers = 0;
        for key in keys {
            let response = audit
                .origin
                .send(S3RawRequest {
                    method: http::Method::GET,
                    key: Some(key),
                    query: vec![],
                    headers: vec![],
                    body: bytes::Bytes::new(),
                })
                .await
                .unwrap();
            assert_eq!(response.status, 200);
            if TerminalMarkerMeta::is_terminal_marker(&response.body) {
                markers += 1;
            } else {
                assert_eq!(
                    response.body.as_ref(),
                    prepared.s3_parts()[0].compressed.as_ref()
                );
            }
        }
        assert_eq!(markers, 1);
    }
    cur_a = appended_from_queue.seq;

    // Second `consume_chat_input` on same item returns `AlreadyConsumed` without duplicating!
    let already = store
        .consume_chat_input(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                ConsumePending {
                    thread: thread.clone(),
                    input: target_pending,
                    expected_run: run_id.clone(),
                    current_leaf: cur_a,
                },
            ),
        )
        .await
        .expect("consume AlreadyConsumed")
        .value;
    assert!(matches!(already, ConsumedPending::AlreadyConsumed));

    let inline_pending = queued_ids
        .iter()
        .find(|id| !large_candidates.contains(*id))
        .unwrap();
    let inline_request = next_mutation(
        &scope,
        &owner,
        ConsumePending {
            thread: thread.clone(),
            input: inline_pending.clone(),
            expected_run: run_id,
            current_leaf: cur_a,
        },
    );
    let added = store
        .consume_chat_input(owner_ctx(&scope, owner.clone()), inline_request.clone())
        .await
        .unwrap();
    let ConsumedPending::Appended {
        entry: inline_entry,
        ..
    } = added.value
    else {
        panic!("expected inline entry");
    };
    assert!(matches!(inline_entry.body, ChatBody::Inline(_)));
    let replay_reader = owner_ctx(&scope, owner.clone());
    assert_eq!(
        store
            .consume_chat_input(replay_reader.clone(), inline_request)
            .await
            .unwrap()
            .receipt,
        added.receipt
    );
    assert!(replay_reader.auth().taint().is_tainted());
    cur_a = inline_entry.seq;
    let retained = store.execute_diagnostic_read_sql_for_test(None,
        "SELECT COUNT(*) FROM chat_pending_inputs WHERE status = 'consumed' AND (inline_text <> '' OR payload_blake3 IS NOT NULL)"
    ).await.unwrap();
    assert_eq!(retained, 0);

    // 4. Redaction (`redact_chat_entry`):
    // Append a Compaction entry on branch A (descendant of `e2`) AND a Compaction entry on sibling
    // branch B (NOT a descendant of `e2`, and having HIGHER `entry_seq` than `e2`!).
    let blob = store
        .stage_chat_blob(
            owner_ctx(&scope, owner.clone()),
            &"branch A compaction summary".repeat(24),
        )
        .await
        .unwrap();
    let summary = next_mutation(
        &scope,
        &owner,
        AppendChat {
            tool_calls: Vec::new(),
            provenance: None,
            proposed_diff: None,
            thread: thread.clone(),
            parent: cur_a,
            kind: ChatEntryKind::Compaction,
            body: ChatInputBody::Staged(blob.clone()),
            referenced_notes: vec![NoteRef {
                space_id: scope.space_id.clone(),
                note_id: ref_note.clone(),
            }],
            tainted: false,
        },
    );
    let appended = store
        .append_chat(owner_ctx(&scope, owner.clone()), summary.clone())
        .await
        .unwrap();
    let comp_a = appended.value;
    let child = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: comp_a.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("active child of summary".into()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value
        .seq;
    cur_a = comp_a.seq;

    let comp_b = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: branch_b_tip,
                    kind: ChatEntryKind::Compaction,
                    body: ChatInputBody::Text("branch B compaction summary".to_owned()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .expect("append compaction B (now MAX(entry_seq) in thread!)")
        .value;
    branch_b_tip = comp_b.seq;

    // Release staging lease on `staged_513` first? Wait: let's check how `stage_chat_blob` + `append_chat`
    // manages `StagedChat` vs `ChatEntry` ref_count, and redact `e2`!
    let latest_thread = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: branch_b_tip,
                before: None,
                max_entries: PageLimit::new(5).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread;

    let redact_mut = next_mutation(
        &scope,
        &owner,
        RedactChatEntry {
            thread: thread.clone(),
            entry: e2.seq,
            expected_thread_revision: latest_thread.revision.clone(),
        },
    );
    let redact_replay = redact_mut.clone();
    let redacted = store
        .redact_chat_entry(owner_ctx(&scope, owner.clone()), redact_mut)
        .await
        .expect("redact e2")
        .value;

    // `e2`'s nearest non-redacted ancestor on its own parent chain is `e1.seq` (NOT `comp_b.seq`!).
    assert_eq!(redacted.parent, Some(e1.seq));
    // ONLY descendant `comp_a.seq` is invalidated — sibling `comp_b.seq` MUST NOT be invalidated!
    assert_eq!(redacted.invalidated_contexts, vec![comp_a.seq]);

    let stale = StaleCompactionCase {
        scope: scope.clone(),
        owner: owner.clone(),
        request: summary,
        receipt: appended.receipt,
        invalidated: comp_a.seq,
        child,
        valid: comp_b.seq,
        digest: blob.digest(),
    };
    stale.check(store).await;

    // Idempotent replay with same `CommandIdentity` replays from `command_receipts`!
    let replayed_redacted = store
        .redact_chat_entry(owner_ctx(&scope, owner.clone()), redact_replay)
        .await
        .expect("idempotent replay redact_chat_entry")
        .value;
    assert_eq!(replayed_redacted.parent, Some(e1.seq));
    assert_eq!(replayed_redacted.invalidated_contexts, vec![comp_a.seq]);

    // Consecutive ancestor redaction: redact `chain_a[2]` (whose parent `e2` is already redacted!)
    // -> `RedactedChat.parent` MUST walk past redacted `e2` and return `Some(e1.seq)`!
    let thread_after_r1 = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: cur_a,
                before: None,
                max_entries: PageLimit::new(2).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread;
    let redacted_child = store
        .redact_chat_entry(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                RedactChatEntry {
                    thread: thread.clone(),
                    entry: chain_a[2],
                    expected_thread_revision: thread_after_r1.revision,
                },
            ),
        )
        .await
        .expect("redact child of redacted e2")
        .value;
    assert_eq!(
        redacted_child.parent,
        Some(e1.seq),
        "RedactedChat.parent must walk parent_seq past already-redacted e2 to e1"
    );

    // Verify `e2`'s `ChatEntry` CAS ref was released, and `read_chat` hides body & `referenced_notes`!
    let e2_entry_refs = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM blob_references WHERE owner_kind = 'chat_entry' AND owner_id = '{}:{}'",
                thread.as_str(),
                e2.seq.get()
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        e2_entry_refs, 0,
        "redacted ChatEntry CAS ref must be released"
    );

    let e2_read = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: e2.seq,
                before: None,
                max_entries: PageLimit::new(5).unwrap(),
            },
        )
        .await
        .unwrap();
    let e2_slot = e2_read.entries.iter().find(|x| x.seq == e2.seq).unwrap();
    assert_eq!(e2_slot.kind, ChatEntryKind::Redacted);
    assert_eq!(e2_slot.body, ChatBody::Redacted);
    assert!(e2_slot.referenced_notes.is_empty());

    // Verify `ChangeKind::Redact` emitted in `read_changes`!
    let space_now = store.read_space(&scope.space_id).await.unwrap();
    let recent_after = SpaceSeq::new(space_now.last_seq.get().saturating_sub(10)).unwrap();
    let ChangeReadResult::Log(ch_page) = store
        .read_changes(
            owner_ctx(&scope, owner.clone()),
            ChangeRead::Log {
                after: ChangeCursor {
                    scope: scope.clone(),
                    after: recent_after,
                },
                through: space_now.last_seq,
                limit: PageLimit::new(25).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected ChangeReadResult::Log");
    };
    assert!(
        ch_page.changes.iter().any(|c| {
            c.entity == EntityId::Thread(thread.clone()) && c.kind == ChangeKind::Redact
        }),
        "expected ChangeKind::Redact for redacted thread"
    );

    // 5. Taint latch & `SpaceGroup` taint rejection & `ChangeSeed` thread hydration:
    // Tainted append on Personal thread sets `tainted = true`, and subsequent `tainted = false` NEVER clears it!
    let tainted_append = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: cur_a,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("cross-space tainted insight".to_owned()),
                    referenced_notes: Vec::new(),
                    tainted: true,
                },
            ),
        )
        .await
        .expect("append tainted on Personal thread")
        .value;
    assert!(tainted_append.tainted);

    let untainted_followup = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: tainted_append.seq,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("followup with tainted=false".to_owned()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .expect("followup append")
        .value;
    let after_taint_branch = store
        .read_chat(
            owner_ctx(&scope, owner.clone()),
            ChatRead {
                thread: thread.clone(),
                leaf: untainted_followup.seq,
                before: None,
                max_entries: PageLimit::new(2).unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(
        after_taint_branch.thread.tainted,
        "tainted=false must never clear proven thread taint"
    );

    // `ChangeSeed` hydrates `threads` with `tainted == true`!
    let mut seeded_threads = Vec::new();
    let mut seed_cursor = None;
    loop {
        let req = match seed_cursor.take() {
            None => ChangeRead::Seed {
                scope: scope.clone(),
                cutoff: None,
                limit: PageLimit::new(10).unwrap(),
            },
            Some(c) => ChangeRead::ContinueSeed { cursor: c },
        };
        let ChangeReadResult::Seed(seed) = store
            .read_changes(owner_ctx(&scope, owner.clone()), req)
            .await
            .unwrap()
        else {
            panic!("expected ChangeReadResult::Seed");
        };
        seeded_threads.extend(seed.threads);
        if let Some(next) = seed.next {
            seed_cursor = Some(next);
        } else {
            break;
        }
    }
    assert_eq!(seeded_threads.len(), 1);
    assert_eq!(seeded_threads[0].id, thread);
    assert!(seeded_threads[0].tainted);

    // Shared Space + `SpaceGroup` thread rejects tainted entries!
    let shared_scope = HistoryScope {
        space_id: sample_space_id(0x72),
        incarnation: sample_incarnation(0x72),
    };
    store
        .create_space(CreateSpaceSpec {
            space_id: shared_scope.space_id.clone(),
            incarnation: shared_scope.incarnation,
            root_folder_id: sample_folder_id(0x02),
            slug: "shared-team".to_owned(),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let group_thread = sample_thread_id(0x32);
    store
        .create_chat(
            owner_ctx(&shared_scope, owner.clone()),
            next_mutation(
                &shared_scope,
                &owner,
                CreateChat {
                    thread: group_thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Team Channel".to_owned(),
                },
            ),
        )
        .await
        .expect("create SpaceGroup thread");
    let group_taint_res = store
        .append_chat(
            owner_ctx(&shared_scope, owner.clone()),
            next_mutation(
                &shared_scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: group_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("forbidden cross-space taint".to_owned()),
                    referenced_notes: Vec::new(),
                    tainted: true,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            group_taint_res,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
                | Err(PortError::Domain(DomainError::ValidationFailed { .. }))
        ),
        "SpaceGroup thread must block tainted append, got {group_taint_res:?}"
    );

    for (chat_scope, kind, id) in [
        (&scope, ChatThreadKind::SpaceGroup, 0x36),
        (&shared_scope, ChatThreadKind::Personal, 0x37),
    ] {
        let clean = owner_ctx(chat_scope, owner.clone());
        let redact_thread = sample_thread_id(id);
        store
            .create_chat(
                clean.clone(),
                next_mutation(
                    chat_scope,
                    &owner,
                    CreateChat {
                        thread: redact_thread.clone(),
                        kind,
                        owner: owner.clone(),
                        project_folder: None,
                        title: "Redaction authority".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let entry = store
            .append_chat(
                clean.clone(),
                next_mutation(
                    chat_scope,
                    &owner,
                    AppendChat {
                        tool_calls: Vec::new(),
                        provenance: None,
                        proposed_diff: None,
                        thread: redact_thread.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text("retained until authorized redaction".into()),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap()
            .value;
        let read = ChatRead {
            thread: redact_thread.clone(),
            leaf: entry.seq,
            before: None,
            max_entries: PageLimit::new(1).unwrap(),
        };
        let before = store.read_chat(clean.clone(), read.clone()).await.unwrap();
        let redact = next_mutation(
            chat_scope,
            &owner,
            RedactChatEntry {
                thread: redact_thread,
                entry: entry.seq,
                expected_thread_revision: before.thread.revision,
            },
        );
        let tainted = owner_ctx(chat_scope, owner.clone());
        tainted.auth().taint().mark_external_read();
        assert!(matches!(
            store
                .redact_chat_entry(tainted.clone(), redact.clone())
                .await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
        assert_eq!(
            store.read_chat(clean.clone(), read).await.unwrap().entries[0].body,
            entry.body
        );
        let committed = store
            .redact_chat_entry(clean.clone(), redact.clone())
            .await
            .unwrap();
        assert_eq!(
            store
                .redact_chat_entry(clean, redact.clone())
                .await
                .unwrap()
                .receipt,
            committed.receipt
        );
        assert!(matches!(
            store.redact_chat_entry(tainted, redact).await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
    }
    stale
}

struct StaleCompactionCase {
    scope: HistoryScope,
    owner: PrincipalId,
    request: Mutation<AppendChat>,
    receipt: notarium_core::receipt::MutationReceiptToken,
    invalidated: ThreadEntrySeq,
    child: ThreadEntrySeq,
    valid: ThreadEntrySeq,
    digest: ContentDigest,
}

impl StaleCompactionCase {
    async fn check(&self, store: &CanonicalStore) {
        let ctx = owner_ctx(&self.scope, self.owner.clone());
        let branch = |leaf, before, limit| ChatRead {
            thread: self.request.input.thread.clone(),
            leaf,
            before,
            max_entries: PageLimit::new(limit).unwrap(),
        };
        for window in [
            branch(self.invalidated, None, 1),
            branch(self.child, Some(self.invalidated), 8),
        ] {
            let page = store.read_chat(ctx.clone(), window).await.unwrap();
            let entry = page
                .entries
                .iter()
                .find(|row| row.seq == self.invalidated)
                .unwrap();
            assert_eq!(entry.kind, ChatEntryKind::Redacted);
            assert_eq!(entry.body, ChatBody::Redacted);
            assert!(entry.referenced_notes.is_empty());
        }
        assert!(
            store
                .read_verified_blob(&self.scope, self.digest)
                .await
                .is_err()
        );
        let replay = store
            .append_chat(ctx.clone(), self.request.clone())
            .await
            .unwrap();
        assert_eq!(replay.receipt, self.receipt);
        assert_eq!(replay.value.kind, ChatEntryKind::Redacted);
        assert_eq!(replay.value.body, ChatBody::Redacted);
        assert!(replay.value.referenced_notes.is_empty());
        let sibling = store
            .read_chat(ctx, branch(self.valid, None, 1))
            .await
            .unwrap();
        assert_eq!(sibling.entries[0].kind, ChatEntryKind::Compaction);
        assert_eq!(
            sibling.entries[0].body,
            ChatBody::Inline("branch B compaction summary".into())
        );
    }
}

async fn run_ten_thousand_entry_chat_dag_read_suite(store: &CanonicalStore) {
    let scope = HistoryScope {
        space_id: sample_space_id(0x73),
        incarnation: sample_incarnation(0x73),
    };
    let owner = sample_principal_id(0x13);
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: sample_folder_id(0x03),
            slug: "chat-10k".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    let thread = sample_thread_id(0x33);
    store
        .create_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "10k Branched DAG".to_owned(),
                },
            ),
        )
        .await
        .unwrap();

    // Build root entry + 64 concurrent branches of 156 entries each = 9,985 entries,
    // then append 30 more entries onto branch 0 so total entries > 10,000 (`10,015` entries)
    // and branch 0 has non-contiguous `entry_seq` gaps across the entire 10k DAG!
    let root_entry = store
        .append_chat(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("dag-root".to_owned()),
                    referenced_notes: Vec::new(),
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value;

    let mut branch_tasks = Vec::new();
    for b in 0..64usize {
        let st = store.clone();
        let sc = scope.clone();
        let own = owner.clone();
        let th = thread.clone();
        let root_seq = root_entry.seq;
        branch_tasks.push(tokio::spawn(async move {
            let mut chain = vec![root_seq];
            let mut tip = root_seq;
            for step in 0..156usize {
                let e = st
                    .append_chat(
                        owner_ctx(&sc, own.clone()),
                        next_mutation(
                            &sc,
                            &own,
                            AppendChat {
                                tool_calls: Vec::new(),
                                provenance: None,
                                proposed_diff: None,
                                thread: th.clone(),
                                parent: tip,
                                kind: if step % 2 == 0 {
                                    ChatEntryKind::Model
                                } else {
                                    ChatEntryKind::Human
                                },
                                body: ChatInputBody::Text(format!("b{b}-s{step}")),
                                referenced_notes: Vec::new(),
                                tainted: false,
                            },
                        ),
                    )
                    .await
                    .expect("concurrent 10k DAG append")
                    .value;
                tip = e.seq;
                chain.push(tip);
            }
            chain
        }));
    }

    let mut branches = Vec::with_capacity(64);
    for t in branch_tasks {
        branches.push(t.await.unwrap());
    }

    let mut target_chain = branches[0].clone();
    let mut tip = *target_chain.last().unwrap();
    for tail in 0..30usize {
        let e = store
            .append_chat(
                owner_ctx(&scope, owner.clone()),
                next_mutation(
                    &scope,
                    &owner,
                    AppendChat {
                        tool_calls: Vec::new(),
                        provenance: None,
                        proposed_diff: None,
                        thread: thread.clone(),
                        parent: tip,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text(format!("tail-{tail}")),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap()
            .value;
        tip = e.seq;
        target_chain.push(tip);
    }

    let total_entries = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM chat_entries WHERE thread_id = '{}'",
                thread.as_str()
            ),
        )
        .await
        .unwrap();
    assert!(
        total_entries >= 10_000,
        "expected >= 10,000 chat entries in DAG, got {total_entries}"
    );

    let seq_before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let slice = store
        .read_chat(
            owner_ctx(&scope, owner),
            ChatRead {
                thread,
                leaf: tip,
                before: None,
                max_entries: PageLimit::new(50).unwrap(),
            },
        )
        .await
        .expect("50-entry tail read in 10k DAG");
    let seq_after = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert_eq!(seq_before, seq_after, "10k DAG read must perform 0 writes");
    assert_eq!(slice.entries.len(), 50);
    let expected_tail: Vec<ThreadEntrySeq> = target_chain[target_chain.len() - 50..].to_vec();
    let actual_tail: Vec<ThreadEntrySeq> = slice.entries.iter().map(|e| e.seq).collect();
    assert_eq!(actual_tail, expected_tail);
    assert_eq!(
        slice.next_ancestor,
        Some(target_chain[target_chain.len() - 51])
    );
}

async fn check_reopened_room_concurrency(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    note: &NoteId,
    closed: &notarium_canonical::CollabSessionRecord,
) {
    let open = |owner_id: &str| OpenCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: owner_id.to_owned(),
        expected_carrier_rev: closed.carrier_rev_id.clone(),
        expected_lease: Some(closed.lease_epoch),
        expected_lineage: Some(closed.lineage_epoch),
        initial_yrs_snapshot: None,
        allow_fenced_recovery: false,
    };
    let budget = make_budget();
    // With the writer paused, neither deadline expiry nor dropping a pending
    // caller may reopen the persisted room or its corresponding runtime fence.
    let hold = store.acquire_writer_safe_point().await.unwrap();
    let mut short = budget.clone();
    short.remaining = Duration::from_millis(120);
    let stalled = tokio::time::timeout(
        Duration::from_secs(2),
        store.open_collab_session(&short, open("expired")),
    )
    .await
    .expect("room admission exceeded the caller budget")
    .unwrap_err();
    assert!(
        matches!(stalled, PortError::DeadlineExceeded(ref f) if f.effect() == notarium_core::error::CommitEffect::NotCommitted),
        "{stalled:?}"
    );
    let mut abandoned = Box::pin(store.open_collab_session(&budget, open("abandoned")));
    tokio::select! {
        result = &mut abandoned => panic!("unexpected room transition while paused: {result:?}"),
        () = tokio::time::sleep(Duration::from_millis(25)) => {}
    }
    drop(abandoned);
    drop(hold);
    let (a, b) = tokio::join!(
        store.open_collab_session(&budget, open("writer-a")),
        store.open_collab_session(&budget, open("writer-b")),
    );
    assert_ne!(a.is_ok(), b.is_ok(), "a single room has one writer");
    let active = a.or(b).unwrap();
    let writer = active.owner_id.unwrap();
    let append = |seq: u64| AppendCollabUpdate {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: writer.clone(),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        update_seq: seq,
        update_bytes: vec![seq as u8],
    };
    store
        .append_collab_update(&budget, append(1))
        .await
        .unwrap();
    let close = CloseCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: Some(writer.clone()),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        final_yrs_snapshot: None,
        compacted_through_update_seq: None,
        carrier_settlement: None,
    };
    let close_and_append = tokio::join!(
        store.close_collab_session(&budget, close),
        store.append_collab_update(&budget, append(2)),
    );
    let closed_again = close_and_append.0.unwrap();
    assert!(closed_again.carrier_dirty);
    let carrier = "# Collab Doc\n\nClosed settled.\n";
    let edit = patch::plan(
        carrier,
        frontmatter::analyze(carrier, DocClass::UserDoc)
            .unwrap()
            .carrier
            .body,
        vec![(
            CarrierEditOrigin::Body,
            ByteSpan::new(carrier.len(), carrier.len()).unwrap(),
            "unsettled edit".into(),
        )],
    )
    .unwrap();
    assert!(
        store
            .edit_note(
                owner_ctx(scope, owner.clone()),
                next_mutation(
                    scope,
                    owner,
                    EditNote {
                        note: note.clone(),
                        plan: edit
                    }
                )
            )
            .await
            .is_err()
    );
    let mut reopen = open("writer-c");
    reopen.expected_lease = Some(closed_again.lease_epoch);
    assert!(
        store
            .open_collab_session(
                &budget,
                OpenCollabSession {
                    initial_yrs_snapshot: Some(vec![0]),
                    ..reopen.clone()
                }
            )
            .await
            .is_err()
    );
    let active = store.open_collab_session(&budget, reopen).await.unwrap();
    let snapshot = store
        .read_collab_session(None, scope, note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.session.yrs_snapshot_blob, closed.yrs_snapshot_blob);
    assert_eq!(snapshot.updates[0].update_bytes, vec![1]);
    assert_eq!(
        snapshot.updates.len(),
        1 + usize::from(close_and_append.1.is_ok())
    );

    let checkpoint = || CheckpointCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "writer-c".into(),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        yrs_snapshot: vec![1, 2],
        compacted_through_update_seq: Some(0),
        carrier_settlement: Some(CollabCarrierSettlement {
            auth: owner_ctx(scope, owner.clone()).auth().clone(),
            carrier: "# Collab Doc\n\nClosed settled.\n".into(),
        }),
    };
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            store.checkpoint_collab_session(&budget, checkpoint()),
            store.checkpoint_collab_session(&budget, checkpoint())
        )
    })
    .await
    .expect("overlapping settlements must release the writer");
    assert!(completed.0.is_ok() || completed.1.is_ok());
    let close = CloseCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: Some("writer-c".into()),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        final_yrs_snapshot: None,
        compacted_through_update_seq: None,
        carrier_settlement: None,
    };
    let (closed, _) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            store.close_collab_session(&budget, close),
            store.checkpoint_collab_session(&budget, checkpoint())
        )
    })
    .await
    .expect("checkpoint and close must complete without a lock cycle");
    let closed = closed.unwrap();
    assert_eq!(closed.room_state, CollabRoomState::Closed);
    assert!(!closed.carrier_dirty);
}

async fn run_jobs_and_collab_lifecycle_suite(store: &CanonicalStore, sqlite: bool) {
    let scope = HistoryScope {
        space_id: sample_space_id(0x74),
        incarnation: sample_incarnation(0x74),
    };
    let owner = sample_principal_id(0x14);
    let outsider = sample_principal_id(0x24);
    store
        .create_space(CreateSpaceSpec {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            root_folder_id: sample_folder_id(0x04),
            slug: "jobs-collab".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();

    let pinned = sample_space_id(0x75);
    let owner_context = owner_ctx(&scope, owner.clone());
    let grant = owner_context.auth().spaces()[&scope.space_id].clone();
    let grants = BTreeMap::from([
        (scope.space_id.clone(), grant.clone()),
        (pinned.clone(), grant),
    ]);
    let human = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([8; 16]),
        grants.clone(),
        true,
    ));
    let branch = human
        .for_agent_run(
            sample_run_id(7),
            pinned,
            notarium_core::auth::ChatAudience::Personal,
            grants,
        )
        .unwrap();
    let scoped_agent = SpaceContext::new(branch, scope.clone(), make_budget()).unwrap();
    let chat_request = next_mutation(
        &scope,
        &owner,
        CreateChat {
            thread: sample_thread_id(0x7a),
            kind: ChatThreadKind::Personal,
            owner: owner.clone(),
            project_folder: None,
            title: "Pinned writes".into(),
        },
    );
    assert!(matches!(
        store
            .create_chat(scoped_agent.clone(), chat_request.clone())
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    let committed_chat = store
        .create_chat(owner_context, chat_request.clone())
        .await
        .unwrap();
    assert_eq!(committed_chat.value.id, chat_request.input.thread);
    assert!(matches!(
        store.create_chat(scoped_agent.clone(), chat_request).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    let outside_pin = store
        .create_job(
            scoped_agent,
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await;
    assert!(matches!(
        outside_pin,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));

    // 1. `ContentJobPort` lifecycle + worker lease steal + purge sanitization:
    let secret_note = sample_note_id(0xB1);
    store
        .create_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: secret_note.clone(),
                    parent: None,
                    slug: "export-secret".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "# Secret Export Note\n\nSensitive.\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();

    let job_export = store
        .create_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                ContentJobKind::Export {
                    notes: vec![secret_note.clone()],
                    encrypted: false,
                },
            ),
        )
        .await
        .expect("create Export job")
        .value;
    let job_backup = store
        .create_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(&scope, &owner, ContentJobKind::Backup),
        )
        .await
        .expect("create Backup job")
        .value;
    let job_reindex = store
        .create_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await
        .expect("create Reindex job")
        .value;

    // `get_job` and multi-page `list_jobs` with `KeysetCursor`:
    let fetched_export = store
        .get_job(owner_ctx(&scope, owner.clone()), job_export.id.clone())
        .await
        .expect("get_job");
    assert_eq!(fetched_export.state, JobState::Queued);

    let page1 = store
        .list_jobs(
            owner_ctx(&scope, owner.clone()),
            ReadRequest::Open {
                query: JobQuery {
                    states: vec![JobState::Queued],
                    limit: PageLimit::new(2).unwrap(),
                },
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("list_jobs page 1");
    assert_eq!(page1.items.len(), 2);
    let cursor = page1.next.expect("has next cursor");

    // Wrong principal reusing cursor fails closed with `CursorScopeMismatch`!
    let outsider_grant = SpaceGrant {
        role: SpaceRole::Editor,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let outsider_ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            outsider,
            GrantId::from_bytes([9u8; 16]),
            BTreeMap::from([(scope.space_id.clone(), outsider_grant)]),
            true,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let bad_cursor_res = store
        .list_jobs(
            outsider_ctx,
            ReadRequest::Continue {
                cursor: cursor.clone(),
            },
        )
        .await;
    assert_validation_err(&bad_cursor_res, ValidationReason::CursorScopeMismatch);

    let retained_cursor = cursor.clone();
    let page2 = store
        .list_jobs(
            owner_ctx(&scope, owner.clone()),
            ReadRequest::Continue { cursor },
        )
        .await
        .expect("list_jobs page 2");
    assert_eq!(page2.items.len(), 1);
    assert!(page2.next.is_none());
    let listed_ids: BTreeSet<JobId> = page1
        .items
        .into_iter()
        .chain(page2.items)
        .map(|j| j.id)
        .collect();
    assert_eq!(
        listed_ids,
        BTreeSet::from([
            job_export.id.clone(),
            job_backup.id.clone(),
            job_reindex.id.clone()
        ])
    );

    // Worker claims first job (`job_export`) with a short 1ms lease so we can test expired-lease steal!
    let claim1 = store
        .claim_next_job(&make_budget(), &scope, "worker-1", Duration::from_millis(1))
        .await
        .expect("claim_next_job 1")
        .expect("claimed job 1");
    assert_eq!(claim1.job.id, job_export.id);
    assert_eq!(claim1.job.state, JobState::Running);
    assert_eq!(claim1.attempts, 1);
    let stale = store
        .list_jobs(
            owner_ctx(&scope, owner.clone()),
            ReadRequest::Continue {
                cursor: retained_cursor,
            },
        )
        .await;
    assert_validation_err(&stale, ValidationReason::CursorStale);

    tokio::time::sleep(Duration::from_millis(10)).await;

    // Note: queued jobs come before expired-running or ordered by created_seq! Let's cancel `job_backup`
    // and `job_reindex` first so `job_export` (expired running) is stolen cleanly by `worker-2`!
    // First test `cancel_job` with WRONG lease fails closed:
    let bad_cancel = store
        .cancel_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CancelJob {
                    job: job_backup.id.clone(),
                    expected_lease: LeaseEpoch::new(99).unwrap(),
                },
            ),
        )
        .await;
    assert!(bad_cancel.is_err(), "cancel_job with wrong lease must fail");

    let cancelled_backup = store
        .cancel_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CancelJob {
                    job: job_backup.id.clone(),
                    expected_lease: job_backup.lease,
                },
            ),
        )
        .await
        .expect("cancel backup job")
        .value;
    assert_eq!(cancelled_backup.state, JobState::Cancelled);

    store
        .cancel_job(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CancelJob {
                    job: job_reindex.id.clone(),
                    expected_lease: job_reindex.lease,
                },
            ),
        )
        .await
        .expect("cancel reindex job");

    // Now `worker-2` steals expired `job_export` (`attempts == 2`, `lease_epoch` incremented)!
    let claim2 = store
        .claim_next_job(&make_budget(), &scope, "worker-2", Duration::from_secs(30))
        .await
        .expect("claim_next_job steal")
        .expect("stolen job");
    assert_eq!(claim2.job.id, job_export.id);
    assert_eq!(claim2.attempts, 2);
    assert!(claim2.job.lease > claim1.job.lease);

    // `heartbeat_job_lease` updates progress without advancing `spaces.last_seq`!
    let progress_cursor = store
        .list_jobs(
            owner_ctx(&scope, owner.clone()),
            ReadRequest::Open {
                query: JobQuery {
                    states: Vec::new(),
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap()
        .next
        .unwrap();
    let seq_before_hb = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let hb_job = store
        .heartbeat_job_lease(
            &make_budget(),
            &scope,
            &claim2.job.id,
            "worker-2",
            claim2.job.lease,
            Duration::from_secs(30),
            5,
            Some(10),
        )
        .await
        .expect("heartbeat_job_lease");
    let seq_after_hb = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert_eq!(
        seq_before_hb, seq_after_hb,
        "heartbeat_job_lease must not advance SpaceSeq"
    );
    assert_eq!(hb_job.completed_units, 5);
    assert_eq!(hb_job.total_units, Some(10));
    let stale = store
        .list_jobs(
            owner_ctx(&scope, owner.clone()),
            ReadRequest::Continue {
                cursor: progress_cursor,
            },
        )
        .await;
    assert_validation_err(&stale, ValidationReason::CursorStale);

    // Complete `job_export` as `Succeeded`:
    let art_id = ArtifactId::from_bytes([0xCC; 16]);
    let completed = store
        .complete_job(
            &make_budget(),
            &scope,
            &claim2.job.id,
            "worker-2",
            claim2.job.lease,
            JobCompletionOutcome::Succeeded {
                completed_units: 10,
                total_units: Some(10),
                artifacts: vec![art_id.clone()],
                result_msgpack: Some(vec![0x91, 0x01]),
            },
        )
        .await
        .expect("complete_job")
        .value;
    assert_eq!(completed.state, JobState::Succeeded);
    assert_eq!(completed.artifacts, vec![art_id]);

    // Purge `secret_note` -> `job_export` payload & `command_receipts` are sanitized so `secret_note` is gone!
    store
        .delete_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: secret_note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .expect("purge secret_note");

    let sanitized_export = store
        .get_job(owner_ctx(&scope, owner.clone()), job_export.id)
        .await
        .expect("get_job after purge");
    match sanitized_export.kind {
        ContentJobKind::Export { notes, .. } => {
            assert!(
                !notes.contains(&secret_note),
                "purged NoteId must be scrubbed from Export job payload"
            );
        }
        other => panic!("expected Export job kind, got {other:?}"),
    }

    // 2. Collaborative room persistence & `ClosedRoomReservation` fence races:
    let interceptor = Arc::new(TestCollabInterceptor::new(
        Arc::clone(store.room_fences()),
        owner.clone(),
    ));
    let _ = interceptor.store_slot.set(store.clone());
    store
        .register_collab_interceptor(Arc::clone(&interceptor) as Arc<dyn LiveCollabInterceptor>)
        .expect("register collab interceptor");

    let collab_note = sample_note_id(0xC1);
    let initial_carrier = "# Collab Doc\n\nBase line.\n".to_owned();
    let c_rev0 = store
        .create_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: collab_note.clone(),
                    parent: None,
                    slug: "collab-doc".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: initial_carrier.clone(),
                },
            ),
        )
        .await
        .unwrap()
        .value
        .revision;

    // Open collaborative session -> `room_state == Active`.
    let opened = store
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: "room-worker-1".to_owned(),
                expected_carrier_rev: c_rev0.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: Some(vec![1, 2, 3]),
                allow_fenced_recovery: false,
            },
        )
        .await
        .expect("open_collab_session");
    assert_eq!(opened.room_state, CollabRoomState::Active);

    // Direct `edit_note` while room is active MUST fail closed!
    let make_edit_plan = |base: &str, suffix: &str| {
        let hdr = frontmatter::analyze(base, DocClass::UserDoc).unwrap();
        patch::plan(
            base,
            hdr.carrier.body,
            vec![(
                CarrierEditOrigin::Body,
                ByteSpan::new(base.len(), base.len()).unwrap(),
                suffix.to_owned(),
            )],
        )
        .unwrap()
    };

    let active_edit = store
        .edit_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: collab_note.clone(),
                    plan: make_edit_plan(&initial_carrier, "blocked\n"),
                },
            ),
        )
        .await;
    assert!(
        active_edit.is_err(),
        "direct edit_note must be blocked while collab room is active"
    );

    // Append incremental Yrs updates (monotonic `update_seq`, wrong lease rejected):
    store
        .append_collab_update(
            &make_budget(),
            AppendCollabUpdate {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: "room-worker-1".to_owned(),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                update_seq: 1,
                update_bytes: vec![10, 11],
            },
        )
        .await
        .expect("append update 1");
    store
        .append_collab_update(
            &make_budget(),
            AppendCollabUpdate {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: "room-worker-1".to_owned(),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                update_seq: 2,
                update_bytes: vec![20, 21],
            },
        )
        .await
        .expect("append update 2");

    let bad_lease_upd = store
        .append_collab_update(
            &make_budget(),
            AppendCollabUpdate {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: "room-worker-1".to_owned(),
                expected_lease: LeaseEpoch::new(999).unwrap(),
                expected_lineage: opened.lineage_epoch,
                update_seq: 3,
                update_bytes: vec![30],
            },
        )
        .await;
    assert!(bad_lease_upd.is_err());

    let locked_checkpoint = CheckpointCollabSession {
        scope: scope.clone(),
        note: collab_note.clone(),
        owner_id: "room-worker-1".into(),
        expected_lease: opened.lease_epoch,
        expected_lineage: opened.lineage_epoch,
        yrs_snapshot: vec![9],
        compacted_through_update_seq: Some(1),
        carrier_settlement: Some(CollabCarrierSettlement {
            auth: owner_ctx(&scope, owner.clone()).auth().clone(),
            carrier: "# Locked settlement\n".into(),
        }),
    };
    let before = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .unwrap();
    let before_seq = store.read_space(&scope.space_id).await.unwrap().last_seq;
    for (field, reason) in [
        ("id: spoofed", ValidationReason::ProtectedField),
        ("class: user-doc", ValidationReason::ProtectedField),
        ("space_id: spoofed", ValidationReason::ProtectedField),
        ("folder_id: spoofed", ValidationReason::ProtectedField),
        ("revision_id: spoofed", ValidationReason::ProtectedField),
        ("ability_id: spoofed", ValidationReason::ProtectedField),
        ("__proto__: spoofed", ValidationReason::ForbiddenKey),
        (
            "id: spoofed\nstatus: first\nstatus: again",
            ValidationReason::FmNotWritable,
        ),
    ] {
        let settlement = CollabCarrierSettlement {
            auth: owner_ctx(&scope, owner.clone()).auth().clone(),
            carrier: format!("---\n{field}\n---\nChanged carrier\n"),
        };
        let denied = store
            .checkpoint_collab_session(
                &make_budget(),
                CheckpointCollabSession {
                    carrier_settlement: Some(settlement.clone()),
                    ..locked_checkpoint.clone()
                },
            )
            .await;
        assert_validation_err(&denied, reason);
        let denied = store
            .close_collab_session(
                &make_budget(),
                CloseCollabSession {
                    scope: scope.clone(),
                    note: collab_note.clone(),
                    owner_id: Some("room-worker-1".into()),
                    expected_lease: opened.lease_epoch,
                    expected_lineage: opened.lineage_epoch,
                    final_yrs_snapshot: Some(vec![9]),
                    compacted_through_update_seq: Some(1),
                    carrier_settlement: Some(settlement),
                },
            )
            .await;
        assert_validation_err(&denied, reason);
    }
    let unchanged = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.session, before.session);
    assert_eq!(unchanged.updates, before.updates);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before_seq
    );

    if sqlite {
        // Admission to the paused writer proves preflight completed, including deferred staging.
        let pause = store.acquire_writer_safe_point().await.unwrap();
        let mut late = locked_checkpoint.clone();
        let settlement = late.carrier_settlement.as_mut().unwrap();
        settlement.auth = owner_ctx(&scope, owner.clone()).auth().clone();
        settlement.carrier = "# Settlement revoked after staging\n".into();
        let taint = settlement.auth.taint().clone();
        let task_store = store.clone();
        let pending = tokio::spawn(async move {
            task_store
                .checkpoint_collab_session(&make_budget(), late)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !store.has_active_sqlite_writes_for_test().unwrap() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("settlement reached Phase 1");
        taint.mark_external_read();
        drop(pause);
        let denied = pending.await.unwrap();
        assert!(matches!(
            denied,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
    }
    let folder = sample_folder_id(0x04);
    store
        .set_folder_write_lock(owner_ctx(&scope, owner.clone()), folder.clone(), true)
        .await
        .unwrap();
    let denied = store
        .checkpoint_collab_session(&make_budget(), locked_checkpoint)
        .await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    store
        .set_folder_write_lock(owner_ctx(&scope, owner.clone()), folder, false)
        .await
        .unwrap();
    let persisted = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.session.carrier_rev_id, c_rev0);
    assert_eq!(persisted.updates.len(), 2);

    // Checkpoint session compacting through `update_seq = 1` + settling canonical carrier!
    let settled_carrier_1 = "# Collab Doc\n\nCheckpoint settled.\n".to_owned();
    let ckpt = store
        .checkpoint_collab_session(
            &make_budget(),
            CheckpointCollabSession {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: "room-worker-1".to_owned(),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                yrs_snapshot: vec![9, 9, 9],
                compacted_through_update_seq: Some(1),
                carrier_settlement: Some(CollabCarrierSettlement {
                    auth: owner_ctx(&scope, owner.clone()).auth().clone(),
                    carrier: settled_carrier_1.clone(),
                }),
            },
        )
        .await
        .expect("checkpoint_collab_session");
    assert_ne!(ckpt.carrier_rev_id, c_rev0);

    let snap_after_ckpt = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .expect("collab session exists");
    assert_eq!(snap_after_ckpt.updates.len(), 1);
    assert_eq!(snap_after_ckpt.updates[0].update_seq, 2);

    let newest = CheckpointCollabSession {
        scope: scope.clone(),
        note: collab_note.clone(),
        owner_id: "room-worker-1".into(),
        expected_lease: ckpt.lease_epoch,
        expected_lineage: ckpt.lineage_epoch,
        yrs_snapshot: vec![7, 7],
        compacted_through_update_seq: Some(2),
        carrier_settlement: None,
    };
    let covered = store
        .checkpoint_collab_session(&make_budget(), newest.clone())
        .await
        .unwrap();
    assert_eq!(covered.snapshot_coverage, Some((ckpt.lease_epoch, 2)));
    assert!(covered.carrier_dirty);
    for through in [Some(1), Some(2), None] {
        let stale = CheckpointCollabSession {
            yrs_snapshot: vec![9, 9, 9],
            compacted_through_update_seq: through,
            ..newest.clone()
        };
        assert!(
            store
                .checkpoint_collab_session(&make_budget(), stale)
                .await
                .is_err()
        );
    }
    let stale_close = CloseCollabSession {
        scope: scope.clone(),
        note: collab_note.clone(),
        owner_id: Some("room-worker-1".into()),
        expected_lease: ckpt.lease_epoch,
        expected_lineage: ckpt.lineage_epoch,
        final_yrs_snapshot: Some(vec![9, 9, 9]),
        compacted_through_update_seq: Some(1),
        carrier_settlement: Some(CollabCarrierSettlement {
            auth: owner_ctx(&scope, owner.clone()).auth().clone(),
            carrier: "# Stale snapshot\n".to_owned(),
        }),
    };
    assert!(
        store
            .close_collab_session(&make_budget(), stale_close)
            .await
            .is_err()
    );
    let persisted = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.session, covered);
    assert!(persisted.updates.is_empty());

    // Close collaborative session settling final carrier -> `room_state == Closed`, updates cleared!
    let settled_carrier_2 = "# Collab Doc\n\nClosed settled.\n".to_owned();
    let closed = store
        .close_collab_session(
            &make_budget(),
            CloseCollabSession {
                scope: scope.clone(),
                note: collab_note.clone(),
                owner_id: Some("room-worker-1".to_owned()),
                expected_lease: ckpt.lease_epoch,
                expected_lineage: ckpt.lineage_epoch,
                final_yrs_snapshot: Some(vec![7, 7]),
                compacted_through_update_seq: Some(2),
                carrier_settlement: Some(CollabCarrierSettlement {
                    auth: owner_ctx(&scope, owner.clone()).auth().clone(),
                    carrier: settled_carrier_2.clone(),
                }),
            },
        )
        .await
        .expect("close_collab_session");
    assert_eq!(closed.room_state, CollabRoomState::Closed);

    check_reopened_room_concurrency(store, &scope, &owner, &collab_note, &closed).await;

    // Simulate open-room race AFTER `ClosedRoomReservation` is minted -> direct edit MUST fail closed!
    interceptor
        .open_race_after_reserve
        .store(true, Ordering::SeqCst);
    let raced_edit = store
        .edit_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: collab_note.clone(),
                    plan: make_edit_plan(&settled_carrier_2, "raced-edit\n"),
                },
            ),
        )
        .await;
    assert_validation_err(&raced_edit, ValidationReason::SourceMismatch);

    // Close the in-memory fence that `open_race_after_reserve` opened so room is closed again.
    store
        .room_fences()
        .close_room(&scope, &collab_note)
        .await
        .unwrap();

    // Failed closed-room commit (wrong `preconditions.revision`) consumes the reservation and bumps
    // `RoomFenceState.epoch`, so a captured stale reservation can never be reused!
    let stale_id = CommandIdentity {
        scope: scope.clone(),
        actor: owner.clone(),
        key: CommandKey::from_bytes(random_bytes_16()),
        hash: ContentDigest::from_bytes([0x42; 32]),
    };
    let RollbackReservation::Closed(stale_res) = store
        .room_fences()
        .reserve_rollback(&scope, &collab_note, stale_id.clone())
        .await
        .unwrap()
    else {
        panic!("expected closed reservation");
    };

    let failing_edit = next_mutation(
        &scope,
        &owner,
        EditNote {
            note: collab_note.clone(),
            plan: make_edit_plan(&settled_carrier_2, "will-conflict\n"),
        },
    );
    interceptor
        .concurrent_rev_bump_after_reserve
        .store(true, Ordering::SeqCst);
    let failed_res = store
        .edit_note(owner_ctx(&scope, owner.clone()), failing_edit)
        .await;
    assert!(matches!(
        failed_res,
        Err(PortError::Domain(DomainError::RevisionConflict { .. }))
    ));

    // Trying to consume `stale_res` minted BEFORE that failed commit MUST fail with `SourceMismatch`!
    let reuse_stale = store
        .room_fences()
        .consume_reservation(&scope, &collab_note, stale_res, &stale_id)
        .await;
    assert_validation_err(&reuse_stale, ValidationReason::SourceMismatch);

    // Valid closed-room direct `edit_note` succeeds and bumps persisted `collab_sessions.lineage_epoch`!
    let direct_edit_rev = store
        .edit_note(
            owner_ctx(&scope, owner.clone()),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: collab_note.clone(),
                    plan: make_edit_plan(&settled_carrier_2, "Direct post-close edit.\n"),
                },
            ),
        )
        .await
        .expect("closed-room direct edit_note")
        .value
        .revision;

    let snap_after_direct = store
        .read_collab_session(None, &scope, &collab_note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snap_after_direct.session.carrier_rev_id, direct_edit_rev);
    assert!(
        snap_after_direct.session.lineage_epoch > closed.lineage_epoch,
        "direct closed-room write must advance collab_sessions.lineage_epoch"
    );
    let read_ctx = owner_ctx(&scope, owner);
    let snap_note = store
        .get_note(
            read_ctx.clone(),
            GetNote {
                note: collab_note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert!(
        snap_note
            .document
            .explicit_read(read_ctx.auth())
            .unwrap()
            .contains("Direct post-close edit.")
    );
    authority::check(store).await;
}

#[tokio::test]
async fn l7_sqlite_chats_jobs_collab_and_crash_fenced_recovery() {
    let temp = TempDataRoot::new("l7-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(0x70), temp.data_root());

    let staging_thread = sample_thread_id(0xd4);
    let staged_pair;
    let stale;
    {
        let (store, runtime) = CanonicalRuntime::open(config.clone())
            .await
            .expect("open SQLite canonical runtime");

        stale = run_chat_skip_pointers_inline_cas_queue_and_redaction_suite(
            &store,
            QueuePhysical::Local(temp.data_root()),
        )
        .await;
        run_ten_thousand_entry_chat_dag_read_suite(&store).await;
        run_jobs_and_collab_lifecycle_suite(&store, true).await;

        // Leave an active collaborative session open and shut down WITHOUT closing the room
        // to simulate a single-writer SQLite process restart after an unclean termination!
        let crash_scope = HistoryScope {
            space_id: sample_space_id(0x79),
            incarnation: sample_incarnation(0x79),
        };
        let owner = sample_principal_id(0x19);
        store
            .create_space(CreateSpaceSpec {
                space_id: crash_scope.space_id.clone(),
                incarnation: crash_scope.incarnation,
                root_folder_id: sample_folder_id(0x09),
                slug: "crash-fenced".to_owned(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let crash_note = sample_note_id(0xD9);
        let rev0 = store
            .create_note(
                owner_ctx(&crash_scope, owner.clone()),
                next_mutation(
                    &crash_scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: crash_note.clone(),
                        parent: None,
                        slug: "crash-doc".to_owned(),
                        class: DocClass::UserDoc,
                        carrier: "# Crash Doc\n\nInitial.\n".to_owned(),
                    },
                ),
            )
            .await
            .unwrap()
            .value
            .revision;
        store
            .open_collab_session(
                &make_budget(),
                OpenCollabSession {
                    scope: crash_scope.clone(),
                    note: crash_note,
                    owner_id: "crashed-worker".to_owned(),
                    expected_carrier_rev: rev0,
                    expected_lease: None,
                    expected_lineage: None,
                    initial_yrs_snapshot: Some(vec![42]),
                    allow_fenced_recovery: false,
                },
            )
            .await
            .unwrap();

        store
            .create_chat(
                owner_ctx(&crash_scope, owner.clone()),
                next_mutation(
                    &crash_scope,
                    &owner,
                    CreateChat {
                        thread: staging_thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: owner.clone(),
                        project_folder: None,
                        title: "Staging provenance".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let content = "same staged body".repeat(70);
        let tainted_writer = owner_ctx(&crash_scope, owner.clone());
        tainted_writer.auth().taint().mark_external_read();
        let tainted = store
            .stage_chat_blob(tainted_writer, &content)
            .await
            .unwrap();
        let clean = store
            .stage_chat_blob(owner_ctx(&crash_scope, owner.clone()), &content)
            .await
            .unwrap();
        assert_eq!(clean.digest(), tainted.digest());
        staged_pair = [(clean, false), (tainted, true)];

        runtime.shutdown().await.expect("shutdown SQLite runtime");
    }

    // Reopen SQLite runtime: `reconcile_collab_fences_on_startup` must fence the orphaned `'active'` room!
    let (store2, runtime2) = CanonicalRuntime::open(config)
        .await
        .expect("reopen SQLite canonical runtime");
    stale.check(&store2).await;
    let crash_scope = HistoryScope {
        space_id: sample_space_id(0x79),
        incarnation: sample_incarnation(0x79),
    };
    let owner = sample_principal_id(0x19);
    let crash_note = sample_note_id(0xD9);

    for (staged, expected_taint) in staged_pair {
        let reader = owner_ctx(&crash_scope, owner.clone());
        let request = next_mutation(
            &crash_scope,
            &owner,
            AppendChat {
                tool_calls: Vec::new(),
                provenance: None,
                proposed_diff: None,
                thread: staging_thread.clone(),
                parent: ThreadEntrySeq::ZERO,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Staged(staged),
                referenced_notes: Vec::new(),
                tainted: false,
            },
        );
        let result = store2
            .append_chat(reader.clone(), request.clone())
            .await
            .unwrap();
        assert_eq!(result.value.tainted, expected_taint);
        assert_eq!(reader.auth().taint().is_tainted(), expected_taint);
        let fresh = owner_ctx(&crash_scope, owner.clone());
        let replay = store2.append_chat(fresh.clone(), request).await.unwrap();
        assert_eq!(replay.receipt, result.receipt);
        assert_eq!(replay.value.tainted, expected_taint);
        assert_eq!(fresh.auth().taint().is_tainted(), expected_taint);
    }

    let fenced_snap = store2
        .read_collab_session(None, &crash_scope, &crash_note)
        .await
        .unwrap()
        .expect("fenced session exists");
    assert_eq!(fenced_snap.session.room_state, CollabRoomState::Fenced);
    assert_eq!(fenced_snap.session.owner_id, None);
    assert_eq!(fenced_snap.session.lease_epoch, LeaseEpoch::new(2).unwrap());

    // Direct `edit_note` (even WITHOUT registering a `LiveCollabInterceptor`!) MUST be blocked while `'fenced'`!
    let base = "# Crash Doc\n\nInitial.\n";
    let hdr = frontmatter::analyze(base, DocClass::UserDoc).unwrap();
    let plan = patch::plan(
        base,
        hdr.carrier.body,
        vec![(
            CarrierEditOrigin::Body,
            ByteSpan::new(base.len(), base.len()).unwrap(),
            "Unrecovered overwrite.\n".to_owned(),
        )],
    )
    .unwrap();
    let blocked_fenced_edit = store2
        .edit_note(
            owner_ctx(&crash_scope, owner.clone()),
            next_mutation(
                &crash_scope,
                &owner,
                EditNote {
                    note: crash_note.clone(),
                    plan: plan.clone(),
                },
            ),
        )
        .await;
    assert!(
        blocked_fenced_edit.is_err(),
        "direct edit must fail closed while collab session is fenced"
    );

    // Recover fenced session (`allow_fenced_recovery: true`) and close cleanly with settlement!
    let recovered = store2
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                scope: crash_scope.clone(),
                note: crash_note.clone(),
                owner_id: "recovery-worker".to_owned(),
                expected_carrier_rev: fenced_snap.session.carrier_rev_id,
                expected_lease: Some(fenced_snap.session.lease_epoch),
                expected_lineage: Some(fenced_snap.session.lineage_epoch),
                initial_yrs_snapshot: None,
                allow_fenced_recovery: true,
            },
        )
        .await
        .expect("recover fenced collab session");
    assert_eq!(recovered.room_state, CollabRoomState::Active);

    store2
        .close_collab_session(
            &make_budget(),
            CloseCollabSession {
                scope: crash_scope.clone(),
                note: crash_note.clone(),
                owner_id: Some("recovery-worker".to_owned()),
                expected_lease: recovered.lease_epoch,
                expected_lineage: recovered.lineage_epoch,
                final_yrs_snapshot: Some(vec![42, 43]),
                compacted_through_update_seq: Some(0),
                carrier_settlement: Some(CollabCarrierSettlement {
                    auth: owner_ctx(&crash_scope, owner.clone()).auth().clone(),
                    carrier: "# Crash Doc\n\nRecovered cleanly.\n".to_owned(),
                }),
            },
        )
        .await
        .expect("close recovered collab session");

    let final_ctx = owner_ctx(&crash_scope, owner);
    let final_snap = store2
        .get_note(
            final_ctx.clone(),
            GetNote {
                note: crash_note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        final_snap.document.explicit_read(final_ctx.auth()).unwrap(),
        "# Crash Doc\n\nRecovered cleanly.\n"
    );

    runtime2
        .shutdown()
        .await
        .expect("shutdown reopened SQLite runtime");
}

#[tokio::test]
async fn l7_postgres_s3_chats_jobs_and_collab_parity() {
    let fixtures = StorageTestFixtures::load_required();
    let pg_schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("l7");
    let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3_cfg, Some("Enabled"))
        .await
        .expect("provision versioned S3 bucket");

    let audit = Arc::new(QueueS3Audit::new(&s3_cfg));
    let config = fixtures.pg_s3_config(sample_installation_id(0x78), &pg_schema, s3_cfg);
    let (store, runtime) =
        CanonicalRuntime::open_with_s3_transport(config.clone(), Some(audit.clone()))
            .await
            .expect("open PG16 + MinIO CE S3 canonical runtime");

    // Opaque staging cursors must paginate identically under a linguistic
    // database collation and the bytewise collation of the default fixture.
    store
        .execute_diagnostic_write_sql_for_test(
            r#"ALTER TABLE blob_references ALTER COLUMN owner_rev_id TYPE TEXT COLLATE "en-US-x-icu""#,
        )
        .await
        .unwrap();
    let stale = run_chat_skip_pointers_inline_cas_queue_and_redaction_suite(
        &store,
        QueuePhysical::S3(&audit),
    )
    .await;
    run_ten_thousand_entry_chat_dag_read_suite(&store).await;
    run_jobs_and_collab_lifecycle_suite(&store, false).await;

    let (successor, successor_runtime) = CanonicalRuntime::open(config).await.unwrap();
    successor
        .advance_space_lease(
            &support::maintenance_ctx(notarium_core::ports::ServicePurpose::Revocation),
            &stale.scope,
            LeaseEpoch::new(2).unwrap(),
        )
        .await
        .unwrap();
    stale.check(&successor).await;
    let scope = HistoryScope {
        space_id: sample_space_id(0x74),
        incarnation: sample_incarnation(0x74),
    };
    let note = sample_note_id(0xc1);
    let session = store
        .read_collab_session(None, &scope, &note)
        .await
        .unwrap()
        .unwrap()
        .session;
    let spec = OpenCollabSession {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "previous".into(),
        expected_carrier_rev: session.carrier_rev_id,
        expected_lineage: Some(session.lineage_epoch),
        expected_lease: Some(session.lease_epoch),
        initial_yrs_snapshot: None,
        allow_fenced_recovery: false,
    };
    let active = store
        .open_collab_session(&make_budget(), spec.clone())
        .await
        .unwrap();
    let old_update = AppendCollabUpdate {
        scope: scope.clone(),
        note: note.clone(),
        owner_id: "previous".into(),
        expected_lease: active.lease_epoch,
        expected_lineage: active.lineage_epoch,
        update_seq: 1,
        update_bytes: vec![42],
    };
    store
        .append_collab_update(&make_budget(), old_update.clone())
        .await
        .unwrap();
    successor
        .advance_space_lease(
            &support::maintenance_ctx(notarium_core::ports::ServicePurpose::Revocation),
            &scope,
            LeaseEpoch::new(2).unwrap(),
        )
        .await
        .unwrap();
    let stale = store
        .append_collab_update(
            &make_budget(),
            AppendCollabUpdate {
                update_seq: 2,
                ..old_update
            },
        )
        .await;
    assert_validation_err(&stale, ValidationReason::InvalidAuthority);
    let persisted = successor
        .read_collab_session(None, &scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.session.room_state, CollabRoomState::Fenced);
    assert_eq!(persisted.updates.last().unwrap().update_bytes, vec![42]);
    successor
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                owner_id: "successor".into(),
                expected_lease: Some(persisted.session.lease_epoch),
                allow_fenced_recovery: true,
                ..spec
            },
        )
        .await
        .unwrap();
    successor_runtime.shutdown().await.unwrap();
    runtime.shutdown().await.expect("shutdown PG+S3 runtime");
    fixtures.drop_pg_schema(&pg_schema).await;
}

#[tokio::test]
async fn l7_queue_takeover_fences_delayed_s3_uploads_and_preserves_new_owner() {
    for (versioned, uploaded, enable_at_cut) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, false),
        (false, true, true),
    ] {
        exercise_interrupted_queue_upload(versioned, uploaded, enable_at_cut, false).await;
    }
}

#[tokio::test]
async fn l7_queue_cancelled_upload_retires_on_the_same_lease_while_backup_holds() {
    for (versioned, uploaded) in [(false, false), (true, true)] {
        exercise_interrupted_queue_upload(versioned, uploaded, false, true).await;
    }
}

async fn exercise_interrupted_queue_upload(
    versioned: bool,
    uploaded: bool,
    enable_at_cut: bool,
    cancel: bool,
) {
    use notarium_core::{
        ids::BackupId,
        ports::{BackupParticipantPort, ServicePurpose},
    };
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let bucket = fixtures.fresh_s3_bucket("queue-takeover");
    let s3 = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
    admin_ensure_bucket(&s3, versioned.then_some("Enabled"))
        .await
        .unwrap();
    let audit = Arc::new(QueueS3Audit::new(&s3));
    let cfg = fixtures.pg_s3_config(
        sample_installation_id(if cancel { 0xaf } else { 0xad }),
        &schema,
        s3.clone(),
    );
    let (old, rt) = CanonicalRuntime::open_with_s3_transport(cfg.clone(), Some(audit.clone()))
        .await
        .unwrap();
    let actor = sample_principal_id(0xad);
    let epoch = LeaseEpoch::new(1).unwrap();
    let scope = old
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(0xad),
            incarnation: sample_incarnation(0xad),
            root_folder_id: sample_folder_id(0xad),
            slug: "queued".into(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: epoch,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let thread = sample_thread_id(0xad);
    old.create_chat(
        owner_ctx(&scope, actor.clone()),
        next_mutation(
            &scope,
            &actor,
            CreateChat {
                thread: thread.clone(),
                kind: ChatThreadKind::Personal,
                owner: actor.clone(),
                project_folder: None,
                title: "Queue".into(),
            },
        ),
    )
    .await
    .unwrap();
    let old_run = sample_run_id(0xad);
    let new_run = sample_run_id(0xae);
    claim_run(
        &old,
        owner_ctx(&scope, actor.clone()),
        ChatAudience::Personal,
        &thread,
        &old_run,
        ThreadEntrySeq::ZERO,
    )
    .await;
    let body = "payload spanning queue takeover".repeat(24);
    let prepared = old.prepare_blob(body.as_bytes()).unwrap();
    let (reached, until_put) = tokio::sync::oneshot::channel();
    let (release, resume) = tokio::sync::oneshot::channel();
    *audit.takeover.lock().unwrap() = Some(PausedQueuePut {
        hash: blake3::hash(&prepared.s3_parts()[0].compressed),
        uploaded,
        reached,
        resume,
    });
    let input = |id| {
        next_mutation(
            &scope,
            &actor,
            PendingChatInput {
                id: PendingInputId::from_bytes([id; 16]),
                thread: thread.clone(),
                sender: actor.clone(),
                body: body.clone(),
                queued_base_leaf: ThreadEntrySeq::ZERO,
                in_flight_run: if id == 0xe1 || cancel {
                    old_run.clone()
                } else {
                    new_run.clone()
                },
                mentions_agent: false,
            },
        )
    };
    let backup_hold = if cancel {
        let mut backup = old
            .prepare(
                support::maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x62; 16]),
                old.default_backup_budget(),
            )
            .await
            .unwrap();
        let hold = backup.acquire_hold().await.unwrap();
        Some((backup, hold))
    } else {
        None
    };
    let lease_owner = old.clone();
    let old_ctx = owner_ctx(&scope, actor.clone());
    let cancellation = old_ctx.budget.cancellation.clone();
    let old_req = input(0xe1);
    let old_task = tokio::spawn(async move { old.queue_chat_input(old_ctx, old_req).await });
    let (key, version_id) = tokio::time::timeout(Duration::from_secs(10), until_put)
        .await
        .unwrap()
        .unwrap();
    if enable_at_cut {
        notarium_canonical::blobs::s3::admin_set_bucket_versioning(&s3, "Enabled")
            .await
            .unwrap();
    }
    let (current, current_rt) = if cancel {
        (lease_owner, None)
    } else {
        let (current, rt) = CanonicalRuntime::open_with_s3_transport(cfg, Some(audit.clone()))
            .await
            .unwrap();
        current
            .advance_space_lease(
                &support::maintenance_ctx(ServicePurpose::Revocation),
                &scope,
                epoch.checked_next().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            current
                .recover_active_run(
                    owner_ctx(&scope, actor.clone()),
                    ChatRunRequest {
                        thread: thread.clone(),
                        expected_run: old_run.clone(),
                    }
                )
                .await
                .unwrap(),
            FinishChatRunOutcome::Cleared,
        );
        claim_run(
            &current,
            owner_ctx(&scope, actor.clone()),
            ChatAudience::Personal,
            &thread,
            &new_run,
            ThreadEntrySeq::ZERO,
        )
        .await;
        (current, Some(rt))
    };
    let accepted = current
        .queue_chat_input(owner_ctx(&scope, actor.clone()), input(0xe2))
        .await
        .unwrap();
    assert!(matches!(accepted, QueueInputOutcome::Queued(_)));
    if cancel {
        if uploaded {
            old_task.abort();
            assert!(old_task.await.unwrap_err().is_cancelled());
        } else {
            cancellation.cancel();
            let result = tokio::time::timeout(Duration::from_secs(5), old_task)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(result, Err(PortError::Cancelled(_))));
        }
        assert!(release.send(()).is_err());
        // Observe completion on the original lease and with the original hold still active.
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let pending = current
                    .execute_diagnostic_read_sql_for_test(
                        None,
                        "SELECT COUNT(*) FROM blob_retirements WHERE status='pending'",
                    )
                    .await
                    .unwrap();
                if pending == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await
        .unwrap();
        let (backup, hold) = backup_hold.unwrap();
        hold.release().await.unwrap();
        drop(backup);
        let mut next = current
            .prepare(
                support::maintenance_ctx(ServicePurpose::Backup),
                BackupId::from_bytes([0x63; 16]),
                current.default_backup_budget(),
            )
            .await
            .unwrap();
        next.acquire_hold().await.unwrap().release().await.unwrap();
        assert_eq!(
            current
                .read_space(&scope.space_id)
                .await
                .unwrap()
                .active_epoch,
            epoch
        );
    } else {
        release.send(()).unwrap();
        assert!(old_task.await.unwrap().is_err());
    }
    let get = |version: Option<String>| S3RawRequest {
        method: http::Method::GET,
        key: Some(key.clone()),
        query: version
            .into_iter()
            .map(|v| ("versionId".into(), v))
            .collect(),
        headers: vec![],
        body: bytes::Bytes::new(),
    };
    let marker = audit.origin.send(get(None)).await.unwrap();
    assert_eq!(marker.status, 200);
    assert!(TerminalMarkerMeta::is_terminal_marker(&marker.body));
    if uploaded && (versioned || enable_at_cut) {
        let old_version = if enable_at_cut {
            "null".to_owned()
        } else {
            version_id.unwrap()
        };
        assert_eq!(
            audit
                .origin
                .send(get(Some(old_version)))
                .await
                .unwrap()
                .status,
            404
        );
    }
    assert_eq!(
        current
            .read_verified_blob(&scope, prepared.digest())
            .await
            .unwrap(),
        body.as_bytes()
    );
    assert_eq!(
        current
            .execute_diagnostic_read_sql_for_test(
                None,
                "SELECT COUNT(*) FROM blob_references WHERE owner_kind='chat_pending_input'"
            )
            .await
            .unwrap(),
        1
    );
    if let Some(current_rt) = current_rt {
        current_rt.shutdown().await.unwrap();
    }
    rt.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn chat_receipts_preserve_body_and_reference_boundaries() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    for postgres in [false, true] {
        let root = TempDataRoot::new("chat-reference-identity");
        let installation = sample_installation_id(0x64);
        let cfg = if postgres {
            fixtures.pg_local_config(installation, &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(installation, root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let scope = HistoryScope {
            space_id: sample_space_id(0x64),
            incarnation: sample_incarnation(0x64),
        };
        let owner = sample_principal_id(0x64);
        store
            .create_space(CreateSpaceSpec {
                space_id: scope.space_id.clone(),
                incarnation: scope.incarnation,
                root_folder_id: sample_folder_id(0x64),
                slug: "receipts".into(),
                kind: SpaceKind::Personal,
                owner: owner.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let ctx = owner_ctx(&scope, owner.clone());
        let note = sample_note_id(0x64);
        store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note.clone(),
                        parent: None,
                        slug: "report".into(),
                        class: DocClass::UserDoc,
                        carrier: "Report.\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let thread = sample_thread_id(0x64);
        store
            .create_chat(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateChat {
                        thread: thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: owner.clone(),
                        project_folder: None,
                        title: "Notes".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let request = next_mutation(
            &scope,
            &owner,
            AppendChat {
                tool_calls: Vec::new(),
                provenance: None,
                proposed_diff: None,
                thread: thread.clone(),
                parent: ThreadEntrySeq::ZERO,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text("Report: ".into()),
                referenced_notes: vec![NoteRef {
                    space_id: scope.space_id.clone(),
                    note_id: note.clone(),
                }],
                tainted: false,
            },
        );
        let appended = store
            .append_chat(ctx.clone(), request.clone())
            .await
            .unwrap();
        let mut inline = request.clone();
        inline.input.referenced_notes.clear();
        inline.input.body = ChatInputBody::Text(format!(
            "Report: {}{}",
            scope.space_id.as_str(),
            note.as_str()
        ));
        for previous in [false, true] {
            if previous {
                let mut payload = blake3::Hasher::new();
                payload.update(thread.as_str().as_bytes());
                payload.update(&[0]);
                payload.update(&0u64.to_be_bytes());
                payload.update(b"\0human\0\x01Report: ");
                payload.update(scope.space_id.as_str().as_bytes());
                payload.update(note.as_str().as_bytes());
                payload.update(&[0]);
                let mut command = blake3::Hasher::new();
                command.update(b"notarium-cmd-v1:append_chat\0");
                command.update(request.identity.hash.as_bytes());
                command.update(&[0]);
                command.update(payload.finalize().as_bytes());
                let hex = command.finalize().to_hex();
                let literal = if postgres {
                    format!("decode('{hex}', 'hex')")
                } else {
                    format!("X'{hex}'")
                };
                assert_eq!(store.execute_diagnostic_write_sql_for_test(&format!(
                    "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND idempotency_key='{}'",
                    scope.space_id.as_str(), request.identity.key.as_str())).await.unwrap(),1);
            }
            assert!(matches!(
                store.append_chat(ctx.clone(), inline.clone()).await,
                Err(PortError::Domain(DomainError::IdempotencyKeyReused))
            ));
            let exact = store
                .append_chat(ctx.clone(), request.clone())
                .await
                .unwrap();
            assert_eq!(exact.receipt, appended.receipt);
            assert_eq!(exact.value.referenced_notes, request.input.referenced_notes);
            assert_eq!(
                store.read_space(&scope.space_id).await.unwrap().last_seq,
                appended.receipt.seq()
            );
        }
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}

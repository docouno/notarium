use super::*;
use crate::{runtime::SpaceRecord, writer::CommandIdentitySpec};

const COMMAND: &str = "submit_user_chat_input";

#[derive(Clone, Copy)]
pub(super) enum UserInputReceipt {
    Standalone,
    Submission,
}

#[derive(Serialize, Deserialize)]
pub(super) enum StoredUserChatSubmissionV1 {
    Appended(StoredCommittedChatEntryV1),
    Queued(StoredQueuedChatMetadataV1),
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredQueuedChatMetadataV1 {
    pub(super) id: PendingInputId,
    pub(super) sender: PrincipalId,
    pub(super) queued_base_leaf: ThreadEntrySeq,
    pub(super) in_flight_run: AgentRunId,
    pub(super) mentions_agent: bool,
}

impl StoredUserChatSubmissionV1 {
    fn into_outcome(self, auth: &EngineAuthContext) -> SubmitUserChatOutcome {
        match self {
            Self::Appended(entry) => {
                if entry.value.tainted {
                    auth.taint().mark_external_read();
                }
                SubmitUserChatOutcome::Appended(entry.into_committed())
            }
            Self::Queued(input) => SubmitUserChatOutcome::Queued(QueuedChatInput {
                id: input.id,
                sender: input.sender,
                queued_base_leaf: input.queued_base_leaf,
                in_flight_run: input.in_flight_run,
                mentions_agent: input.mentions_agent,
            }),
        }
    }
}

pub(super) fn identity(
    ctx: &SpaceContext,
    request: &SubmitUserChatInput,
) -> Result<CommandIdentitySpec, PortError> {
    validate_mutation_identity(ctx, &request.identity)?;
    forbid_keeper_chat_mutation(ctx.auth())?;
    if ctx.auth().kind() != &PrincipalKind::DirectHuman {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if request.body.len() > content::MAX_TURN_BYTES || request.body.contains('\0') {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    // The transaction chooses the route. Its observed run and physical upload
    // lease cannot change the fingerprint of a retry.
    let mut fingerprint = blake3::Hasher::new();
    fingerprint.update(request.thread.as_str().as_bytes());
    fingerprint.update(&[0]);
    fingerprint.update(request.id.as_str().as_bytes());
    fingerprint.update(&[0]);
    fingerprint.update(&request.expected_leaf.get().to_be_bytes());
    fingerprint.update(&[u8::from(request.mentions_agent)]);
    fingerprint.update(request.body.as_bytes());
    Ok(derive_command_identity_spec(
        ctx,
        &request.identity,
        COMMAND,
        fingerprint.finalize().as_bytes(),
    )
    .for_chat_leaf(ctx.auth(), &request.thread, request.expected_leaf))
}

pub(super) async fn lookup(
    store: &CanonicalStore,
    ctx: SpaceContext,
    idemp: CommandIdentitySpec,
) -> Result<Option<SubmitUserChatOutcome>, PortError> {
    let deadline = CommandDeadline::start(&ctx.budget, "lookup_user_chat_input");
    let value = deadline
        .prepare_read(&ctx.budget, || {
            try_replay_completed_receipt::<StoredUserChatSubmissionV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await?;
    Ok(value.map(|stored| stored.into_outcome(ctx.auth())))
}

pub(super) async fn submit(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: SubmitUserChatInput,
) -> Result<SubmitUserChatOutcome, PortError> {
    let deadline = CommandDeadline::start(&ctx.budget, COMMAND);
    let idemp = identity(&ctx, &request)?;
    let (space, receipt) = deadline
        .prepare_read(&ctx.budget, || {
            read_space_and_receipt::<StoredUserChatSubmissionV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await?;
    if let Some(receipt) = receipt {
        return Ok(receipt.into_outcome(ctx.auth()));
    }
    content::require_human_text(&request.body)?;
    authorize_chat_write_on_space(ctx.auth(), &space.space)?;
    let staged = if request.body.len() as u64 > ChatInputBody::INLINE_MAX_BYTES {
        // An unauthorized, stale, or full-queue request must not publish even a
        // provisional CAS blob; `submit_tx` re-verifies atomically under writer locks.
        let reader = ctx.auth().clone();
        let thread = request.thread.clone();
        let leaf = request.expected_leaf;
        let input_id = request.id.clone();
        let scope = space.scope.clone();
        let store_check = store.clone();
        let precheck = deadline
            .prepare(&ctx.budget, || {
                store.with_read_tx_budget(Some(&ctx.budget), move |tx| {
                    Box::pin(async move {
                        let live = load_space_record(tx, &scope.space_id).await?;
                        live.scope.check(&scope)?;
                        let head =
                            authorize_input_thread_tx(tx, &live, &reader, &thread, leaf).await?;
                        if head.head_leaf_seq != leaf {
                            return Ok(Some(SubmitUserChatOutcome::Changed));
                        }
                        if let Some(run) = &head.active_run_id {
                            if queue::authorize_run_claim(&store_check, &live, &head, run).is_err()
                            {
                                return Ok(Some(SubmitUserChatOutcome::Changed));
                            }
                            let count =
                                queue_admission_count_tx(tx, &scope.space_id, &thread, &input_id)
                                    .await?;
                            if count >= i64::from(PENDING_CHAT_QUEUE_LIMIT) {
                                return Ok(Some(SubmitUserChatOutcome::Full {
                                    limit: PENDING_CHAT_QUEUE_LIMIT,
                                }));
                            }
                        }
                        Ok(None)
                    })
                })
            })
            .await;
        // A concurrent retry with the same command key can commit between the
        // initial receipt check and this admission read. Resolve any completed
        // receipt before returning Changed, Full, or DuplicateKey.
        let check_replay = matches!(&precheck, Ok(Some(_)))
            || matches!(
                &precheck,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::DuplicateKey
            );
        if check_replay
            && let Some(replayed) = deadline
                .prepare(&ctx.budget, || {
                    try_replay_completed_receipt::<StoredUserChatSubmissionV1>(
                        store,
                        &space.scope,
                        &idemp,
                        Some(&ctx.budget),
                    )
                })
                .await?
        {
            return Ok(replayed.into_outcome(ctx.auth()));
        }
        if let Some(outcome) = precheck? {
            return Ok(outcome);
        }
        let prepared = PreparedBlobSource::prepare(request.body.as_bytes(), store.blob_codec())?;
        Some(
            deadline
                .prepare(&ctx.budget, || {
                    store.stage_blob_for_batch(&space.scope, space.active_epoch, &prepared)
                })
                .await?,
        )
    } else {
        None
    };

    let discard = staged.as_ref().and_then(StagedBlobTicket::discard);
    let owned = store.clone();
    let auth = ctx.auth().clone();
    let intent = PreparedWriteIntent {
        scope: space.scope,
        active_epoch: space.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: staged.as_ref().map_or(0, |ticket| ticket.compressed_size),
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move { submit_tx(&owned, tx, item_ctx, auth, request, staged).await })
        }),
    };
    let result = deadline
        .submit::<StoredUserChatSubmissionV1>(store, &ctx.budget, intent)
        .await;
    settle_queue_upload(deadline, &ctx.budget, discard, &result).await?;
    match result {
        Ok(stored) => Ok(stored.into_outcome(ctx.auth())),
        Err(PortError::Domain(DomainError::RevisionConflict { .. })) => {
            Ok(SubmitUserChatOutcome::Changed)
        }
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::InvalidLimit =>
        {
            Ok(SubmitUserChatOutcome::Full {
                limit: PENDING_CHAT_QUEUE_LIMIT,
            })
        }
        Err(other) => Err(other),
    }
}

async fn authorize_input_thread_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    auth: &EngineAuthContext,
    thread: &ChatThreadId,
    leaf: ThreadEntrySeq,
) -> Result<ThreadHeadRow, PortError> {
    authorize_chat_write_on_space(auth, &space.space)?;
    forbid_project_agent_run(auth, &space.space)?;
    let head = load_thread_head_tx(tx, &space.scope.space_id, thread).await?;
    authorize_thread_mutation(auth, &space.space, &head, false)?;
    if head.kind == ChatThreadKind::KeeperLog {
        return Err(DomainError::SpaceReadOnly.into());
    }
    let tainted = read_leaf_taint(tx, &space.scope.space_id, thread, leaf).await?;
    authorize_thread_mutation(auth, &space.space, &head, tainted)?;
    Ok(head)
}

async fn submit_tx(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    item_ctx: &mut ItemExecCtx,
    auth: EngineAuthContext,
    request: SubmitUserChatInput,
    staged: Option<StagedBlobTicket>,
) -> Result<ItemCommitArtifacts, PortError> {
    let scope = &item_ctx.scope;
    let space = load_space_record(tx, &scope.space_id).await?;
    let head = authorize_input_thread_tx(tx, &space, &auth, &request.thread, request.expected_leaf)
        .await?;
    let changed = || DomainError::RevisionConflict {
        current: head.head_rev_id.clone(),
        lineage: None,
    };
    if head.head_leaf_seq != request.expected_leaf {
        return Err(changed().into());
    }
    if let Some(run) = &head.active_run_id {
        queue::authorize_run_claim(store, &space, &head, run).map_err(|_| changed())?;
        let count =
            queue_admission_count_tx(tx, &scope.space_id, &request.thread, &request.id).await?;
        if count >= i64::from(PENDING_CHAT_QUEUE_LIMIT) {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let input = PendingChatInput {
            id: request.id,
            thread: request.thread,
            sender: auth.principal().clone(),
            body: request.body,
            queued_base_leaf: request.expected_leaf,
            in_flight_run: run.clone(),
            mentions_agent: request.mentions_agent,
        };
        return enqueue_chat_tx(
            tx,
            item_ctx,
            input,
            auth.taint().is_tainted(),
            count,
            staged,
            UserInputReceipt::Submission,
        )
        .await;
    }

    append_chat_tx(
        store,
        tx,
        item_ctx,
        AppendChatWrite {
            auth,
            preconditions: Preconditions::default(),
            input: AppendChat {
                thread: request.thread,
                parent: request.expected_leaf,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text(request.body),
                tool_calls: Vec::new(),
                provenance: None,
                interruption: None,
                proposed_diff: None,
                proposed_effect: None,
                referenced_notes: Vec::new(),
                tainted: false,
            },
            format: content::BodyFormat::Plain,
            provenance_json: None,
            staged,
            receipt_kind: UserInputReceipt::Submission,
        },
    )
    .await
}

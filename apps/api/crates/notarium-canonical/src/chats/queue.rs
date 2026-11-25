use notarium_core::auth::SpaceRole;

use super::*;
use crate::runtime::{SpaceRecord, load_space_record_for_update_opt};

type PendingRow = (String, String, i64, String, i32);

fn use_current_claim(thread: &ThreadHeadRow, store: &CanonicalStore, space: &SpaceRecord) -> bool {
    thread.active_run_epoch == Some(space.active_epoch)
        && thread.active_run_generation.as_deref() == Some(&store.inner.chat_run_generation)
}

pub(super) fn authorize_run_claim(
    store: &CanonicalStore,
    space: &SpaceRecord,
    thread: &ThreadHeadRow,
    run: &AgentRunId,
) -> Result<(), PortError> {
    if thread.active_run_id.as_ref() != Some(run) || !use_current_claim(thread, store, space) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(())
}

async fn authorize_current_leaf(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    thread: &ThreadHeadRow,
) -> Result<(), PortError> {
    let tainted = read_leaf_taint(
        tx,
        &space.scope.space_id,
        &thread.thread_id,
        thread.head_leaf_seq,
    )
    .await?;
    authorize_thread_mutation(auth, &space.space, thread, tainted)
}

async fn authorize_claim_lifecycle_leaf(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    thread: &ThreadHeadRow,
) -> Result<(), PortError> {
    let tainted = read_leaf_taint(
        tx,
        &space.scope.space_id,
        &thread.thread_id,
        thread.head_leaf_seq,
    )
    .await?;
    authorize_thread_claim_lifecycle(auth, &space.space, thread, tainted)
}

async fn lock_space(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
) -> Result<SpaceRecord, PortError> {
    // The batch writer takes the same lock before enqueue, consume and append.
    let space = load_space_record_for_update_opt(tx, &ctx.scope().space_id)
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    space.scope.check(ctx.scope())?;
    store
        .inner
        .check_writer_epoch(&space.scope.space_id, space.active_epoch)?;
    Ok(space)
}

async fn set_active(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    thread: &ChatThreadId,
    run: Option<&AgentRunId>,
    generation: &str,
) -> Result<(), PortError> {
    const UPDATE: &str = "UPDATE chat_threads
        SET active_run_id = $3, active_run_epoch = $4, active_run_generation = $5
        WHERE space_id = $1 AND thread_id = $2";
    let run_id = run.map(AgentRunId::as_str);
    let epoch = run.map(|_| space.active_epoch.get() as i64);
    let generation = run.map(|_| generation);
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(UPDATE)
            .bind(space.scope.space_id.as_str())
            .bind(thread.as_str())
            .bind(run_id)
            .bind(epoch)
            .bind(generation)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(UPDATE)
            .bind(space.scope.space_id.as_str())
            .bind(thread.as_str())
            .bind(run_id)
            .bind(epoch)
            .bind(generation)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_run_cas", error))
}

pub(super) async fn claim(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ClaimChatRun,
) -> Result<ClaimChatRunOutcome, PortError> {
    if ctx.confirmed_chat_step().is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    forbid_keeper_chat_mutation(ctx.auth())?;
    if ctx.auth().kind() != &PrincipalKind::AgentRun(request.run.clone()) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "claim_chat_run");
    let budget = ctx.budget.clone();
    let owned = store.clone();
    let effect = ctx.canonical_effect().cloned();
    store
        .with_guarded_auxiliary_command(
            ctx.scope().space_id.clone(),
            None,
            Some((&budget, deadline)),
            effect,
            Ok,
            move |tx, effect| {
                Box::pin(async move {
                    let space = lock_space(&owned, tx, &ctx).await?;
                    effect.begin().await?;
                    authorize_chat_write_on_space(ctx.auth(), &space.space)?;
                    let thread =
                        load_thread_head_tx(tx, &space.scope.space_id, &request.thread).await?;
                    authorize_thread_mutation(ctx.auth(), &space.space, &thread, false)?;
                    let current = thread.active_run_id.as_ref();
                    let valid_owner = use_current_claim(&thread, &owned, &space);
                    if current == Some(&request.run) && valid_owner {
                        authorize_current_leaf(tx, ctx.auth(), &space, &thread).await?;
                        return Ok(ClaimChatRunOutcome::Claimed);
                    }
                    if let Some(current) = current
                        && (Some(current) != request.previous_run.as_ref() || !valid_owner)
                    {
                        return Ok(ClaimChatRunOutcome::Busy(current.clone()));
                    }
                    if current != request.previous_run.as_ref()
                        || thread.head_leaf_seq != request.expected_leaf
                    {
                        return Ok(ClaimChatRunOutcome::Changed);
                    }
                    authorize_current_leaf(tx, ctx.auth(), &space, &thread).await?;
                    if request.previous_run.is_some() {
                        let author = ctx.auth().principal();
                        let Some((base, mentions)) =
                            queued_human_leaf(tx, &space, &request, author).await?
                        else {
                            return Ok(ClaimChatRunOutcome::Changed);
                        };
                        if thread.kind == ChatThreadKind::SpaceGroup
                            && (mentions == 0
                                || other_human_on_branch(
                                    tx,
                                    &space.scope.space_id,
                                    &request.thread,
                                    request.expected_leaf,
                                    seq_from_db(base)?,
                                    author.as_str(),
                                )
                                .await?)
                        {
                            return Ok(ClaimChatRunOutcome::Changed);
                        }
                    }
                    set_active(
                        tx,
                        &space,
                        &request.thread,
                        Some(&request.run),
                        &owned.inner.chat_run_generation,
                    )
                    .await?;
                    Ok(ClaimChatRunOutcome::Claimed)
                })
            },
        )
        .await
        .map_err(|error| crate::codec::retry_unknown_commit("claim_chat_run", error))
}

async fn queued_human_leaf(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    request: &ClaimChatRun,
    author: &PrincipalId,
) -> Result<Option<(i64, i32)>, PortError> {
    let run = request
        .previous_run
        .as_ref()
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidAuthority))?;
    const SELECT: &str = "SELECT p.queued_base_leaf_seq, CAST(p.mentions_agent AS INTEGER)
        FROM chat_pending_inputs p JOIN chat_entries e
           ON p.space_id = e.space_id AND p.thread_id = e.thread_id AND p.consumed_entry_seq = e.entry_seq
        WHERE e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = $3
          AND e.author_id = $4 AND e.agent_run_id = $5
          AND e.kind = 'human' AND p.status = 'consumed'";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SELECT)
                .bind(space.scope.space_id.as_str())
                .bind(request.thread.as_str())
                .bind(request.expected_leaf.get() as i64)
                .bind(author.as_str())
                .bind(run.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SELECT)
                .bind(space.scope.space_id.as_str())
                .bind(request.thread.as_str())
                .bind(request.expected_leaf.get() as i64)
                .bind(author.as_str())
                .bind(run.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_queue_handoff", error))
}

pub(super) async fn finish(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRunRequest,
    recover: bool,
) -> Result<FinishChatRunOutcome, PortError> {
    if ctx.confirmed_chat_step().is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    forbid_keeper_chat_mutation(ctx.auth())?;
    let authenticated = if recover {
        ctx.auth().kind() == &PrincipalKind::DirectHuman
    } else {
        ctx.auth().kind() == &PrincipalKind::AgentRun(request.expected_run.clone())
    };
    if !authenticated {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "finish_chat_run");
    let budget = ctx.budget.clone();
    let owned = store.clone();
    let effect = ctx.canonical_effect().cloned();
    store
        .with_guarded_auxiliary_command(
            ctx.scope().space_id.clone(),
            None,
            Some((&budget, deadline)),
            effect,
            move |(outcome, cleanup)| {
                drop(cleanup);
                Ok(outcome)
            },
            move |tx, effect| {
                Box::pin(async move {
                    let space = lock_space(&owned, tx, &ctx).await?;
                    effect.begin().await?;
                    let closing = !recover && space.space.lifecycle != SpaceLifecycle::Active;
                    if !closing {
                        authorize_chat_write_on_space(ctx.auth(), &space.space)?;
                    }
                    let thread =
                        load_thread_head_tx(tx, &space.scope.space_id, &request.thread).await?;
                    if closing {
                        // Only the current active claim owner with live write authority may
                        // cancel queued inputs and clear its own claim after archival.
                        let Some(grant) = ctx.auth().spaces().get(&space.space.id) else {
                            return Err(DomainError::ResourceNotFound.into());
                        };
                        let project_matches = grant
                            .project_root
                            .as_ref()
                            .is_none_or(|root| thread.project_folder.as_ref() == Some(root));
                        let audience_ok = !(thread.kind == ChatThreadKind::Personal
                            && ctx.auth().chat_audience()
                                == Some(notarium_core::auth::ChatAudience::Shared));
                        let writable_grant = grant.role != notarium_core::auth::SpaceRole::Viewer
                            && ctx.auth().bearer_scope()
                                != Some(notarium_core::ports::BearerScope::Read);
                        if !writable_grant
                            || ctx.auth().pinned_write_space() != Some(&space.space.id)
                            || thread.kind == ChatThreadKind::KeeperLog
                            || !project_matches
                            || !audience_ok
                            || (thread.kind != ChatThreadKind::SpaceGroup
                                && &thread.owner != ctx.auth().principal())
                            || thread.active_run_id.as_ref() != Some(&request.expected_run)
                            || !use_current_claim(&thread, &owned, &space)
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                    } else if !recover {
                        authorize_claim_lifecycle_leaf(tx, ctx.auth(), &space, &thread).await?;
                    } else {
                        authorize_current_leaf(tx, ctx.auth(), &space, &thread).await?;
                    }
                    if thread.active_run_id.is_none() {
                        return Ok((FinishChatRunOutcome::Cleared, None));
                    }
                    if thread.active_run_id.as_ref() != Some(&request.expected_run) {
                        return Ok((FinishChatRunOutcome::Changed, None));
                    }
                    let valid_owner = use_current_claim(&thread, &owned, &space);
                    if recover == valid_owner {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    // PostgreSQL takeover requires a newer writer epoch. Distinct local
                    // generations are sufficient after SQLite's exclusive DataRoot open.
                    if recover
                        && owned.is_postgres()
                        && thread
                            .active_run_epoch
                            .is_some_and(|epoch| epoch >= space.active_epoch)
                    {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    let rows = pending_rows(tx, &space.scope.space_id, &request.thread).await?;
                    if !recover && !closing && !rows.is_empty() {
                        return Ok((FinishChatRunOutcome::Pending, None));
                    }
                    let mut zero_refs = Vec::new();
                    for (id, _, _, _, _) in rows {
                        zero_refs.extend(
                            cancel_input(tx, &space.scope.space_id, &request.thread, &id).await?,
                        );
                    }
                    set_active(
                        tx,
                        &space,
                        &request.thread,
                        None,
                        &owned.inner.chat_run_generation,
                    )
                    .await?;
                    let cleanup = cleanup_refs(&owned, tx, &space, zero_refs).await?;
                    Ok((FinishChatRunOutcome::Cleared, cleanup))
                })
            },
        )
        .await
        .map_err(|error| crate::codec::retry_unknown_commit("finish_chat_run", error))
}

pub(super) async fn list_pending(
    store: &CanonicalStore,
    ctx: SpaceContext,
    thread_id: ChatThreadId,
) -> Result<Vec<QueuedChatInput>, PortError> {
    forbid_keeper_chat_mutation(ctx.auth())?;
    let PrincipalKind::AgentRun(run) = ctx.auth().kind() else {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    };
    let run = run.clone();
    let scope = ctx.scope().clone();
    let budget = ctx.budget.clone();
    let owned = store.clone();
    let rows = store
        .with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                owned
                    .inner
                    .check_writer_epoch(&scope.space_id, space.active_epoch)?;
                authorize_chat_write_on_space(ctx.auth(), &space.space)?;
                let thread = load_thread_head_tx(tx, &scope.space_id, &thread_id).await?;
                authorize_claim_lifecycle_leaf(tx, ctx.auth(), &space, &thread).await?;
                authorize_run_claim(&owned, &space, &thread, &run)?;
                pending_rows(tx, &scope.space_id, &thread_id).await
            })
        })
        .await?;
    rows.into_iter()
        .map(|(id, author, leaf, run, mentions)| {
            Ok(QueuedChatInput {
                id: PendingInputId::parse(&id)?,
                sender: PrincipalId::parse(&author)?,
                queued_base_leaf: seq_from_db(leaf)?,
                in_flight_run: AgentRunId::parse(&run)?,
                mentions_agent: mentions != 0,
            })
        })
        .collect()
}

pub(super) async fn dismiss_pending(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: DismissPending,
) -> Result<bool, PortError> {
    if ctx.confirmed_chat_step().is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    forbid_keeper_chat_mutation(ctx.auth())?;
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "dismiss_chat_input");
    let budget = ctx.budget.clone();
    let owned = store.clone();
    let effect = ctx.canonical_effect().cloned();
    store
        .with_guarded_auxiliary_command(
            ctx.scope().space_id.clone(),
            None,
            Some((&budget, deadline)),
            effect,
            |(changed, cleanup)| {
                drop(cleanup);
                Ok(changed)
            },
            move |tx, effect| {
                Box::pin(async move {
                    let space = lock_space(&owned, tx, &ctx).await?;
                    effect.begin().await?;
                    authorize_chat_write_on_space(ctx.auth(), &space.space)?;
                    let thread =
                        load_thread_head_tx(tx, &space.scope.space_id, &request.thread).await?;
                    if let PrincipalKind::AgentRun(id) = ctx.auth().kind() {
                        authorize_claim_lifecycle_leaf(tx, ctx.auth(), &space, &thread).await?;
                        authorize_run_claim(&owned, &space, &thread, id)?;
                    } else {
                        authorize_current_leaf(tx, ctx.auth(), &space, &thread).await?;
                    }
                    let Some((_, author, _, run, _)) =
                        pending_rows(tx, &space.scope.space_id, &request.thread)
                            .await?
                            .into_iter()
                            .find(|row| row.0 == request.input.as_str())
                    else {
                        return Ok((false, None));
                    };
                    let active_id = thread.active_run_id.as_ref().map(AgentRunId::as_str);
                    let stale = active_id != Some(run.as_str());
                    let allowed = match ctx.auth().kind() {
                        PrincipalKind::AgentRun(id) => {
                            active_id == Some(id.as_str())
                                && use_current_claim(&thread, &owned, &space)
                        }
                        _ => {
                            author == ctx.auth().principal().as_str()
                                || thread.owner == *ctx.auth().principal()
                                || (stale
                                    && ctx.auth().spaces().get(&space.scope.space_id).is_some_and(
                                        |grant| {
                                            matches!(
                                                grant.role,
                                                SpaceRole::Owner | SpaceRole::Editor
                                            )
                                        },
                                    ))
                        }
                    };
                    if !allowed {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let zero_refs = cancel_input(
                        tx,
                        &space.scope.space_id,
                        &request.thread,
                        request.input.as_str(),
                    )
                    .await?;
                    let cleanup = cleanup_refs(&owned, tx, &space, zero_refs).await?;
                    Ok((true, cleanup))
                })
            },
        )
        .await
        .map_err(|error| crate::codec::retry_unknown_commit("dismiss_chat_input", error))
}

pub(super) async fn require_oldest_pending(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    input: &PendingInputId,
) -> Result<(), PortError> {
    const SELECT: &str = "SELECT input_id FROM chat_pending_inputs
        WHERE space_id = $1 AND thread_id = $2 AND status = 'pending'
        ORDER BY ordinal LIMIT 1";
    let head: Option<String> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_queue_oldest", error))?;
    if head.as_deref() != Some(input.as_str()) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

async fn pending_rows(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
) -> Result<Vec<PendingRow>, PortError> {
    const SELECT: &str = "SELECT input_id, author_id, queued_base_leaf_seq, in_flight_run_id, CAST(mentions_agent AS INTEGER)
        FROM chat_pending_inputs
        WHERE space_id = $1 AND thread_id = $2 AND status = 'pending'
        ORDER BY ordinal LIMIT $3";
    let bound = i32::from(PENDING_CHAT_QUEUE_LIMIT) + 1;
    let rows: Vec<PendingRow> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(bound)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(bound)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("list_chat_queue", error))?;
    if rows.len() > usize::from(PENDING_CHAT_QUEUE_LIMIT) {
        return Err(internal_not_committed(
            "chat_queue_overflow",
            "pending rows exceed cap",
        ));
    }
    Ok(rows)
}

async fn cancel_input(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    input: &str,
) -> Result<Vec<ContentDigest>, PortError> {
    const CANCEL: &str = "UPDATE chat_pending_inputs
        SET status = 'cancelled', inline_text = '', payload_blake3 = NULL
        WHERE space_id = $1 AND thread_id = $2 AND input_id = $3 AND status = 'pending'";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(CANCEL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(input)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(CANCEL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(input)
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(|error| crate::runtime::pg_read_error("cancel_chat_input", error))?;
    release_owner_blob_refs_tx(
        tx,
        space,
        BlobOwnerKind::ChatPendingInput,
        &format!("{}:{input}", thread.as_str()),
    )
    .await
}

async fn cleanup_refs(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    zero_refs: Vec<ContentDigest>,
) -> Result<Option<crate::blobs::RetirementHandoff>, PortError> {
    if zero_refs.is_empty() {
        return Ok(None);
    }
    let mut ids = Vec::new();
    for digest in zero_refs
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
    {
        if let Some(id) = crate::blobs::initiate_digest_retirement_tx(
            tx,
            &space.scope,
            space.active_epoch,
            digest,
            RetirementReason::Gc,
            None,
            None,
        )
        .await?
        {
            ids.push(id);
        }
    }
    Ok((!ids.is_empty())
        .then(|| store.retirement_handoff(&space.scope, space.active_epoch, ids, None)))
}

pub(super) fn seq_from_db(seq: i64) -> Result<ThreadEntrySeq, PortError> {
    Ok(ThreadEntrySeq::new(u64::try_from(seq).map_err(|_| {
        internal_not_committed("chat_entry_seq", "negative entry sequence")
    })?)?)
}

pub(super) async fn other_human_on_branch(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    tip: ThreadEntrySeq,
    queued: ThreadEntrySeq,
    author: &str,
) -> Result<bool, PortError> {
    if tip == queued {
        return Ok(false);
    }
    // This is a query over the selected parent chain, never over globally newer
    // sequence numbers which can belong to sibling branches.
    const SELECT: &str = "WITH RECURSIVE path(entry_seq, parent_seq, author_id, human_origin) AS (
        SELECT entry_seq, parent_seq, author_id, human_origin FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
        UNION ALL
        SELECT e.entry_seq, e.parent_seq, e.author_id, e.human_origin FROM path p
        JOIN chat_entries e ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = p.parent_seq
        WHERE p.parent_seq > $4
    ) SELECT CAST(CASE WHEN EXISTS (
        SELECT 1 FROM path WHERE author_id <> $5 AND COALESCE(human_origin, 1) = 1
    ) THEN 1 ELSE 0 END AS BIGINT)";
    let found: i64 = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(tip.get() as i64)
                .bind(queued.get() as i64)
                .bind(author)
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SELECT)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(tip.get() as i64)
                .bind(queued.get() as i64)
                .bind(author)
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("intervening_chat_author", error))?;
    Ok(found != 0)
}

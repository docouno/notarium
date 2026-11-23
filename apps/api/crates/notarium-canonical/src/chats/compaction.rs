//! A prefix checkpoint changes the prompt view while leaving the audit DAG alone.
use notarium_core::classes::ProviderOrigin;
use notarium_core::ports::PageLimit;

use super::*;

// Historical empty human entries remain readable in the audit branch. Omit them
// from both live prompts and compaction proofs before hydration adds group attribution.
fn empty_human(entry: &ChatEntry) -> bool {
    entry.kind == ChatEntryKind::Human
        && matches!(&entry.body, ChatBody::Inline(text) if text.is_empty())
}

pub(super) async fn context(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<ChatBranch, PortError> {
    let mut branch = store.read_chat(ctx.clone(), request).await?;
    branch.entries.retain(|entry| !empty_human(entry));
    let Some(index) = branch
        .entries
        .iter()
        .rposition(|e| e.kind == ChatEntryKind::Compaction)
    else {
        return Ok(branch);
    };
    let through =
        content::checkpoint_boundary(store, &ctx, &branch.thread, branch.entries[index].seq)
            .await?;
    if let Some(through) = through {
        let checkpoint = branch.entries.remove(index);
        branch
            .entries
            .retain(|entry| entry.seq > through && entry.kind != ChatEntryKind::Compaction);
        branch.entries.insert(0, checkpoint);
        branch.next_ancestor = branch.next_ancestor.filter(|next| *next > through);
    } else {
        // Historical checkpoints represented the whole prior context.
        branch.entries.drain(..index);
        branch.next_ancestor = None;
    }
    Ok(branch)
}

// A thread may accumulate more than a prompt window between AI activations.
// Walk only its parent chain inside one read snapshot. Keep the oldest page of
// live entries after the latest checkpoint together with their payload headers.
struct PrefixWindow {
    space: crate::runtime::SpaceRecord,
    thread_head: ThreadHeadRow,
    branch: ChatBranch,
    payloads: Vec<content::PayloadRow>,
    has_tail: bool,
}

#[derive(sqlx::FromRow)]
struct PrefixChainRow {
    entry_seq: i64,
    parent_seq: Option<i64>,
    revision_id: String,
    kind: String,
    tool_call_id: Option<String>,
    author_id: String,
    agent_run_id: Option<String>,
    inline_text: Option<String>,
    payload_blake3: Option<Vec<u8>>,
    referenced_notes_json: String,
    ext_space_tainted: i32,
    is_chain_node: i32,
    branch_depth: i32,
    anc_16_seq: Option<i64>,
    anc_256_seq: Option<i64>,
    body_format: i32,
    provenance_json: Option<String>,
}

async fn load_prefix_chunk_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    tip: ThreadEntrySeq,
    min_exclusive: ThreadEntrySeq,
    chunk_limit: i64,
) -> Result<Vec<PrefixChainRow>, PortError> {
    const SQL: &str = "WITH RECURSIVE win(
            entry_seq, parent_seq, revision_id, kind, tool_call_id, author_id,
            agent_run_id, inline_text, payload_blake3, referenced_notes_json,
            ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq,
            body_format, provenance_json, n
        ) AS (
            SELECT entry_seq, parent_seq, revision_id,
                   CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END,
                   tool_call_id, author_id, agent_run_id, inline_text, payload_blake3,
                   referenced_notes_json, CAST(ext_space_tainted AS INTEGER),
                   CAST(is_chain_node AS INTEGER), CAST(branch_depth AS INTEGER),
                   anc_16_seq, anc_256_seq, CAST(body_format AS INTEGER), provenance_json, 1
            FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3 AND entry_seq > $4
            UNION ALL
            SELECT e.entry_seq, e.parent_seq, e.revision_id,
                   CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END,
                   e.tool_call_id, e.author_id, e.agent_run_id, e.inline_text, e.payload_blake3,
                   e.referenced_notes_json, CAST(e.ext_space_tainted AS INTEGER),
                   CAST(e.is_chain_node AS INTEGER), CAST(e.branch_depth AS INTEGER),
                   e.anc_16_seq, e.anc_256_seq, CAST(e.body_format AS INTEGER), e.provenance_json, w.n + 1
            FROM win w
            JOIN chat_entries e
              ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = w.parent_seq
            WHERE w.parent_seq IS NOT NULL AND w.parent_seq > $4 AND w.n < $5
        )
        SELECT entry_seq, parent_seq, revision_id, kind, tool_call_id, author_id,
               agent_run_id, inline_text, payload_blake3, referenced_notes_json,
               ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq,
               body_format, provenance_json
        FROM win
        ORDER BY n ASC";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(tip.get() as i64)
                .bind(min_exclusive.get() as i64)
                .bind(chunk_limit)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(tip.get() as i64)
                .bind(min_exclusive.get() as i64)
                .bind(chunk_limit)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_prefix_chunk", error))
}

fn decode_prefix_row(
    thread_id: &ChatThreadId,
    row: PrefixChainRow,
) -> Result<(ChatEntry, content::PayloadRow), PortError> {
    let seq = queue::seq_from_db(row.entry_seq)?;
    let parent = row.parent_seq.map(queue::seq_from_db).transpose()?;
    let anc_16 = row.anc_16_seq.map(queue::seq_from_db).transpose()?;
    let anc_256 = row.anc_256_seq.map(queue::seq_from_db).transpose()?;
    let kind = entry_kind_from_db(&row.kind, row.tool_call_id.clone())?;
    let body = if kind == ChatEntryKind::Redacted {
        ChatBody::Redacted
    } else if let Some(txt) = &row.inline_text {
        ChatBody::Inline(txt.clone())
    } else if let Some(bytes) = &row.payload_blake3 {
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_chat_blob", "digest != 32B"))?;
        ChatBody::Blob(ContentDigest::from_bytes(arr))
    } else {
        return Err(internal_not_committed(
            "corrupt_chat_body",
            "entry lacks inline_text and payload_blake3",
        ));
    };
    let author = PrincipalId::parse(&row.author_id)
        .map_err(|_| internal_not_committed("corrupt_chat_author", "invalid PrincipalId"))?;
    let run = row
        .agent_run_id
        .as_deref()
        .map(AgentRunId::parse)
        .transpose()
        .map_err(|_| internal_not_committed("corrupt_chat_run", "invalid AgentRunId"))?;
    let referenced_notes: Vec<NoteRef> =
        if kind == ChatEntryKind::Redacted || row.referenced_notes_json == "[]" {
            Vec::new()
        } else {
            serde_json::from_str(&row.referenced_notes_json)
                .map_err(|err| internal_not_committed("corrupt_chat_refs", err.to_string()))?
        };
    let depth = u32::try_from(row.branch_depth)
        .map_err(|_| internal_not_committed("corrupt_chat_depth", "invalid depth"))?;
    let entry = ChatEntry {
        thread: thread_id.clone(),
        seq,
        parent,
        is_chain_node: row.is_chain_node != 0,
        depth,
        ancestors: build_ancestors_vec(anc_16, anc_256),
        author,
        run,
        kind,
        body,
        tainted: row.ext_space_tainted != 0,
        referenced_notes,
    };
    let payload = content::PayloadRow {
        entry_seq: row.entry_seq,
        parent_seq: row.parent_seq,
        revision_id: row.revision_id,
        kind: row.kind,
        author_id: row.author_id,
        agent_run_id: row.agent_run_id,
        tool_call_id: row.tool_call_id,
        inline_text: row.inline_text,
        payload_blake3: row.payload_blake3,
        ext_space_tainted: row.ext_space_tainted,
        body_format: row.body_format,
        provenance_json: row.provenance_json,
    };
    Ok((entry, payload))
}

async fn oldest_prefix(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<PrefixWindow, PortError> {
    use std::collections::VecDeque;

    if request.before.is_some() || request.leaf == ThreadEntrySeq::ZERO {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "chat_prompt_prefix");
    let limit = usize::from(request.max_entries.get());
    let budget = ctx.budget.clone();
    let tx_budget = budget.clone();
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let keeper = match auth.kind() {
        PrincipalKind::Keeper(run) => Some(run.clone()),
        _ => None,
    };
    const CHUNK_ROWS: i64 = 256;

    store
        .with_read_tx_budget(Some(&tx_budget), move |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let th = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                auth.can_view_chat_thread(
                    &space.space,
                    &request.thread,
                    th.kind,
                    &th.owner,
                    th.project_folder.as_ref(),
                    false,
                )?;
                let thread_tainted =
                    read_leaf_taint(tx, &scope.space_id, &request.thread, request.leaf).await?;
                auth.authorize_chat_thread_read(
                    &space.space,
                    &request.thread,
                    th.kind,
                    &th.owner,
                    th.project_folder.as_ref(),
                    thread_tainted,
                )?;

                let mut retained: VecDeque<(ChatEntry, content::PayloadRow)> =
                    VecDeque::with_capacity(limit + 1);
                let mut checkpoint: Option<(ChatEntry, content::PayloadRow)> = None;
                let mut through = ThreadEntrySeq::ZERO;
                let mut has_tail = false;
                let mut cursor = Some(request.leaf);

                'chunks: while let Some(tip) = cursor {
                    deadline.remaining(&budget)?;
                    if tip <= through {
                        break;
                    }
                    let rows = load_prefix_chunk_tx(
                        tx,
                        &scope.space_id,
                        &request.thread,
                        tip,
                        through,
                        CHUNK_ROWS,
                    )
                    .await?;
                    if rows.is_empty() {
                        break;
                    }
                    let mut next_cursor = None;
                    for raw in rows {
                        let (entry, payload) = decode_prefix_row(&request.thread, raw)?;
                        if entry.tainted {
                            auth.authorize_chat_thread_read(
                                &space.space,
                                &request.thread,
                                th.kind,
                                &th.owner,
                                th.project_folder.as_ref(),
                                true,
                            )?;
                        }
                        if entry.seq <= through
                            || keeper
                                .as_ref()
                                .is_some_and(|run| entry.run.as_ref() != Some(run))
                        {
                            break 'chunks;
                        }
                        next_cursor = entry.parent;
                        if entry.kind == ChatEntryKind::Compaction {
                            if checkpoint.is_none() {
                                through = content::decode_proof(
                                    payload.provenance_json.as_deref(),
                                    th.redaction_epoch,
                                )?
                                .and_then(|proof| proof.compacts_through)
                                .unwrap_or(entry.seq);
                                checkpoint = Some((entry, payload));
                            }
                        } else if entry.kind != ChatEntryKind::Redacted && !empty_human(&entry) {
                            retained.push_front((entry, payload));
                            if retained.len() > limit {
                                retained.pop_back();
                                has_tail = true;
                            }
                        }
                    }
                    cursor = next_cursor.filter(|next| *next > through);
                }

                if let Some(checkpoint) = checkpoint {
                    retained.push_front(checkpoint);
                    if retained.len() > limit {
                        retained.pop_back();
                        has_tail = true;
                    }
                }
                let thread = ChatThread {
                    id: th.thread_id.clone(),
                    space: scope.space_id.clone(),
                    kind: th.kind,
                    owner: th.owner.clone(),
                    project_folder: th.project_folder.clone(),
                    head: th.head_leaf_seq,
                    revision: th.head_rev_id.clone(),
                    tainted: thread_tainted,
                    title: th.title.clone(),
                    active_run: th.active_run_id.clone(),
                };
                let mut entries = Vec::with_capacity(retained.len());
                let mut payloads = Vec::with_capacity(retained.len());
                for (entry, payload) in retained {
                    entries.push(entry);
                    payloads.push(payload);
                }
                Ok(PrefixWindow {
                    space,
                    thread_head: th,
                    branch: ChatBranch {
                        thread,
                        entries,
                        next_ancestor: None,
                    },
                    payloads,
                    has_tail,
                })
            })
        })
        .await
}

pub(super) async fn hydrated_prefix(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<notarium_core::ports::ChatCompactionPrefix, PortError> {
    let deadline =
        crate::domain::common::CommandDeadline::start(&ctx.budget, "hydrate_prompt_prefix");
    let started = tokio::time::Instant::now();
    let window = oldest_prefix(store, ctx.clone(), request).await?;
    let contents = content::hydrate_payloads(
        store,
        ctx.auth(),
        &window.space,
        &window.thread_head,
        window.payloads,
        &ctx.budget,
        started,
        deadline,
    )
    .await?;
    Ok(notarium_core::ports::ChatCompactionPrefix {
        branch: window.branch,
        contents,
        has_tail: window.has_tail,
    })
}

pub(super) async fn verify_prefix(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: &Mutation<AppendChat>,
) -> Result<(), PortError> {
    let input = &request.input;
    let Some((proof, through)) = input
        .provenance
        .as_ref()
        .and_then(|proof| proof.compacts_through.map(|through| (proof, through)))
    else {
        return Ok(());
    };
    if through == ThreadEntrySeq::ZERO || through >= input.parent {
        return Err(mismatch());
    }
    #[cfg(feature = "test-support")]
    super::preparation_test::pause().await;
    let keeper = match ctx.auth().kind() {
        PrincipalKind::Keeper(run) => Some(run.clone()),
        _ => None,
    };
    let read = ChatRead {
        thread: input.thread.clone(),
        leaf: input.parent,
        before: None,
        max_entries: PageLimit::new(200)?,
    };
    let mut branch = context(store, ctx.clone(), read.clone()).await?;
    if branch.next_ancestor.is_some()
        && !keeper.as_ref().is_some_and(|run| {
            branch
                .entries
                .iter()
                .any(|entry| entry.run.as_ref() != Some(run))
        })
    {
        branch = oldest_prefix(store, ctx, read).await?.branch;
    }

    // Appending the prefix witness uses the very same revision CAS. A
    // redaction, branch change, or concurrent append invalidates this proof.
    if branch.thread.head != input.parent
        || request.preconditions.revision.as_ref() != Some(&branch.thread.revision)
    {
        return Err(DomainError::RevisionConflict {
            current: branch.thread.revision,
            lineage: None,
        }
        .into());
    }
    let mut entries = branch.entries;
    if let Some(run) = &keeper {
        entries.retain(|entry| entry.run.as_ref() == Some(run));
    }
    // A redaction preserves ancestry but has no body to disclose or cite.
    // Proofs of surviving entries still refer to their original sources.
    entries.retain(|entry| entry.kind != ChatEntryKind::Redacted);
    let cut = entries
        .iter()
        .position(|entry| entry.seq == through && entry.kind != ChatEntryKind::Compaction)
        .filter(|cut| {
            entries
                .get(*cut + 1)
                .is_some_and(|entry| !matches!(entry.kind, ChatEntryKind::Tool { .. }))
        })
        .ok_or_else(mismatch)?;
    let expected = entries[..=cut]
        .iter()
        .map(|entry| {
            let digest = match &entry.body {
                ChatBody::Inline(text) => {
                    ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
                }
                ChatBody::Blob(digest) => *digest,
                ChatBody::Redacted => return Err(mismatch()),
            };
            Ok(ProviderOrigin::Chat {
                space: branch.thread.space.clone(),
                thread: input.thread.clone(),
                entry: entry.seq,
                digest,
                project: branch.thread.project_folder.clone(),
            })
        })
        .collect::<Result<Vec<_>, PortError>>()?;
    let actual: Vec<_> = proof
        .origins
        .iter()
        .filter(|origin| matches!(origin, ProviderOrigin::Chat { .. }))
        .collect();
    if actual.len() != expected.len() || expected.iter().any(|origin| !actual.contains(&origin)) {
        return Err(mismatch());
    }
    Ok(())
}

fn mismatch() -> PortError {
    DomainError::validation(ValidationReason::SourceMismatch).into()
}

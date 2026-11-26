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

struct PrefixScanResult {
    checkpoint_seq: Option<i64>,
    any_tainted: bool,
    oldest_seqs: Vec<i64>,
    has_tail: bool,
}

struct PrefixScanQuery<'a> {
    space_id: &'a SpaceId,
    thread_id: &'a ChatThreadId,
    leaf: ThreadEntrySeq,
    min_exclusive: ThreadEntrySeq,
    keeper: Option<&'a AgentRunId>,
    stop_at_compaction: bool,
    limit: usize,
}

async fn jump_to_depth_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    start_seq: ThreadEntrySeq,
    target_depth: i32,
) -> Result<Option<i64>, PortError> {
    const SQLITE_SQL: &str = "WITH RECURSIVE jump(entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
            SELECT entry_seq, CAST(branch_depth AS INTEGER), parent_seq, anc_16_seq, anc_256_seq, 0
            FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
            UNION ALL
            SELECT e.entry_seq, CAST(e.branch_depth AS INTEGER), e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
            FROM jump j
            CROSS JOIN chat_entries e
            WHERE e.space_id = $1 AND e.thread_id = $2
              AND e.entry_seq = CASE
                  WHEN j.branch_depth - $4 >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                  WHEN j.branch_depth - $4 >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                  ELSE j.parent_seq
              END
              AND j.branch_depth > $4 AND j.hops < 100000
        )
        SELECT entry_seq FROM jump WHERE branch_depth = $4 LIMIT 1";
    const PG_SQL: &str = "WITH RECURSIVE jump(entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
            SELECT entry_seq, CAST(branch_depth AS INTEGER), parent_seq, anc_16_seq, anc_256_seq, 0
            FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
            UNION ALL
            SELECT e.entry_seq, CAST(e.branch_depth AS INTEGER), e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
            FROM jump j
            JOIN LATERAL (
                SELECT entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq
                FROM chat_entries
                WHERE space_id = $1 AND thread_id = $2
                  AND entry_seq = CASE
                      WHEN j.branch_depth - $4 >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                      WHEN j.branch_depth - $4 >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                      ELSE j.parent_seq
                  END
                LIMIT 1
            ) e ON true
            WHERE j.branch_depth > $4 AND j.hops < 100000
        )
        SELECT entry_seq FROM jump WHERE branch_depth = $4 LIMIT 1";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQLITE_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(start_seq.get() as i64)
                .bind(target_depth)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(PG_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(start_seq.get() as i64)
                .bind(target_depth)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_jump", error))
}

async fn entry_depth_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    seq: ThreadEntrySeq,
) -> Result<Option<i32>, PortError> {
    const SQL: &str = "SELECT CAST(branch_depth AS INTEGER) FROM chat_entries
                       WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(seq.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(seq.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_depth", error))
}

async fn latest_compaction_candidates_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    max_seq: i64,
    limit: i64,
) -> Result<Vec<(i64, i32)>, PortError> {
    const SQLITE_SQL: &str = include_str!("latest_compaction_candidates.sqlite.sql");
    const PG_SQL: &str = "SELECT entry_seq, CAST(branch_depth AS INTEGER)
                          FROM chat_entries
                          WHERE space_id = $1 AND thread_id = $2
                            AND kind = 'compaction' AND checkpoint_stale = 0
                            AND entry_seq <= $3
                          ORDER BY entry_seq DESC
                          LIMIT $4";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SQLITE_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(max_seq)
                .bind(limit)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(PG_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(max_seq)
                .bind(limit)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_candidates", error))
}

async fn thread_has_tainted_in_range_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    min_exclusive: ThreadEntrySeq,
    max_inclusive: ThreadEntrySeq,
) -> Result<bool, PortError> {
    const SQL: &str = "SELECT 1 FROM chat_entries
                       WHERE space_id = $1 AND thread_id = $2
                         AND ext_space_tainted <> 0
                         AND entry_seq > $3 AND entry_seq <= $4
                       LIMIT 1";
    let found: Option<i32> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(min_exclusive.get() as i64)
                .bind(max_inclusive.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(min_exclusive.get() as i64)
                .bind(max_inclusive.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_taint_check", error))?;
    Ok(found.is_some())
}

async fn scan_prefix_chain_tx(
    tx: &mut BackendConn<'_>,
    query: PrefixScanQuery<'_>,
) -> Result<PrefixScanResult, PortError> {
    let PrefixScanQuery {
        space_id,
        thread_id,
        leaf,
        min_exclusive,
        keeper,
        stop_at_compaction,
        limit,
    } = query;
    const SQLITE_SQL: &str = "WITH RECURSIVE chain(
            entry_seq, parent_seq, kind, is_empty_human, ext_space_tainted, n
        ) AS MATERIALIZED (
            SELECT entry_seq, parent_seq,
                   CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END,
                   CASE WHEN checkpoint_stale = 0 AND kind = 'human' AND inline_text = '' THEN 1 ELSE 0 END,
                   CAST(ext_space_tainted AS INTEGER),
                   1
            FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
              AND entry_seq > $4
              AND ($5 = '' OR agent_run_id = $5)
            UNION ALL
            SELECT e.entry_seq, e.parent_seq,
                   CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END,
                   CASE WHEN e.checkpoint_stale = 0 AND e.kind = 'human' AND e.inline_text = '' THEN 1 ELSE 0 END,
                   CAST(e.ext_space_tainted AS INTEGER),
                   c.n + 1
            FROM chain c
            CROSS JOIN chat_entries e
            WHERE e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = c.parent_seq
              AND c.parent_seq IS NOT NULL
              AND c.parent_seq > $4
              AND ($6 = 0 OR c.kind <> 'compaction')
              AND ($5 = '' OR e.agent_run_id = $5)
        )
        SELECT 0 AS tag,
               COALESCE(MAX(CASE WHEN kind = 'compaction' THEN entry_seq END), 0) AS val,
               COALESCE(MAX(ext_space_tainted), 0) AS extra
        FROM chain
        UNION ALL
        SELECT 1 AS tag, entry_seq AS val, n AS extra
        FROM (
            SELECT entry_seq, n
            FROM chain
            WHERE kind <> 'redacted' AND kind <> 'compaction' AND is_empty_human = 0
            ORDER BY n DESC
            LIMIT $7
        ) oldest";
    const PG_SQL: &str = "WITH RECURSIVE chain(
            entry_seq, parent_seq, kind, is_empty_human, ext_space_tainted, n
        ) AS MATERIALIZED (
            SELECT entry_seq, parent_seq,
                   CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END,
                   CASE WHEN checkpoint_stale = 0 AND kind = 'human' AND inline_text = '' THEN 1 ELSE 0 END,
                   CAST(ext_space_tainted AS INTEGER),
                   1
            FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
              AND entry_seq > $4
              AND ($5 = '' OR agent_run_id = $5)
            UNION ALL
            SELECT e.entry_seq, e.parent_seq,
                   CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END,
                   CASE WHEN e.checkpoint_stale = 0 AND e.kind = 'human' AND e.inline_text = '' THEN 1 ELSE 0 END,
                   CAST(e.ext_space_tainted AS INTEGER),
                   c.n + 1
            FROM chain c
            JOIN LATERAL (
                SELECT entry_seq, parent_seq, checkpoint_stale, kind, inline_text, ext_space_tainted, agent_run_id
                FROM chat_entries
                WHERE space_id = $1 AND thread_id = $2 AND entry_seq = c.parent_seq
                LIMIT 1
            ) e ON true
            WHERE c.parent_seq IS NOT NULL
              AND c.parent_seq > $4
              AND ($6 = 0 OR c.kind <> 'compaction')
              AND ($5 = '' OR e.agent_run_id = $5)
        )
        SELECT 0 AS tag,
               COALESCE(MAX(CASE WHEN kind = 'compaction' THEN entry_seq END), 0) AS val,
               COALESCE(MAX(ext_space_tainted), 0) AS extra
        FROM chain
        UNION ALL
        SELECT 1 AS tag, entry_seq AS val, n AS extra
        FROM (
            SELECT entry_seq, n
            FROM chain
            WHERE kind <> 'redacted' AND kind <> 'compaction' AND is_empty_human = 0
            ORDER BY n DESC
            LIMIT $7
        ) oldest";
    let keeper_str = keeper.map_or("", AgentRunId::as_str);
    let stop_flag: i32 = i32::from(stop_at_compaction);
    let fetch_limit = i64::try_from(limit + 1)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidLimit))?;
    let rows: Vec<(i32, i64, i32)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SQLITE_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(leaf.get() as i64)
                .bind(min_exclusive.get() as i64)
                .bind(keeper_str)
                .bind(stop_flag)
                .bind(fetch_limit)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(PG_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(leaf.get() as i64)
                .bind(min_exclusive.get() as i64)
                .bind(keeper_str)
                .bind(stop_flag)
                .bind(fetch_limit)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_prefix_scan", error))?;

    let mut checkpoint_seq = None;
    let mut any_tainted = false;
    let mut seqs_with_depth: Vec<(i64, i32)> = Vec::with_capacity(limit + 1);
    for (tag, val, extra) in rows {
        if tag == 0 {
            if val > 0 {
                checkpoint_seq = Some(val);
            }
            if extra != 0 {
                any_tainted = true;
            }
        } else {
            seqs_with_depth.push((val, extra));
        }
    }
    // Sort oldest-first (highest recursion depth `n` first) to keep ordering
    // independent of SQL UNION ALL row emission order.
    seqs_with_depth.sort_by_key(|a| std::cmp::Reverse(a.1));
    let has_tail = seqs_with_depth.len() > limit;
    seqs_with_depth.truncate(limit);
    let oldest_seqs = seqs_with_depth.into_iter().map(|(seq, _)| seq).collect();
    Ok(PrefixScanResult {
        checkpoint_seq,
        any_tainted,
        oldest_seqs,
        has_tail,
    })
}

async fn load_prefix_rows_by_seq_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    seqs: &[i64],
) -> Result<std::collections::HashMap<i64, PrefixChainRow>, PortError> {
    if seqs.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows: Vec<PrefixChainRow> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut qb = sqlx::QueryBuilder::new(
                "SELECT entry_seq, parent_seq, revision_id,
                        CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END AS kind,
                        tool_call_id, author_id, agent_run_id, inline_text, payload_blake3,
                        referenced_notes_json, CAST(ext_space_tainted AS INTEGER) AS ext_space_tainted,
                        CAST(is_chain_node AS INTEGER) AS is_chain_node,
                        CAST(branch_depth AS INTEGER) AS branch_depth,
                        anc_16_seq, anc_256_seq, CAST(body_format AS INTEGER) AS body_format,
                        provenance_json
                 FROM chat_entries
                 WHERE space_id = ",
            );
            qb.push_bind(space_id.as_str());
            qb.push(" AND thread_id = ");
            qb.push_bind(thread_id.as_str());
            qb.push(" AND entry_seq IN (");
            let mut sep = qb.separated(", ");
            for seq in seqs {
                sep.push_bind(*seq);
            }
            qb.push(")");
            qb.build_query_as::<PrefixChainRow>()
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            const PG_SQL: &str = "SELECT entry_seq, parent_seq, revision_id,
                        CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END AS kind,
                        tool_call_id, author_id, agent_run_id, inline_text, payload_blake3,
                        referenced_notes_json, CAST(ext_space_tainted AS INTEGER) AS ext_space_tainted,
                        CAST(is_chain_node AS INTEGER) AS is_chain_node,
                        CAST(branch_depth AS INTEGER) AS branch_depth,
                        anc_16_seq, anc_256_seq, CAST(body_format AS INTEGER) AS body_format,
                        provenance_json
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = ANY($3)";
            sqlx::query_as(PG_SQL)
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(seqs)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_compaction_prefix_rows", error))?;
    Ok(rows.into_iter().map(|row| (row.entry_seq, row)).collect())
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

                deadline.remaining(&budget)?;
                let mut any_tainted = thread_tainted;
                let mut checkpoint: Option<(ChatEntry, content::PayloadRow)> = None;
                let leaf_depth = if keeper.is_none() {
                    entry_depth_tx(tx, &scope.space_id, &request.thread, request.leaf).await?
                } else {
                    None
                };

                // Fast skip-list path using anc_256_seq / anc_16_seq for long non-keeper
                // branches: avoids walking tens of thousands of rows step-by-step while
                // preserving exact checkpoint, taint, redaction, and empty-human semantics.
                let fast_plan = if let Some(leaf_depth) = leaf_depth
                    && leaf_depth > (limit as i32) + 64
                {
                    const CANDIDATE_PAGE: i64 = 64;
                    let mut matched_cp: Option<(i64, i32)> = None;
                    let mut cursor_max = request.leaf.get() as i64;
                    loop {
                        deadline.remaining(&budget)?;
                        let candidates = latest_compaction_candidates_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            cursor_max,
                            CANDIDATE_PAGE,
                        )
                        .await?;
                        let page_len = candidates.len();
                        let mut last_seq = cursor_max;
                        for (cand_seq, cand_depth) in candidates {
                            deadline.remaining(&budget)?;
                            last_seq = cand_seq;
                            if cand_depth <= leaf_depth
                                && jump_to_depth_tx(
                                    tx,
                                    &scope.space_id,
                                    &request.thread,
                                    request.leaf,
                                    cand_depth,
                                )
                                .await?
                                    == Some(cand_seq)
                            {
                                matched_cp = Some((cand_seq, cand_depth));
                                break;
                            }
                        }
                        if matched_cp.is_some()
                            || page_len < CANDIDATE_PAGE as usize
                            || last_seq <= 1
                        {
                            break;
                        }
                        cursor_max = last_seq - 1;
                    }
                    let (through, through_depth) = if let Some((cp_seq, cp_depth)) = matched_cp {
                        deadline.remaining(&budget)?;
                        let mut cp_map = load_prefix_rows_by_seq_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            &[cp_seq],
                        )
                        .await?;
                        let cp_raw = cp_map.remove(&cp_seq).ok_or_else(|| {
                            internal_not_committed(
                                "missing_compaction_checkpoint",
                                "compaction checkpoint disappeared inside read snapshot",
                            )
                        })?;
                        let (cp_entry, cp_payload) = decode_prefix_row(&request.thread, cp_raw)?;
                        if cp_entry.tainted {
                            any_tainted = true;
                        }
                        let through = content::decode_proof(
                            cp_payload.provenance_json.as_deref(),
                            th.redaction_epoch,
                        )?
                        .and_then(|proof| proof.compacts_through)
                        .unwrap_or(cp_entry.seq);
                        let through_depth = if through == cp_entry.seq {
                            cp_depth
                        } else {
                            entry_depth_tx(tx, &scope.space_id, &request.thread, through)
                                .await?
                                .unwrap_or(-1)
                        };
                        checkpoint = Some((cp_entry, cp_payload));
                        (through, through_depth)
                    } else {
                        (ThreadEntrySeq::ZERO, -1)
                    };
                    let need_full_taint_scan = !any_tainted
                        && thread_has_tainted_in_range_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            through,
                            request.leaf,
                        )
                        .await?;
                    if need_full_taint_scan {
                        checkpoint = None;
                        None
                    } else {
                        let mut window: i32 = (limit as i32) + 64;
                        loop {
                            deadline.remaining(&budget)?;
                            let target_depth = through_depth.saturating_add(window).min(leaf_depth);
                            let anchor = if target_depth >= leaf_depth {
                                request.leaf
                            } else {
                                let Some(seq) = jump_to_depth_tx(
                                    tx,
                                    &scope.space_id,
                                    &request.thread,
                                    request.leaf,
                                    target_depth,
                                )
                                .await?
                                else {
                                    checkpoint = None;
                                    break None;
                                };
                                queue::seq_from_db(seq)?
                            };
                            let scan = scan_prefix_chain_tx(
                                tx,
                                PrefixScanQuery {
                                    space_id: &scope.space_id,
                                    thread_id: &request.thread,
                                    leaf: anchor,
                                    min_exclusive: through,
                                    keeper: None,
                                    stop_at_compaction: false,
                                    limit,
                                },
                            )
                            .await?;
                            if scan.any_tainted {
                                any_tainted = true;
                            }
                            if (scan.oldest_seqs.len() >= limit && scan.has_tail)
                                || target_depth >= leaf_depth
                            {
                                break Some((scan.oldest_seqs, scan.has_tail));
                            }
                            window = window.saturating_mul(2);
                        }
                    }
                } else {
                    None
                };

                let (selected_seqs, mut has_tail) = if let Some(pair) = fast_plan {
                    pair
                } else {
                    let first_scan = scan_prefix_chain_tx(
                        tx,
                        PrefixScanQuery {
                            space_id: &scope.space_id,
                            thread_id: &request.thread,
                            leaf: request.leaf,
                            min_exclusive: ThreadEntrySeq::ZERO,
                            keeper: keeper.as_ref(),
                            stop_at_compaction: true,
                            limit,
                        },
                    )
                    .await?;
                    if first_scan.any_tainted {
                        any_tainted = true;
                    }
                    if let Some(cp_seq) = first_scan.checkpoint_seq {
                        deadline.remaining(&budget)?;
                        let mut cp_map = load_prefix_rows_by_seq_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            &[cp_seq],
                        )
                        .await?;
                        let cp_raw = cp_map.remove(&cp_seq).ok_or_else(|| {
                            internal_not_committed(
                                "missing_compaction_checkpoint",
                                "compaction checkpoint disappeared inside read snapshot",
                            )
                        })?;
                        let (cp_entry, cp_payload) = decode_prefix_row(&request.thread, cp_raw)?;
                        if cp_entry.tainted {
                            any_tainted = true;
                        }
                        let through = content::decode_proof(
                            cp_payload.provenance_json.as_deref(),
                            th.redaction_epoch,
                        )?
                        .and_then(|proof| proof.compacts_through)
                        .unwrap_or(cp_entry.seq);
                        let cp_entry_seq = cp_entry.seq;
                        checkpoint = Some((cp_entry, cp_payload));
                        if through < cp_entry_seq {
                            deadline.remaining(&budget)?;
                            let second_scan = scan_prefix_chain_tx(
                                tx,
                                PrefixScanQuery {
                                    space_id: &scope.space_id,
                                    thread_id: &request.thread,
                                    leaf: request.leaf,
                                    min_exclusive: through,
                                    keeper: keeper.as_ref(),
                                    stop_at_compaction: false,
                                    limit,
                                },
                            )
                            .await?;
                            if second_scan.any_tainted {
                                any_tainted = true;
                            }
                            (second_scan.oldest_seqs, second_scan.has_tail)
                        } else {
                            (first_scan.oldest_seqs, first_scan.has_tail)
                        }
                    } else {
                        (first_scan.oldest_seqs, first_scan.has_tail)
                    }
                };

                if any_tainted {
                    auth.authorize_chat_thread_read(
                        &space.space,
                        &request.thread,
                        th.kind,
                        &th.owner,
                        th.project_folder.as_ref(),
                        true,
                    )?;
                }

                deadline.remaining(&budget)?;
                let mut row_map = load_prefix_rows_by_seq_tx(
                    tx,
                    &scope.space_id,
                    &request.thread,
                    &selected_seqs,
                )
                .await?;
                let mut retained: Vec<(ChatEntry, content::PayloadRow)> =
                    Vec::with_capacity(selected_seqs.len() + usize::from(checkpoint.is_some()));
                if let Some(cp) = checkpoint {
                    retained.push(cp);
                }
                for seq in selected_seqs {
                    let raw = row_map.remove(&seq).ok_or_else(|| {
                        internal_not_committed(
                            "missing_prefix_entry",
                            "chat prefix entry disappeared inside read snapshot",
                        )
                    })?;
                    retained.push(decode_prefix_row(&request.thread, raw)?);
                }
                if retained.len() > limit {
                    retained.truncate(limit);
                    has_tail = true;
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
                let mut ref_vis_cache = std::collections::HashMap::new();
                let mut entries = Vec::with_capacity(retained.len());
                let mut payloads = Vec::with_capacity(retained.len());
                for (mut entry, payload) in retained {
                    entry.referenced_notes = super::filter_readable_referenced_notes_tx(
                        tx,
                        &space.space,
                        &auth,
                        entry.referenced_notes,
                        &mut ref_vis_cache,
                    )
                    .await?;
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

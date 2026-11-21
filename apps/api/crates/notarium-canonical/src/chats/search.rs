//! Search admission for active chat entries and bounded historical seed pages.

use super::{
    ThreadHeadRow, jump_to_ancestor_at_depth_tx, load_entry_depth_and_taint_tx,
    load_thread_head_opt_tx,
};
use crate::{
    CanonicalStore,
    changes::list_thread_keys_at_or_below_cutoff_tx,
    codec::{RevisionMetadataPayload, internal_not_committed},
    domain::common::CommandDeadline,
    runtime::{
        SpaceRecord, load_space_record, pg_read_error, read_immutable_revision_tx,
        validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::{Space, SpaceLifecycle},
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, ContentDigest, FolderId, PrincipalId, SpaceId, SpaceSeq, ThreadEntrySeq},
    model::HistoryScope,
    ports::{
        CallBudget, ChatThreadKind, PageLimit, ServiceAuthority, ServicePurpose, SpaceContext,
    },
};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone)]
pub struct HydratedChatHit {
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    pub kind: ChatThreadKind,
    pub project_folder: Option<FolderId>,
    pub owner: PrincipalId,
    pub author: PrincipalId,
    pub text: String,
}

pub struct SearchChatEntriesPage {
    pub entries: Vec<HydratedChatHit>,
    /// An inclusive cursor to the next parent on the pinned chain.
    pub next_before: Option<ThreadEntrySeq>,
}

#[derive(sqlx::FromRow)]
struct Entry {
    entry_seq: i64,
    parent_seq: Option<i64>,
    branch_depth: i64,
    kind: String,
    author_id: String,
    inline_text: Option<String>,
    payload_blake3: Option<Vec<u8>>,
    checkpoint_stale: i64,
    ext_space_tainted: i64,
}
impl Entry {
    fn searchable(&self) -> bool {
        self.kind != "redacted" && self.checkpoint_stale == 0
    }
    fn tainted(&self) -> bool {
        self.ext_space_tainted != 0
    }
    fn seq(&self) -> Result<ThreadEntrySeq, PortError> {
        entry_seq(self.entry_seq)
    }
}

fn entry_seq(raw: i64) -> Result<ThreadEntrySeq, PortError> {
    Ok(ThreadEntrySeq::new(u64::try_from(raw).map_err(|_| {
        internal_not_committed("search_chat_seq", "negative entry sequence")
    })?)?)
}

impl CanonicalStore {
    pub async fn list_searchable_threads_seed_page(
        &self,
        authority: &ServiceAuthority,
        budget: &CallBudget,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        after_thread: Option<&ChatThreadId>,
        limit: PageLimit,
    ) -> Result<(Vec<ChatThreadId>, Option<ChatThreadId>), PortError> {
        authority.require(ServicePurpose::Search)?;
        let scope = scope.clone();
        let after = after_thread.cloned();
        let limit = usize::from(limit.get());
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                active_space(tx, &scope).await?;
                let cutoff = validate_snapshot_cutoff_tx(tx, &scope, Some(cutoff)).await?;
                let mut keys = list_thread_keys_at_or_below_cutoff_tx(
                    tx,
                    &scope,
                    cutoff,
                    after.as_ref().map(ChatThreadId::as_str),
                    limit as i64 + 1,
                )
                .await?
                .iter()
                .map(|key| ChatThreadId::parse(key))
                .collect::<Result<Vec<_>, _>>()?;
                let next = (keys.len() > limit).then(|| keys[limit - 1].clone());
                keys.truncate(limit);
                Ok((keys, next))
            })
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn read_searchable_chat_entries_page(
        &self,
        authority: &ServiceAuthority,
        budget: &CallBudget,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        cutoff: SpaceSeq,
        before: Option<ThreadEntrySeq>,
        limit: PageLimit,
    ) -> Result<SearchChatEntriesPage, PortError> {
        authority.require(ServicePurpose::Search)?;
        let deadline = CommandDeadline::start(budget, "read_search_chat_chain");
        let key = thread.clone();
        let history = scope.clone();
        let planned = self
            .with_read_tx_budget(Some(&tx_budget(budget, &deadline)?), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &history).await?;
                    let cutoff = validate_snapshot_cutoff_tx(tx, &history, Some(cutoff)).await?;
                    let Some(revision) =
                        read_immutable_revision_tx(tx, &history, "thread", key.as_str(), cutoff)
                            .await?
                    else {
                        return Ok(None);
                    };
                    let RevisionMetadataPayload::Thread(meta) = revision.metadata.payload else {
                        return Err(internal_not_committed(
                            "search_chat_revision",
                            "expected thread metadata",
                        ));
                    };
                    let tip = before.unwrap_or(meta.head_leaf_seq);
                    if before.is_some_and(|seq| seq != meta.head_leaf_seq) {
                        let valid = match load_entry(tx, &space.space.id, &key, tip).await? {
                            Some(entry) => {
                                reachable(tx, &space.space.id, &key, meta.head_leaf_seq, &entry)
                                    .await?
                            }
                            None => false,
                        };
                        if !valid {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidRange).into()
                            );
                        }
                    }
                    let rows = read_chain(tx, &space.space.id, &key, tip, limit).await?;
                    let next = rows
                        .last()
                        .and_then(|entry| entry.parent_seq)
                        .map(entry_seq)
                        .transpose()?;
                    Ok(Some((
                        meta.kind,
                        meta.project_folder_id,
                        meta.owner_id,
                        rows,
                        next,
                    )))
                })
            })
            .await?;
        let Some((kind, project, owner, rows, next_before)) = planned else {
            return Ok(SearchChatEntriesPage {
                entries: vec![],
                next_before: None,
            });
        };
        let mut entries = Vec::new();
        for entry in rows.into_iter().filter(Entry::searchable) {
            if let Some(text) = self
                .read_search_chat_text(scope, budget, &deadline, &entry)
                .await?
            {
                entries.push(make_hit(
                    thread,
                    kind,
                    project.clone(),
                    owner.clone(),
                    &entry,
                    text,
                )?);
            }
        }
        let history = scope.clone();
        let key = thread.clone();
        let entries = self
            .with_read_tx_budget(Some(&tx_budget(budget, &deadline)?), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &history).await?;
                    let mut visible = Vec::with_capacity(entries.len());
                    for hit in entries {
                        if load_entry(tx, &space.space.id, &key, hit.entry)
                            .await?
                            .is_some_and(|entry| entry.searchable())
                        {
                            visible.push(hit);
                        }
                    }
                    Ok(visible)
                })
            })
            .await?;
        Ok(SearchChatEntriesPage {
            entries,
            next_before,
        })
    }

    /// Admit one ranked candidate page without recording a chat read. Only
    /// the final page assembled for delivery may affect the caller's taint.
    pub async fn visible_chat_hit_keys(
        &self,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
    ) -> Result<Vec<(ChatThreadId, ThreadEntrySeq)>, PortError> {
        if candidates.len() > 200 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let deadline = CommandDeadline::start(&ctx.budget, "filter_search_chat");
        let (_, rows, _) = self
            .plan_chat_hits(ctx, &deadline, candidates.to_vec(), candidates.len())
            .await?;
        rows.into_iter()
            .map(|(thread, entry)| Ok((thread.thread_id, entry.seq()?)))
            .collect()
    }

    pub async fn hydrate_live_visible_chat_hits(
        &self,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> Result<(Vec<HydratedChatHit>, bool), PortError> {
        // One additional candidate witnesses truncation at the largest page limit.
        if candidates.len() > 201 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let deadline = CommandDeadline::start(&ctx.budget, "hydrate_search_chat");
        let max = usize::from(limit.get());
        let (_, planned, truncated) = self
            .plan_chat_hits(ctx, &deadline, candidates.to_vec(), max)
            .await?;
        let mut hydrated = BTreeMap::new();
        let mut keys = Vec::new();
        for (thread, row) in planned {
            if let Some(text) = self
                .read_search_chat_text(ctx.scope(), &ctx.budget, &deadline, &row)
                .await?
            {
                let key = (thread.thread_id, row.seq()?);
                keys.push(key.clone());
                hydrated.insert(key, text);
            }
        }
        let (space, current, _) = self.plan_chat_hits(ctx, &deadline, keys, max).await?;
        let mut hits = Vec::with_capacity(current.len());
        for (thread, row) in current {
            let Some(text) = hydrated.remove(&(thread.thread_id.clone(), row.seq()?)) else {
                continue;
            };
            ctx.auth().authorize_chat_thread_read(
                &space,
                thread.kind,
                &thread.owner,
                thread.project_folder.as_ref(),
                row.tainted(),
            )?;
            hits.push(make_hit(
                &thread.thread_id,
                thread.kind,
                thread.project_folder,
                thread.owner,
                &row,
                text,
            )?);
        }
        Ok((hits, truncated))
    }

    async fn plan_chat_hits(
        &self,
        ctx: &SpaceContext,
        deadline: &CommandDeadline,
        candidates: Vec<(ChatThreadId, ThreadEntrySeq)>,
        limit: usize,
    ) -> Result<(Space, Vec<(ThreadHeadRow, Entry)>, bool), PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        self.with_read_tx_budget(Some(&tx_budget(&ctx.budget, deadline)?), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &scope).await?.space;
                let mut threads = BTreeMap::new();
                let mut rows = Vec::new();
                let mut unique = std::collections::BTreeSet::new();
                for (thread, seq) in candidates {
                    if !unique.insert((thread.clone(), seq)) {
                        continue;
                    }
                    let head = match threads.entry(thread.clone()) {
                        std::collections::btree_map::Entry::Occupied(existing) => {
                            existing.into_mut()
                        }
                        std::collections::btree_map::Entry::Vacant(entry) => {
                            entry.insert(load_thread_head_opt_tx(tx, &space.id, &thread).await?)
                        }
                    };
                    let Some(head) = head else {
                        continue;
                    };
                    let Some(row) = load_entry(tx, &space.id, &thread, seq).await? else {
                        continue;
                    };
                    if !row.searchable()
                        || auth
                            .can_view_chat_thread(
                                &space,
                                head.kind,
                                &head.owner,
                                head.project_folder.as_ref(),
                                row.tainted(),
                            )
                            .is_err()
                        || !reachable(tx, &space.id, &thread, head.head_leaf_seq, &row).await?
                    {
                        continue;
                    }
                    if rows.len() == limit {
                        return Ok((space, rows, true));
                    }
                    rows.push((head.clone(), row));
                }
                Ok((space, rows, false))
            })
        })
        .await
    }

    async fn read_search_chat_text(
        &self,
        scope: &HistoryScope,
        budget: &CallBudget,
        deadline: &CommandDeadline,
        entry: &Entry,
    ) -> Result<Option<String>, PortError> {
        if let Some(text) = &entry.inline_text {
            return Ok(Some(text.clone()));
        }
        let digest = ContentDigest::from_bytes(
            entry
                .payload_blake3
                .as_deref()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| {
                    internal_not_committed("search_chat_payload", "invalid payload digest")
                })?,
        );
        let mut budget = budget.clone();
        budget.remaining = deadline.remaining(&budget)?;
        match self
            .read_verified_blob_with_budget(scope, digest, Some(&budget))
            .await
        {
            Ok(bytes) => Ok(Some(String::from_utf8(bytes).map_err(|_| {
                internal_not_committed("search_chat_payload", "payload is not UTF-8")
            })?)),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn tx_budget(budget: &CallBudget, deadline: &CommandDeadline) -> Result<CallBudget, PortError> {
    let mut budget = budget.clone();
    budget.remaining = deadline.remaining(&budget)?.min(Duration::from_millis(250));
    Ok(budget)
}

async fn active_space(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
) -> Result<SpaceRecord, PortError> {
    let space = load_space_record(tx, &scope.space_id).await?;
    scope.check(&space.scope)?;
    if space.space.lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(space)
}

fn make_hit(
    thread: &ChatThreadId,
    kind: ChatThreadKind,
    project_folder: Option<FolderId>,
    owner: PrincipalId,
    row: &Entry,
    text: String,
) -> Result<HydratedChatHit, PortError> {
    Ok(HydratedChatHit {
        thread: thread.clone(),
        entry: row.seq()?,
        kind,
        project_folder,
        owner,
        author: PrincipalId::parse(&row.author_id)?,
        text,
    })
}

async fn reachable(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    tip: ThreadEntrySeq,
    entry: &Entry,
) -> Result<bool, PortError> {
    let seq = entry.seq()?;
    if seq == tip {
        return Ok(true);
    }
    if seq > tip {
        return Ok(false);
    }
    let depth = u32::try_from(entry.branch_depth)
        .map_err(|_| internal_not_committed("search_chat_depth", "invalid branch depth"))?;
    let Some((tip_depth, _)) = load_entry_depth_and_taint_tx(tx, space, thread, tip).await? else {
        return Ok(false);
    };
    if tip_depth <= depth {
        return Ok(false);
    }
    Ok(jump_to_ancestor_at_depth_tx(tx, space, thread, tip, depth).await? == Some(seq))
}

async fn load_entry(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    seq: ThreadEntrySeq,
) -> Result<Option<Entry>, PortError> {
    const SQL: &str = "SELECT entry_seq, parent_seq, CAST(branch_depth AS BIGINT) AS branch_depth,
        kind, author_id, inline_text, payload_blake3, CAST(checkpoint_stale AS BIGINT) AS checkpoint_stale,
        CAST(ext_space_tainted AS BIGINT) AS ext_space_tainted FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(seq.get() as i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|error| internal_not_committed("sqlite_search_chat_entry", error.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(seq.get() as i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|error| pg_read_error("pg_search_chat_entry", error)),
    }
}

async fn read_chain(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    tip: ThreadEntrySeq,
    limit: PageLimit,
) -> Result<Vec<Entry>, PortError> {
    const SQL: &str = "WITH RECURSIVE chain(entry_seq, parent_seq, hops) AS (
        SELECT entry_seq, parent_seq, 1 FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
        UNION ALL
        SELECT p.entry_seq, p.parent_seq, c.hops + 1 FROM chain c
        JOIN chat_entries p ON p.space_id = $1 AND p.thread_id = $2 AND p.entry_seq = c.parent_seq
        WHERE c.hops < $4
    ) SELECT e.entry_seq, e.parent_seq, CAST(e.branch_depth AS BIGINT) AS branch_depth,
        e.kind, e.author_id, e.inline_text, e.payload_blake3,
        CAST(e.checkpoint_stale AS BIGINT) AS checkpoint_stale,
        CAST(e.ext_space_tainted AS BIGINT) AS ext_space_tainted
        FROM chain c JOIN chat_entries e ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = c.entry_seq
        ORDER BY c.hops";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(tip.get() as i64)
            .bind(i32::from(limit.get()))
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| internal_not_committed("sqlite_search_chat_chain", error.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(tip.get() as i64)
            .bind(i32::from(limit.get()))
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| pg_read_error("pg_search_chat_chain", error)),
    }
}

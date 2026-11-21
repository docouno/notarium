//! Search admission for active chat entries and bounded historical seed pages.

use super::{
    ThreadHeadRow, jump_to_ancestor_at_depth_tx, load_entry_depth_and_taint_tx,
    load_thread_heads_batch_tx,
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
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

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

/// Fast-path classification for incremental chat search indexing between two cuts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchChatDeltaPlan {
    /// Active chain tip, metadata, and redaction/compaction state are unchanged.
    Unchanged,
    /// Active chain strictly extended `stop_at` without redaction or compaction.
    /// Walk from the tip and stop at `stop_at`; no previously indexed entries were removed.
    AppendOnly { stop_at: ThreadEntrySeq },
    /// Thread was created, switched branches, compacted, redacted, or changed metadata;
    /// reconcile the full active chain.
    FullReconcile,
}

#[derive(Clone, sqlx::FromRow)]
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
    fn depth(&self) -> Result<u32, PortError> {
        u32::try_from(self.branch_depth)
            .map_err(|_| internal_not_committed("search_chat_depth", "invalid branch depth"))
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

    /// Classify whether a thread changed in an append-only way between
    /// `previous_cutoff` and `cutoff` so incremental indexing can walk only
    /// newly appended entries instead of re-reading the entire branch.
    pub async fn plan_searchable_chat_delta(
        &self,
        authority: &ServiceAuthority,
        budget: &CallBudget,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        previous_cutoff: SpaceSeq,
        cutoff: SpaceSeq,
    ) -> Result<SearchChatDeltaPlan, PortError> {
        authority.require(ServicePurpose::Search)?;
        let history = scope.clone();
        let key = thread.clone();
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &history).await?;
                let previous_cutoff =
                    validate_snapshot_cutoff_tx(tx, &history, Some(previous_cutoff)).await?;
                let cutoff = validate_snapshot_cutoff_tx(tx, &history, Some(cutoff)).await?;
                if previous_cutoff >= cutoff {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                }
                let Some(prev_rev) = read_immutable_revision_tx(
                    tx,
                    &history,
                    "thread",
                    key.as_str(),
                    previous_cutoff,
                )
                .await?
                else {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                };
                let Some(curr_rev) =
                    read_immutable_revision_tx(tx, &history, "thread", key.as_str(), cutoff)
                        .await?
                else {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                };
                let (
                    RevisionMetadataPayload::Thread(prev_meta),
                    RevisionMetadataPayload::Thread(curr_meta),
                ) = (prev_rev.metadata.payload, curr_rev.metadata.payload)
                else {
                    return Err(internal_not_committed(
                        "search_chat_delta_revision",
                        "expected thread metadata",
                    ));
                };
                if prev_meta.kind != curr_meta.kind
                    || prev_meta.owner_id != curr_meta.owner_id
                    || prev_meta.project_folder_id != curr_meta.project_folder_id
                {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                }
                if thread_has_redaction_or_compaction_after_tx(
                    tx,
                    &space.space.id,
                    &key,
                    previous_cutoff,
                )
                .await?
                {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                }
                if prev_meta.head_leaf_seq == curr_meta.head_leaf_seq {
                    return Ok(SearchChatDeltaPlan::Unchanged);
                }
                if prev_meta.head_leaf_seq == ThreadEntrySeq::ZERO {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                }
                let loaded = load_entries_for_thread_batch_tx(
                    tx,
                    &space.space.id,
                    &key,
                    &[prev_meta.head_leaf_seq, curr_meta.head_leaf_seq],
                )
                .await?;
                let (Some(prev_tip), Some(curr_tip)) = (
                    loaded.get(&prev_meta.head_leaf_seq),
                    loaded.get(&curr_meta.head_leaf_seq),
                ) else {
                    return Ok(SearchChatDeltaPlan::FullReconcile);
                };
                let tip_depth = curr_tip.depth()?;
                if reachable_with_tip_depth(
                    tx,
                    &space.space.id,
                    &key,
                    curr_meta.head_leaf_seq,
                    Some(tip_depth),
                    prev_tip,
                )
                .await?
                {
                    Ok(SearchChatDeltaPlan::AppendOnly {
                        stop_at: prev_meta.head_leaf_seq,
                    })
                } else {
                    Ok(SearchChatDeltaPlan::FullReconcile)
                }
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
        self.read_searchable_chat_entries_page_until(
            authority, budget, scope, thread, cutoff, before, None, limit,
        )
        .await
    }

    /// Walk active chat entries backwards from `before` (defaulting to the
    /// thread's tip at `cutoff`) and stop exclusively before `stop_at`.
    #[allow(clippy::too_many_arguments)]
    pub async fn read_searchable_chat_entries_page_until(
        &self,
        authority: &ServiceAuthority,
        budget: &CallBudget,
        scope: &HistoryScope,
        thread: &ChatThreadId,
        cutoff: SpaceSeq,
        before: Option<ThreadEntrySeq>,
        stop_at: Option<ThreadEntrySeq>,
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
                    if stop_at == Some(tip) {
                        return Ok(Some((
                            meta.kind,
                            meta.project_folder_id,
                            meta.owner_id,
                            Vec::new(),
                            None,
                        )));
                    }
                    let rows = read_chain(tx, &space.space.id, &key, tip, stop_at, limit).await?;
                    let next = rows
                        .last()
                        .and_then(|entry| entry.parent_seq)
                        .map(entry_seq)
                        .transpose()?
                        .filter(|parent| Some(*parent) != stop_at);
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
        if entries.is_empty() {
            return Ok(SearchChatEntriesPage {
                entries,
                next_before,
            });
        }
        let history = scope.clone();
        let key = thread.clone();
        let entries = self
            .with_read_tx_budget(Some(&tx_budget(budget, &deadline)?), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &history).await?;
                    let seqs: Vec<ThreadEntrySeq> = entries.iter().map(|hit| hit.entry).collect();
                    let live =
                        load_entries_for_thread_batch_tx(tx, &space.space.id, &key, &seqs).await?;
                    Ok(entries
                        .into_iter()
                        .filter(|hit| live.get(&hit.entry).is_some_and(Entry::searchable))
                        .collect())
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
        let (_, planned, remaining) = self
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
        let (space, current, truncated) = self
            .recheck_hydrated_chat_hits(ctx, &deadline, keys, remaining)
            .await?;
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
                thread.tainted_mask != 0 || row.tainted(),
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
    ) -> Result<
        (
            Space,
            Vec<(ThreadHeadRow, Entry)>,
            Vec<(ChatThreadId, ThreadEntrySeq)>,
        ),
        PortError,
    > {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        self.with_read_tx_budget(Some(&tx_budget(&ctx.budget, deadline)?), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &scope).await?.space;
                let mut deduped = Vec::with_capacity(candidates.len());
                let mut seen = BTreeSet::new();
                for pair in candidates {
                    if seen.insert(pair.clone()) {
                        deduped.push(pair);
                    }
                }
                let (heads, entries_by_thread) =
                    load_chat_candidates_batch_tx(tx, &space.id, &deduped).await?;
                let mut rows = Vec::new();
                for (index, (thread, seq)) in deduped.iter().enumerate() {
                    if let Some((head, row)) = admit_chat_candidate_tx(
                        tx,
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        thread,
                        *seq,
                    )
                    .await?
                    {
                        if rows.len() == limit {
                            return Ok((space, rows, deduped[index..].to_vec()));
                        }
                        rows.push((head, row));
                    }
                }
                Ok((space, rows, Vec::new()))
            })
        })
        .await
    }

    async fn recheck_hydrated_chat_hits(
        &self,
        ctx: &SpaceContext,
        deadline: &CommandDeadline,
        keys: Vec<(ChatThreadId, ThreadEntrySeq)>,
        remaining: Vec<(ChatThreadId, ThreadEntrySeq)>,
    ) -> Result<(Space, Vec<(ThreadHeadRow, Entry)>, bool), PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        self.with_read_tx_budget(Some(&tx_budget(&ctx.budget, deadline)?), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &scope).await?.space;
                let mut all = Vec::with_capacity(keys.len() + remaining.len());
                let mut seen = BTreeSet::new();
                for pair in keys.iter().chain(remaining.iter()) {
                    if seen.insert(pair.clone()) {
                        all.push(pair.clone());
                    }
                }
                let (heads, entries_by_thread) =
                    load_chat_candidates_batch_tx(tx, &space.id, &all).await?;
                let mut current = Vec::with_capacity(keys.len());
                for (thread, seq) in keys {
                    if let Some(hit) = admit_chat_candidate_tx(
                        tx,
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        &thread,
                        seq,
                    )
                    .await?
                    {
                        current.push(hit);
                    }
                }
                let mut truncated = false;
                for (thread, seq) in remaining {
                    if admit_chat_candidate_tx(
                        tx,
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        &thread,
                        seq,
                    )
                    .await?
                    .is_some()
                    {
                        truncated = true;
                        break;
                    }
                }
                Ok((space, current, truncated))
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

async fn load_chat_candidates_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    candidates: &[(ChatThreadId, ThreadEntrySeq)],
) -> Result<
    (
        BTreeMap<ChatThreadId, ThreadHeadRow>,
        BTreeMap<ChatThreadId, BTreeMap<ThreadEntrySeq, Entry>>,
    ),
    PortError,
> {
    if candidates.is_empty() {
        return Ok((BTreeMap::new(), BTreeMap::new()));
    }
    let mut thread_ids = Vec::new();
    let mut seen_threads = BTreeSet::new();
    for (thread, _) in candidates {
        if seen_threads.insert(thread.clone()) {
            thread_ids.push(thread.clone());
        }
    }
    let heads = load_thread_heads_batch_tx(tx, space_id, &thread_ids).await?;
    let mut seqs_by_thread: BTreeMap<ChatThreadId, BTreeSet<ThreadEntrySeq>> = BTreeMap::new();
    for (thread, seq) in candidates {
        if let Some(head) = heads.get(thread) {
            let set = seqs_by_thread.entry(thread.clone()).or_default();
            set.insert(*seq);
            if head.head_leaf_seq != ThreadEntrySeq::ZERO {
                set.insert(head.head_leaf_seq);
            }
        }
    }
    let mut entries_by_thread = BTreeMap::new();
    for (thread, seqs) in seqs_by_thread {
        let seq_vec: Vec<ThreadEntrySeq> = seqs.into_iter().collect();
        let loaded = load_entries_for_thread_batch_tx(tx, space_id, &thread, &seq_vec).await?;
        entries_by_thread.insert(thread, loaded);
    }
    Ok((heads, entries_by_thread))
}

async fn admit_chat_candidate_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &notarium_core::auth::EngineAuthContext,
    heads: &BTreeMap<ChatThreadId, ThreadHeadRow>,
    entries_by_thread: &BTreeMap<ChatThreadId, BTreeMap<ThreadEntrySeq, Entry>>,
    thread: &ChatThreadId,
    seq: ThreadEntrySeq,
) -> Result<Option<(ThreadHeadRow, Entry)>, PortError> {
    let Some(head) = heads.get(thread) else {
        return Ok(None);
    };
    let Some(entries) = entries_by_thread.get(thread) else {
        return Ok(None);
    };
    let Some(row) = entries.get(&seq) else {
        return Ok(None);
    };
    if !row.searchable() {
        return Ok(None);
    }
    let tainted = head.tainted_mask != 0 || row.tainted();
    if auth
        .can_view_chat_thread(
            space,
            head.kind,
            &head.owner,
            head.project_folder.as_ref(),
            tainted,
        )
        .is_err()
    {
        return Ok(None);
    }
    let tip_depth = entries
        .get(&head.head_leaf_seq)
        .map(Entry::depth)
        .transpose()?;
    if !reachable_with_tip_depth(tx, &space.id, thread, head.head_leaf_seq, tip_depth, row).await? {
        return Ok(None);
    }
    Ok(Some((head.clone(), row.clone())))
}

async fn thread_has_redaction_or_compaction_after_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread: &ChatThreadId,
    after: SpaceSeq,
) -> Result<bool, PortError> {
    const REDACTION_SQL: &str = "SELECT EXISTS (SELECT 1 FROM chat_entries
        WHERE space_id = $1 AND redacted_at_seq IS NOT NULL AND redacted_at_seq > $2 AND thread_id = $3)";
    const COMPACTION_SQL: &str = "SELECT EXISTS (SELECT 1 FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND kind = 'compaction' AND created_space_seq > $3)";
    let after_seq = after.get() as i64;
    let redacted: bool = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(REDACTION_SQL)
            .bind(space_id.as_str())
            .bind(after_seq)
            .bind(thread.as_str())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_search_chat_delta_redact", err.to_string())
            })?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(REDACTION_SQL)
            .bind(space_id.as_str())
            .bind(after_seq)
            .bind(thread.as_str())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_search_chat_delta_redact", err))?,
    };
    if redacted {
        return Ok(true);
    }
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(COMPACTION_SQL)
            .bind(space_id.as_str())
            .bind(thread.as_str())
            .bind(after_seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_search_chat_delta_compact", err.to_string())
            }),
        BackendConn::Postgres(conn) => sqlx::query_scalar(COMPACTION_SQL)
            .bind(space_id.as_str())
            .bind(thread.as_str())
            .bind(after_seq)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_search_chat_delta_compact", err)),
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
    let tip_depth = if entry.seq()? == tip || entry.seq()? > tip {
        None
    } else {
        load_entry_depth_and_taint_tx(tx, space, thread, tip)
            .await?
            .map(|(depth, _)| depth)
    };
    reachable_with_tip_depth(tx, space, thread, tip, tip_depth, entry).await
}

async fn reachable_with_tip_depth(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    tip: ThreadEntrySeq,
    tip_depth: Option<u32>,
    entry: &Entry,
) -> Result<bool, PortError> {
    let seq = entry.seq()?;
    if seq == tip {
        return Ok(true);
    }
    if seq > tip {
        return Ok(false);
    }
    let depth = entry.depth()?;
    let Some(tip_depth) = tip_depth else {
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

async fn load_entries_for_thread_batch_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    seqs: &[ThreadEntrySeq],
) -> Result<BTreeMap<ThreadEntrySeq, Entry>, PortError> {
    let mut out = BTreeMap::new();
    if seqs.is_empty() {
        return Ok(out);
    }
    let rows: Vec<Entry> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(seqs.len());
            for chunk in seqs.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT entry_seq, parent_seq, CAST(branch_depth AS BIGINT) AS branch_depth,
                        kind, author_id, inline_text, payload_blake3,
                        CAST(checkpoint_stale AS BIGINT) AS checkpoint_stale,
                        CAST(ext_space_tainted AS BIGINT) AS ext_space_tainted
                     FROM chat_entries WHERE space_id = ",
                );
                qb.push_bind(space.as_str());
                qb.push(" AND thread_id = ");
                qb.push_bind(thread.as_str());
                qb.push(" AND entry_seq IN (");
                let mut sep = qb.separated(", ");
                for seq in chunk {
                    sep.push_bind(seq.get() as i64);
                }
                qb.push(")");
                let part = qb
                    .build_query_as::<Entry>()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|error| {
                        internal_not_committed(
                            "sqlite_search_chat_entries_batch",
                            error.to_string(),
                        )
                    })?;
                acc.extend(part);
            }
            acc
        }
        BackendConn::Postgres(conn) => {
            const SQL: &str =
                "SELECT entry_seq, parent_seq, CAST(branch_depth AS BIGINT) AS branch_depth,
                kind, author_id, inline_text, payload_blake3,
                CAST(checkpoint_stale AS BIGINT) AS checkpoint_stale,
                CAST(ext_space_tainted AS BIGINT) AS ext_space_tainted
                FROM chat_entries WHERE space_id = $1 AND thread_id = $2 AND entry_seq = ANY($3)";
            let seq_vals: Vec<i64> = seqs.iter().map(|s| s.get() as i64).collect();
            sqlx::query_as(SQL)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(&seq_vals)
                .fetch_all(&mut **conn)
                .await
                .map_err(|error| pg_read_error("pg_search_chat_entries_batch", error))?
        }
    };
    for entry in rows {
        out.insert(entry.seq()?, entry);
    }
    Ok(out)
}

async fn read_chain(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    tip: ThreadEntrySeq,
    stop_at: Option<ThreadEntrySeq>,
    limit: PageLimit,
) -> Result<Vec<Entry>, PortError> {
    const SQL: &str = "WITH RECURSIVE chain(entry_seq, parent_seq, hops) AS (
        SELECT entry_seq, parent_seq, 1 FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3 AND entry_seq <> $5
        UNION ALL
        SELECT p.entry_seq, p.parent_seq, c.hops + 1 FROM chain c
        JOIN chat_entries p ON p.space_id = $1 AND p.thread_id = $2 AND p.entry_seq = c.parent_seq
        WHERE c.hops < $4 AND p.entry_seq <> $5
    ) SELECT e.entry_seq, e.parent_seq, CAST(e.branch_depth AS BIGINT) AS branch_depth,
        e.kind, e.author_id, e.inline_text, e.payload_blake3,
        CAST(e.checkpoint_stale AS BIGINT) AS checkpoint_stale,
        CAST(e.ext_space_tainted AS BIGINT) AS ext_space_tainted
        FROM chain c JOIN chat_entries e ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = c.entry_seq
        ORDER BY c.hops";
    let stop_seq = stop_at.map_or(-1_i64, |seq| seq.get() as i64);
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(tip.get() as i64)
            .bind(i32::from(limit.get()))
            .bind(stop_seq)
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| internal_not_committed("sqlite_search_chat_chain", error.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(thread.as_str())
            .bind(tip.get() as i64)
            .bind(i32::from(limit.get()))
            .bind(stop_seq)
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| pg_read_error("pg_search_chat_chain", error)),
    }
}

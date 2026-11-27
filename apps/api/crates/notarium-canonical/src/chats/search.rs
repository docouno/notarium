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

/// The current audience, reachable keys and their branch taint share one canonical read.
pub struct SearchDeliveryAdmission {
    pub space: Space,
    pub head: SpaceSeq,
    pub entries: BTreeMap<(ChatThreadId, ThreadEntrySeq), bool>,
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
    body_format: i32,
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

#[derive(sqlx::FromRow)]
struct BatchEntry {
    thread_id: String,
    entry_seq: i64,
    parent_seq: Option<i64>,
    branch_depth: i64,
    kind: String,
    author_id: String,
    body_format: i32,
    inline_text: Option<String>,
    payload_blake3: Option<Vec<u8>>,
    checkpoint_stale: i64,
    ext_space_tainted: i64,
}
impl BatchEntry {
    fn into_parts(self) -> Result<(ChatThreadId, Entry), PortError> {
        Ok((
            ChatThreadId::parse(&self.thread_id)?,
            Entry {
                entry_seq: self.entry_seq,
                parent_seq: self.parent_seq,
                branch_depth: self.branch_depth,
                kind: self.kind,
                author_id: self.author_id,
                body_format: self.body_format,
                inline_text: self.inline_text,
                payload_blake3: self.payload_blake3,
                checkpoint_stale: self.checkpoint_stale,
                ext_space_tainted: self.ext_space_tainted,
            },
        ))
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
                    cutoff,
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
        let planned = self
            .plan_chat_hits(ctx, &deadline, candidates.to_vec(), candidates.len())
            .await?;
        planned
            .rows
            .into_iter()
            .map(|(thread, entry)| Ok((thread.thread_id, entry.seq()?)))
            .collect()
    }

    /// Recheck the supplied keys for final delivery without recording a read.
    pub async fn admit_search_delivery(
        &self,
        authority: &ServiceAuthority,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
    ) -> Result<SearchDeliveryAdmission, PortError> {
        authority.require(ServicePurpose::Search)?;
        if candidates.len() > 200 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        if candidates.is_empty() {
            let record = self
                .read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
                .await?;
            ctx.check_current(&record.scope)?;
            if record.space.lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            return Ok(SearchDeliveryAdmission {
                space: record.space,
                head: record.last_seq,
                entries: BTreeMap::new(),
            });
        }
        let deadline = CommandDeadline::start(&ctx.budget, "admit_search_delivery");
        let planned = self
            .plan_chat_hits(ctx, &deadline, candidates.to_vec(), candidates.len())
            .await?;
        let entries = planned
            .rows
            .into_iter()
            .map(|(thread, entry)| {
                Ok((
                    (thread.thread_id, entry.seq()?),
                    thread.tainted_mask != 0 || entry.tainted(),
                ))
            })
            .collect::<Result<_, PortError>>()?;
        Ok(SearchDeliveryAdmission {
            space: planned.space,
            head: planned.head,
            entries,
        })
    }

    pub async fn hydrate_live_visible_chat_hits(
        &self,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> Result<(Vec<HydratedChatHit>, bool), PortError> {
        let page = self.hydrate_chat_candidates(ctx, candidates, limit).await?;
        if !page.hits.is_empty() {
            ctx.auth().mark_chat_read_taint(&page.space, page.tainted);
        }
        Ok((page.hits, page.truncated))
    }

    /// Prepare authorized snippets for the search service. Disclosure and its
    /// branch taint are committed only when the service delivers its final page.
    pub async fn prepare_search_chat_hits(
        &self,
        authority: &ServiceAuthority,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> Result<(Vec<HydratedChatHit>, bool), PortError> {
        authority.require(ServicePurpose::Search)?;
        let page = self.hydrate_chat_candidates(ctx, candidates, limit).await?;
        Ok((page.hits, page.truncated))
    }

    async fn hydrate_chat_candidates(
        &self,
        ctx: &SpaceContext,
        candidates: &[(ChatThreadId, ThreadEntrySeq)],
        limit: PageLimit,
    ) -> Result<HydratedChatPage, PortError> {
        // One additional candidate witnesses truncation at the largest page limit.
        if candidates.len() > 201 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let deadline = CommandDeadline::start(&ctx.budget, "hydrate_search_chat");
        let max = usize::from(limit.get());
        let planned = self
            .plan_chat_hits(ctx, &deadline, candidates.to_vec(), max)
            .await?;
        let mut hydrated = BTreeMap::new();
        let mut keys = Vec::new();
        for (thread, row) in planned.rows {
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
            .recheck_hydrated_chat_hits(
                ctx,
                &deadline,
                keys,
                planned.remaining,
                planned.verified_tips,
            )
            .await?;
        let mut hits = Vec::with_capacity(current.len());
        let mut any_tainted = false;
        for (thread, row) in current {
            let Some(text) = hydrated.remove(&(thread.thread_id.clone(), row.seq()?)) else {
                continue;
            };
            any_tainted |= thread.tainted_mask != 0 || row.tainted();
            hits.push(make_hit(
                &thread.thread_id,
                thread.kind,
                thread.project_folder,
                thread.owner,
                &row,
                text,
            )?);
        }
        Ok(HydratedChatPage {
            space,
            hits,
            truncated,
            tainted: any_tainted,
        })
    }

    async fn plan_chat_hits(
        &self,
        ctx: &SpaceContext,
        deadline: &CommandDeadline,
        candidates: Vec<(ChatThreadId, ThreadEntrySeq)>,
        limit: usize,
    ) -> Result<PlannedChatHits, PortError> {
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        self.with_read_tx_budget(Some(&tx_budget(&ctx.budget, deadline)?), |tx| {
            Box::pin(async move {
                let record = active_space(tx, &scope).await?;
                let space = record.space;
                let mut deduped = Vec::with_capacity(candidates.len());
                let mut seen = BTreeSet::new();
                for pair in candidates {
                    if seen.insert(pair.clone()) {
                        deduped.push(pair);
                    }
                }
                let (heads, entries_by_thread) =
                    load_chat_candidates_batch_tx(tx, &space.id, &deduped).await?;
                let mut prefiltered = Vec::with_capacity(deduped.len());
                let mut jump_set = BTreeSet::new();
                let mut verified_count = 0usize;
                for (index, candidate) in deduped.iter().enumerate() {
                    if let Some((head, row, reach)) = prefilter_chat_candidate(
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        None,
                        candidate,
                    )? {
                        match reach {
                            ReachCheck::Verified => {
                                verified_count += 1;
                            }
                            ReachCheck::NeedsJump { tip, depth } => {
                                jump_set.insert((candidate.0.clone(), tip, depth));
                            }
                        }
                        prefiltered.push((index, head, row, reach));
                        if verified_count > limit {
                            break;
                        }
                    }
                }
                let jump_requests: Vec<_> = jump_set.into_iter().collect();
                let landed =
                    jump_to_ancestors_at_depth_batch_tx(tx, &space.id, &jump_requests).await?;
                let mut rows = Vec::new();
                let mut verified_tips = BTreeMap::new();
                for (index, head, row, reach) in prefiltered {
                    let seq = row.seq()?;
                    let is_reachable = match reach {
                        ReachCheck::Verified => true,
                        ReachCheck::NeedsJump { tip, depth } => {
                            landed.get(&(head.thread_id.clone(), tip, depth)) == Some(&seq)
                        }
                    };
                    if !is_reachable {
                        continue;
                    }
                    verified_tips.insert((head.thread_id.clone(), seq), head.head_leaf_seq);
                    if rows.len() == limit {
                        return Ok(PlannedChatHits {
                            space,
                            head: record.last_seq,
                            rows,
                            remaining: deduped[index..].to_vec(),
                            verified_tips,
                        });
                    }
                    rows.push((head, row));
                }
                Ok(PlannedChatHits {
                    space,
                    head: record.last_seq,
                    rows,
                    remaining: Vec::new(),
                    verified_tips,
                })
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
        verified_tips: BTreeMap<(ChatThreadId, ThreadEntrySeq), ThreadEntrySeq>,
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
                let mut jump_set = BTreeSet::new();
                let mut key_candidates = Vec::with_capacity(keys.len());
                for candidate in &keys {
                    if let Some((head, row, reach)) = prefilter_chat_candidate(
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        Some(&verified_tips),
                        candidate,
                    )? {
                        if let ReachCheck::NeedsJump { tip, depth } = reach {
                            jump_set.insert((candidate.0.clone(), tip, depth));
                        }
                        key_candidates.push((head, row, reach));
                    }
                }
                let mut truncated_verified = false;
                let mut remaining_jumps = Vec::new();
                for candidate in &remaining {
                    if let Some((head, row, reach)) = prefilter_chat_candidate(
                        &space,
                        &auth,
                        &heads,
                        &entries_by_thread,
                        Some(&verified_tips),
                        candidate,
                    )? {
                        match reach {
                            ReachCheck::Verified => {
                                truncated_verified = true;
                                break;
                            }
                            ReachCheck::NeedsJump { tip, depth } => {
                                remaining_jumps.push((head, row, tip, depth));
                            }
                        }
                    }
                }
                if !truncated_verified {
                    for (head, _, tip, depth) in &remaining_jumps {
                        jump_set.insert((head.thread_id.clone(), *tip, *depth));
                    }
                }
                let jump_requests: Vec<_> = jump_set.into_iter().collect();
                let landed =
                    jump_to_ancestors_at_depth_batch_tx(tx, &space.id, &jump_requests).await?;
                let mut current = Vec::with_capacity(key_candidates.len());
                for (head, row, reach) in key_candidates {
                    let seq = row.seq()?;
                    let is_reachable = match reach {
                        ReachCheck::Verified => true,
                        ReachCheck::NeedsJump { tip, depth } => {
                            landed.get(&(head.thread_id.clone(), tip, depth)) == Some(&seq)
                        }
                    };
                    if is_reachable {
                        current.push((head, row));
                    }
                }
                let mut truncated = truncated_verified;
                if !truncated {
                    for (head, row, tip, depth) in remaining_jumps {
                        let seq = row.seq()?;
                        if landed.get(&(head.thread_id, tip, depth)) == Some(&seq) {
                            truncated = true;
                            break;
                        }
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
        let visible_text = |body| {
            super::content::decode_turn(entry.body_format, &entry.kind, body)
                .map(|turn| Some(turn.text))
        };
        if let Some(text) = &entry.inline_text {
            return visible_text(text.clone());
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
            Ok(bytes) => visible_text(String::from_utf8(bytes).map_err(|_| {
                internal_not_committed("search_chat_payload", "payload is not UTF-8")
            })?),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

struct HydratedChatPage {
    space: Space,
    hits: Vec<HydratedChatHit>,
    truncated: bool,
    tainted: bool,
}

struct PlannedChatHits {
    space: Space,
    head: SpaceSeq,
    rows: Vec<(ThreadHeadRow, Entry)>,
    remaining: Vec<(ChatThreadId, ThreadEntrySeq)>,
    verified_tips: BTreeMap<(ChatThreadId, ThreadEntrySeq), ThreadEntrySeq>,
}

#[derive(Clone, Copy)]
enum ReachCheck {
    Verified,
    NeedsJump { tip: ThreadEntrySeq, depth: u32 },
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
    let mut entry_pairs = BTreeSet::new();
    for (thread, seq) in candidates {
        if let Some(head) = heads.get(thread) {
            entry_pairs.insert((thread.clone(), *seq));
            if head.head_leaf_seq != ThreadEntrySeq::ZERO {
                entry_pairs.insert((thread.clone(), head.head_leaf_seq));
            }
        }
    }
    let pairs: Vec<_> = entry_pairs.into_iter().collect();
    let entries_by_thread = load_entries_batch_tx(tx, space_id, &pairs).await?;
    Ok((heads, entries_by_thread))
}

fn prefilter_chat_candidate(
    space: &Space,
    auth: &notarium_core::auth::EngineAuthContext,
    heads: &BTreeMap<ChatThreadId, ThreadHeadRow>,
    entries_by_thread: &BTreeMap<ChatThreadId, BTreeMap<ThreadEntrySeq, Entry>>,
    verified_tips: Option<&BTreeMap<(ChatThreadId, ThreadEntrySeq), ThreadEntrySeq>>,
    candidate: &(ChatThreadId, ThreadEntrySeq),
) -> Result<Option<(ThreadHeadRow, Entry, ReachCheck)>, PortError> {
    let (thread, seq) = candidate;
    let Some(head) = heads.get(thread) else {
        return Ok(None);
    };
    let Some(entries) = entries_by_thread.get(thread) else {
        return Ok(None);
    };
    let Some(row) = entries.get(seq) else {
        return Ok(None);
    };
    if !row.searchable() {
        return Ok(None);
    }
    let tainted = head.tainted_mask != 0 || row.tainted();
    if auth
        .can_view_chat_thread(
            space,
            thread,
            head.kind,
            &head.owner,
            head.project_folder.as_ref(),
            tainted,
        )
        .is_err()
    {
        return Ok(None);
    }
    let tip = head.head_leaf_seq;
    let reach =
        if *seq == tip || verified_tips.is_some_and(|tips| tips.get(candidate) == Some(&tip)) {
            ReachCheck::Verified
        } else if *seq > tip {
            return Ok(None);
        } else {
            let depth = row.depth()?;
            let Some(tip_depth) = entries.get(&tip).map(Entry::depth).transpose()? else {
                return Ok(None);
            };
            if tip_depth <= depth {
                return Ok(None);
            }
            ReachCheck::NeedsJump { tip, depth }
        };
    Ok(Some((head.clone(), row.clone(), reach)))
}

async fn load_entries_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    pairs: &[(ChatThreadId, ThreadEntrySeq)],
) -> Result<BTreeMap<ChatThreadId, BTreeMap<ThreadEntrySeq, Entry>>, PortError> {
    let mut out: BTreeMap<ChatThreadId, BTreeMap<ThreadEntrySeq, Entry>> = BTreeMap::new();
    if pairs.is_empty() {
        return Ok(out);
    }
    let rows: Vec<BatchEntry> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(pairs.len());
            for chunk in pairs.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new("WITH keys(t, s) AS (VALUES ");
                let mut sep = qb.separated(", ");
                for (thread, seq) in chunk {
                    sep.push("(");
                    sep.push_bind_unseparated(thread.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(seq.get() as i64);
                    sep.push_unseparated(")");
                }
                qb.push(
                    ") SELECT e.thread_id, e.entry_seq, e.parent_seq,
                             CAST(e.branch_depth AS BIGINT) AS branch_depth,
                             e.kind, e.author_id, e.body_format, e.inline_text, e.payload_blake3,
                             CAST(e.checkpoint_stale AS BIGINT) AS checkpoint_stale,
                             CAST(e.ext_space_tainted AS BIGINT) AS ext_space_tainted
                      FROM keys
                      JOIN chat_entries e
                        ON e.space_id = ",
                );
                qb.push_bind(space_id.as_str())
                    .push(" AND e.thread_id = keys.t AND e.entry_seq = keys.s");
                let part = qb
                    .build_query_as::<BatchEntry>()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|error| {
                        internal_not_committed(
                            "sqlite_search_chat_entries_pairs_batch",
                            error.to_string(),
                        )
                    })?;
                acc.extend(part);
            }
            acc
        }
        BackendConn::Postgres(conn) => {
            const SQL: &str = "SELECT e.thread_id, e.entry_seq, e.parent_seq,
                        CAST(e.branch_depth AS BIGINT) AS branch_depth,
                        e.kind, e.author_id, e.body_format, e.inline_text, e.payload_blake3,
                        CAST(e.checkpoint_stale AS BIGINT) AS checkpoint_stale,
                        CAST(e.ext_space_tainted AS BIGINT) AS ext_space_tainted
                 FROM UNNEST($2::text[], $3::bigint[]) AS k(t, s)
                 JOIN chat_entries e
                   ON e.space_id = $1 AND e.thread_id = k.t AND e.entry_seq = k.s";
            let threads: Vec<&str> = pairs.iter().map(|(t, _)| t.as_str()).collect();
            let seqs: Vec<i64> = pairs.iter().map(|(_, s)| s.get() as i64).collect();
            sqlx::query_as(SQL)
                .bind(space_id.as_str())
                .bind(&threads)
                .bind(&seqs)
                .fetch_all(&mut **conn)
                .await
                .map_err(|error| pg_read_error("pg_search_chat_entries_pairs_batch", error))?
        }
    };
    for row in rows {
        let (thread, entry) = row.into_parts()?;
        let seq = entry.seq()?;
        out.entry(thread).or_default().insert(seq, entry);
    }
    Ok(out)
}

async fn jump_to_ancestors_at_depth_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    requests: &[(ChatThreadId, ThreadEntrySeq, u32)],
) -> Result<BTreeMap<(ChatThreadId, ThreadEntrySeq, u32), ThreadEntrySeq>, PortError> {
    let mut out = BTreeMap::new();
    if requests.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, i64, i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(requests.len());
            for chunk in requests.chunks(100) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "WITH RECURSIVE reqs(thread_id, start_seq, target_depth) AS (VALUES ",
                );
                let mut sep = qb.separated(", ");
                for (thread, start, depth) in chunk {
                    sep.push("(");
                    sep.push_bind_unseparated(thread.as_str());
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(start.get() as i64);
                    sep.push_unseparated(", ");
                    sep.push_bind_unseparated(i64::from(*depth));
                    sep.push_unseparated(")");
                }
                qb.push(
                    "), jump(thread_id, start_seq, target_depth, entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
                         SELECT r.thread_id, r.start_seq, r.target_depth,
                                e.entry_seq, e.branch_depth, e.parent_seq, e.anc_16_seq, e.anc_256_seq, 0
                         FROM reqs r
                         JOIN chat_entries e
                           ON e.space_id = ",
                );
                qb.push_bind(space_id.as_str());
                qb.push(
                    " AND e.thread_id = r.thread_id AND e.entry_seq = r.start_seq
                         UNION ALL
                         SELECT j.thread_id, j.start_seq, j.target_depth,
                                e.entry_seq, e.branch_depth, e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
                         FROM jump j
                         JOIN chat_entries e
                           ON e.space_id = ",
                );
                qb.push_bind(space_id.as_str());
                qb.push(
                    " AND e.thread_id = j.thread_id
                          AND e.entry_seq = CASE
                              WHEN j.branch_depth - j.target_depth >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                              WHEN j.branch_depth - j.target_depth >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                              ELSE j.parent_seq
                          END
                         WHERE j.branch_depth > j.target_depth AND j.hops < 100000
                     )
                     SELECT thread_id, start_seq, target_depth, entry_seq
                     FROM jump
                     WHERE branch_depth = target_depth",
                );
                let part = qb
                    .build_query_as::<(String, i64, i64, i64)>()
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|error| {
                        internal_not_committed("sqlite_jump_ancestors_batch", error.to_string())
                    })?;
                acc.extend(part);
            }
            acc
        }
        BackendConn::Postgres(conn) => {
            const SQL: &str =
                "WITH RECURSIVE reqs(thread_id, start_seq, target_depth) AS (
                     SELECT t, s, d
                     FROM UNNEST($2::text[], $3::bigint[], $4::bigint[]) AS k(t, s, d)
                 ),
                 jump(thread_id, start_seq, target_depth, entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
                     SELECT r.thread_id, r.start_seq, r.target_depth,
                            e.entry_seq, e.branch_depth::BIGINT, e.parent_seq, e.anc_16_seq, e.anc_256_seq, 0::BIGINT
                     FROM reqs r
                     JOIN chat_entries e
                       ON e.space_id = $1 AND e.thread_id = r.thread_id AND e.entry_seq = r.start_seq
                     UNION ALL
                     SELECT j.thread_id, j.start_seq, j.target_depth,
                            e.entry_seq, e.branch_depth::BIGINT, e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
                     FROM jump j
                     JOIN chat_entries e
                       ON e.space_id = $1
                      AND e.thread_id = j.thread_id
                      AND e.entry_seq = CASE
                          WHEN j.branch_depth - j.target_depth >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                          WHEN j.branch_depth - j.target_depth >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                          ELSE j.parent_seq
                      END
                     WHERE j.branch_depth > j.target_depth AND j.hops < 100000
                 )
                 SELECT thread_id, start_seq, target_depth, entry_seq
                 FROM jump
                 WHERE branch_depth = target_depth";
            let threads: Vec<&str> = requests.iter().map(|(t, _, _)| t.as_str()).collect();
            let starts: Vec<i64> = requests.iter().map(|(_, s, _)| s.get() as i64).collect();
            let targets: Vec<i64> = requests.iter().map(|(_, _, d)| i64::from(*d)).collect();
            sqlx::query_as(SQL)
                .bind(space_id.as_str())
                .bind(&threads)
                .bind(&starts)
                .bind(&targets)
                .fetch_all(&mut **conn)
                .await
                .map_err(|error| pg_read_error("pg_jump_ancestors_batch", error))?
        }
    };
    for (thread_raw, start_raw, depth_raw, landed_raw) in rows {
        let thread = ChatThreadId::parse(&thread_raw)?;
        let start = entry_seq(start_raw)?;
        let depth = u32::try_from(depth_raw).map_err(|_| {
            internal_not_committed("search_chat_depth", "invalid target branch depth")
        })?;
        let landed = entry_seq(landed_raw)?;
        out.insert((thread, start, depth), landed);
    }
    Ok(out)
}

async fn thread_has_redaction_or_compaction_after_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread: &ChatThreadId,
    after: SpaceSeq,
    through: SpaceSeq,
) -> Result<bool, PortError> {
    const REDACTION_SQL: &str = "SELECT EXISTS (SELECT 1 FROM chat_entries
        WHERE space_id = $1 AND redacted_at_seq IS NOT NULL AND redacted_at_seq > $2 AND thread_id = $3)";
    const COMPACTION_SQLITE_SQL: &str = "SELECT EXISTS (SELECT 1 FROM chat_entries INDEXED BY idx_chat_entries_compaction
        WHERE space_id = $1 AND thread_id = $2 AND kind = 'compaction' AND created_space_seq > $3 AND created_space_seq <= $4)";
    const COMPACTION_PG_SQL: &str = "SELECT EXISTS (SELECT 1 FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND kind = 'compaction' AND created_space_seq > $3 AND created_space_seq <= $4)";
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
        BackendConn::Sqlite(conn) => sqlx::query_scalar(COMPACTION_SQLITE_SQL)
            .bind(space_id.as_str())
            .bind(thread.as_str())
            .bind(after_seq)
            .bind(through.get() as i64)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_search_chat_delta_compact", err.to_string())
            }),
        BackendConn::Postgres(conn) => sqlx::query_scalar(COMPACTION_PG_SQL)
            .bind(space_id.as_str())
            .bind(thread.as_str())
            .bind(after_seq)
            .bind(through.get() as i64)
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
        kind, author_id, body_format, inline_text, payload_blake3, CAST(checkpoint_stale AS BIGINT) AS checkpoint_stale,
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
                        kind, author_id, body_format, inline_text, payload_blake3,
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
                kind, author_id, body_format, inline_text, payload_blake3,
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
    const SQL: &str = "WITH RECURSIVE chain(
        entry_seq, parent_seq, branch_depth, kind, author_id, body_format,
        inline_text, payload_blake3, checkpoint_stale, ext_space_tainted, hops
    ) AS (
        SELECT entry_seq, parent_seq, CAST(branch_depth AS BIGINT), kind, author_id, body_format,
               inline_text, payload_blake3, CAST(checkpoint_stale AS BIGINT), CAST(ext_space_tainted AS BIGINT), 1
        FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3 AND entry_seq <> $5
        UNION ALL
        SELECT p.entry_seq, p.parent_seq, CAST(p.branch_depth AS BIGINT), p.kind, p.author_id, p.body_format,
               p.inline_text, p.payload_blake3, CAST(p.checkpoint_stale AS BIGINT), CAST(p.ext_space_tainted AS BIGINT), c.hops + 1
        FROM chain c
        CROSS JOIN chat_entries p
        WHERE c.hops < $4
          AND p.space_id = $1 AND p.thread_id = $2 AND p.entry_seq = c.parent_seq
          AND p.entry_seq <> $5
    ) SELECT entry_seq, parent_seq, branch_depth, kind, author_id, body_format,
             inline_text, payload_blake3, checkpoint_stale, ext_space_tainted
      FROM chain";
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

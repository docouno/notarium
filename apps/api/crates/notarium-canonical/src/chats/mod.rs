use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, Space, SpaceKind, SpaceLifecycle, SpaceRole},
    error::{PortError, ValidationReason},
    ids::{
        AgentRunId, ChatThreadId, CommandKey, ContentDigest, FolderId, PendingInputId, PrincipalId,
        RevisionId, SpaceId, SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, Lifecycle, NoteRef},
    ports::{
        AppendChat, ChatBody, ChatBranch, ChatEntry, ChatEntryKind, ChatInputBody, ChatPort,
        ChatRead, ChatThread, ChatThreadKind, Committed, ConsumePending, ConsumedPending,
        CreateChat, ForkChat, Mutation, PendingChatInput, PortFuture, Preconditions,
        QueueInputOutcome, QueuedInput, RedactChatEntry, RedactedChat, SpaceContext,
        StagedChatBlob,
    },
    receipt::MutationReceiptToken,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, PreparedBlobSource, RetirementReason,
        activate_and_bind_blob_ref_tx, bind_existing_active_blob_ref_tx, count_reachable_refs_tx,
        release_owner_blob_refs_tx,
    },
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        RevisionMetadataEnvelope, RevisionMetadataPayload, ThreadRevisionMetadata,
        chat_thread_kind_from_db, chat_thread_kind_to_db, encode_timestamp_parts,
        internal_not_committed, new_prefixed_hex_id, new_revision_id, now_unix_ms,
        now_utc_timestamp,
    },
    domain::{
        common::{
            FolderAncestryCache, derive_command_identity_spec, extract_agent_run_from_auth,
            load_note_head_row_tx, upsert_agent_run_head_tx, validate_mutation_identity,
        },
        notes::try_replay_completed_receipt,
    },
    runtime::{
        insert_revision_row, is_note_purge_fenced_tx, load_folder_head_row, load_space_record,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

pub const PENDING_CHAT_QUEUE_LIMIT: u8 = 16;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredChatThreadV1 {
    id: ChatThreadId,
    space: SpaceId,
    kind: ChatThreadKind,
    owner: PrincipalId,
    project_folder: Option<FolderId>,
    head: ThreadEntrySeq,
    revision: RevisionId,
    tainted: bool,
}

impl From<&ChatThread> for StoredChatThreadV1 {
    fn from(t: &ChatThread) -> Self {
        Self {
            id: t.id.clone(),
            space: t.space.clone(),
            kind: t.kind,
            owner: t.owner.clone(),
            project_folder: t.project_folder.clone(),
            head: t.head,
            revision: t.revision.clone(),
            tainted: t.tainted,
        }
    }
}

impl From<StoredChatThreadV1> for ChatThread {
    fn from(s: StoredChatThreadV1) -> Self {
        Self {
            id: s.id,
            space: s.space,
            kind: s.kind,
            owner: s.owner,
            project_folder: s.project_folder,
            head: s.head,
            revision: s.revision,
            tainted: s.tainted,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedChatThreadV1 {
    value: StoredChatThreadV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedChatThreadV1 {
    fn into_committed(self) -> Committed<ChatThread> {
        Committed {
            value: self.value.into(),
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum StoredChatEntryKindV1 {
    Human,
    Model,
    Tool { call_id: CommandKey },
    Compaction,
    Redacted,
}

impl From<&ChatEntryKind> for StoredChatEntryKindV1 {
    fn from(k: &ChatEntryKind) -> Self {
        match k {
            ChatEntryKind::Human => Self::Human,
            ChatEntryKind::Model => Self::Model,
            ChatEntryKind::Tool { call_id } => Self::Tool {
                call_id: call_id.clone(),
            },
            ChatEntryKind::Compaction => Self::Compaction,
            ChatEntryKind::Redacted => Self::Redacted,
        }
    }
}

impl From<StoredChatEntryKindV1> for ChatEntryKind {
    fn from(k: StoredChatEntryKindV1) -> Self {
        match k {
            StoredChatEntryKindV1::Human => Self::Human,
            StoredChatEntryKindV1::Model => Self::Model,
            StoredChatEntryKindV1::Tool { call_id } => Self::Tool { call_id },
            StoredChatEntryKindV1::Compaction => Self::Compaction,
            StoredChatEntryKindV1::Redacted => Self::Redacted,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum StoredChatBodyV1 {
    Inline(String),
    Blob(ContentDigest),
    Redacted,
}

impl From<&ChatBody> for StoredChatBodyV1 {
    fn from(b: &ChatBody) -> Self {
        match b {
            ChatBody::Inline(s) => Self::Inline(s.clone()),
            ChatBody::Blob(d) => Self::Blob(*d),
            ChatBody::Redacted => Self::Redacted,
        }
    }
}

impl From<StoredChatBodyV1> for ChatBody {
    fn from(b: StoredChatBodyV1) -> Self {
        match b {
            StoredChatBodyV1::Inline(s) => Self::Inline(s),
            StoredChatBodyV1::Blob(d) => Self::Blob(d),
            StoredChatBodyV1::Redacted => Self::Redacted,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredChatEntryV1 {
    thread: ChatThreadId,
    seq: ThreadEntrySeq,
    parent: Option<ThreadEntrySeq>,
    is_chain_node: bool,
    depth: u32,
    ancestors: Vec<ThreadEntrySeq>,
    author: PrincipalId,
    run: Option<AgentRunId>,
    kind: StoredChatEntryKindV1,
    body: StoredChatBodyV1,
    tainted: bool,
    referenced_notes: Vec<NoteRef>,
}

impl From<&ChatEntry> for StoredChatEntryV1 {
    fn from(e: &ChatEntry) -> Self {
        Self {
            thread: e.thread.clone(),
            seq: e.seq,
            parent: e.parent,
            is_chain_node: e.is_chain_node,
            depth: e.depth,
            ancestors: e.ancestors.clone(),
            author: e.author.clone(),
            run: e.run.clone(),
            kind: (&e.kind).into(),
            body: (&e.body).into(),
            tainted: e.tainted,
            referenced_notes: e.referenced_notes.clone(),
        }
    }
}

impl From<StoredChatEntryV1> for ChatEntry {
    fn from(s: StoredChatEntryV1) -> Self {
        Self {
            thread: s.thread,
            seq: s.seq,
            parent: s.parent,
            is_chain_node: s.is_chain_node,
            depth: s.depth,
            ancestors: s.ancestors,
            author: s.author,
            run: s.run,
            kind: s.kind.into(),
            body: s.body.into(),
            tainted: s.tainted,
            referenced_notes: s.referenced_notes,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedChatEntryV1 {
    value: StoredChatEntryV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedChatEntryV1 {
    fn into_committed(self) -> Committed<ChatEntry> {
        Committed {
            value: self.value.into(),
            receipt: self.receipt,
        }
    }

    fn sanitized_for_redaction(&self) -> Self {
        let mut copy = self.clone();
        copy.value.is_chain_node = true;
        copy.value.kind = StoredChatEntryKindV1::Redacted;
        copy.value.body = StoredChatBodyV1::Redacted;
        copy.value.referenced_notes = Vec::new();
        copy
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredQueuedInputV1 {
    input: PendingInputId,
    position: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedQueuedInputV1 {
    value: StoredQueuedInputV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedQueuedInputV1 {
    fn into_committed(self) -> Committed<QueuedInput> {
        Committed {
            value: QueuedInput {
                input: self.value.input,
                position: self.value.position,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum StoredConsumedPendingV1 {
    Appended(StoredChatEntryV1),
    AlreadyConsumed,
    BranchChanged {
        queued: ThreadEntrySeq,
        current: ThreadEntrySeq,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedConsumedPendingV1 {
    value: StoredConsumedPendingV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedConsumedPendingV1 {
    fn into_committed(self) -> Committed<ConsumedPending> {
        let val = match self.value {
            StoredConsumedPendingV1::Appended(e) => ConsumedPending::Appended(e.into()),
            StoredConsumedPendingV1::AlreadyConsumed => ConsumedPending::AlreadyConsumed,
            StoredConsumedPendingV1::BranchChanged { queued, current } => {
                ConsumedPending::BranchChanged { queued, current }
            }
        };
        Committed {
            value: val,
            receipt: self.receipt,
        }
    }

    fn sanitized_for_redaction(&self) -> Self {
        match &self.value {
            StoredConsumedPendingV1::Appended(e) => {
                let mut copy = e.clone();
                copy.is_chain_node = true;
                copy.kind = StoredChatEntryKindV1::Redacted;
                copy.body = StoredChatBodyV1::Redacted;
                copy.referenced_notes = Vec::new();
                Self {
                    value: StoredConsumedPendingV1::Appended(copy),
                    receipt: self.receipt.clone(),
                }
            }
            _ => self.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredRedactedChatV1 {
    thread: ChatThreadId,
    entry: ThreadEntrySeq,
    parent: Option<ThreadEntrySeq>,
    invalidated_contexts: Vec<ThreadEntrySeq>,
    #[serde(default)]
    zero_ref_digests: Vec<ContentDigest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedRedactedChatV1 {
    value: StoredRedactedChatV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedRedactedChatV1 {
    fn into_committed(self) -> (Committed<RedactedChat>, Vec<ContentDigest>) {
        let zero_refs = self.value.zero_ref_digests;
        (
            Committed {
                value: RedactedChat {
                    thread: self.value.thread,
                    entry: self.value.entry,
                    parent: self.value.parent,
                    invalidated_contexts: self.value.invalidated_contexts,
                },
                receipt: self.receipt,
            },
            zero_refs,
        )
    }
}

impl ChatPort for CanonicalStore {
    fn read_chat(&self, ctx: SpaceContext, request: ChatRead) -> PortFuture<'_, ChatBranch> {
        let store = self.clone();
        Box::pin(async move { read_chat_impl(&store, ctx, request).await })
    }

    fn create_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<CreateChat>,
    ) -> PortFuture<'_, Committed<ChatThread>> {
        let store = self.clone();
        Box::pin(async move { create_chat_impl(&store, ctx, request).await })
    }

    fn fork_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<ForkChat>,
    ) -> PortFuture<'_, Committed<ChatThread>> {
        let store = self.clone();
        Box::pin(async move { fork_chat_impl(&store, ctx, request).await })
    }

    fn append_chat(
        &self,
        ctx: SpaceContext,
        request: Mutation<AppendChat>,
    ) -> PortFuture<'_, Committed<ChatEntry>> {
        let store = self.clone();
        Box::pin(async move { append_chat_impl(&store, ctx, request).await })
    }

    fn queue_chat_input(
        &self,
        ctx: SpaceContext,
        request: Mutation<PendingChatInput>,
    ) -> PortFuture<'_, QueueInputOutcome> {
        let store = self.clone();
        Box::pin(async move { queue_chat_input_impl(&store, ctx, request).await })
    }

    fn consume_chat_input(
        &self,
        ctx: SpaceContext,
        request: Mutation<ConsumePending>,
    ) -> PortFuture<'_, Committed<ConsumedPending>> {
        let store = self.clone();
        Box::pin(async move { consume_chat_input_impl(&store, ctx, request).await })
    }

    fn redact_chat_entry(
        &self,
        ctx: SpaceContext,
        request: Mutation<RedactChatEntry>,
    ) -> PortFuture<'_, Committed<RedactedChat>> {
        let store = self.clone();
        Box::pin(async move { redact_chat_entry_impl(&store, ctx, request).await })
    }
}

impl CanonicalStore {
    /// Stages a chat message body exceeding `StagedChatBlob::INLINE_MAX_BYTES` (`512` UTF-8 bytes)
    /// in this Space's CAS and records a durable per-author staging reference so arbitrary unowned
    /// digests cannot be attached via `ChatInputBody::Staged`.
    pub async fn stage_chat_blob(
        &self,
        ctx: SpaceContext,
        raw: &str,
    ) -> Result<StagedChatBlob, PortError> {
        let byte_len = raw.len() as u64;
        let attested = StagedChatBlob::attest_canonical(
            ctx.scope().space_id.clone(),
            ctx.auth().principal().clone(),
            ContentDigest::from_bytes(*blake3::hash(raw.as_bytes()).as_bytes()),
            byte_len,
        )?;

        let space_rec = self.read_space(&ctx.scope().space_id).await?;
        space_rec.scope.check(ctx.scope())?;
        authorize_chat_write_on_space(ctx.auth(), &space_rec.space)?;

        let prepared = PreparedBlobSource::prepare(raw.as_bytes(), self.blob_codec())?;
        let ticket = self
            .stage_blob(&space_rec.scope, space_rec.active_epoch, &prepared)
            .await?;

        self.flush_pending_local_dirs(&ticket.local_pending_dirs)?;

        let scope = space_rec.scope.clone();
        let staged_epoch = space_rec.active_epoch;
        let auth_cl = ctx.auth().clone();
        let owner_id = ctx.auth().principal().as_str().to_owned();
        let staging_lease = new_prefixed_hex_id("stg_")?;
        let resource_key = prepared.digest.to_hex();
        let _retained_ticket = ticket.clone();

        self.with_fenced_auxiliary_write_tx(|tx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                live_space.scope.check(&scope)?;
                authorize_chat_write_on_space(&auth_cl, &live_space.space)?;
                if live_space.active_epoch != staged_epoch {
                    return Err(crate::codec::unavailable_retryable(
                        "stage_chat_blob_epoch_changed",
                        "Space active_epoch changed while staging chat blob",
                        std::time::Duration::from_millis(25),
                    ));
                }
                activate_and_bind_blob_ref_tx(
                    tx,
                    live_space.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::StagedChat,
                        owner_id,
                        owner_rev_id: staging_lease,
                        resource_key,
                    },
                    live_space.last_seq,
                )
                .await
            })
        })
        .await?;

        Ok(attested)
    }
}

fn authorize_chat_write_on_space(auth: &EngineAuthContext, space: &Space) -> Result<(), PortError> {
    let grant = auth
        .spaces()
        .get(&space.id)
        .ok_or(DomainError::ResourceNotFound)?;
    if space.lifecycle != SpaceLifecycle::Active
        || grant.role == SpaceRole::Viewer
        || grant.project_root.is_some()
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct ThreadHeadRow {
    thread_id: ChatThreadId,
    kind: ChatThreadKind,
    owner: PrincipalId,
    project_folder: Option<FolderId>,
    title: String,
    head_leaf_seq: ThreadEntrySeq,
    head_rev_id: RevisionId,
    next_entry_seq: ThreadEntrySeq,
    #[allow(dead_code)]
    active_run_id: Option<AgentRunId>,
    tainted_mask: i64,
}

async fn load_thread_head_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
) -> Result<Option<ThreadHeadRow>, PortError> {
    #[allow(clippy::type_complexity)]
    let raw: Option<(
        String,
        String,
        Option<String>,
        String,
        i64,
        String,
        i64,
        Option<String>,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask
                 FROM chat_threads WHERE space_id = ? AND thread_id = ?",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_thread", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("kind"),
                    row.get("owner_id"),
                    row.get("project_folder_id"),
                    row.get("title"),
                    row.get("head_leaf_seq"),
                    row.get("head_rev_id"),
                    row.get("next_entry_seq"),
                    row.get("active_run_id"),
                    row.get("ext_space_tainted_mask"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask::BIGINT AS tainted_mask
                 FROM chat_threads WHERE space_id = $1 AND thread_id = $2",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_thread", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("kind"),
                    row.get("owner_id"),
                    row.get("project_folder_id"),
                    row.get("title"),
                    row.get("head_leaf_seq"),
                    row.get("head_rev_id"),
                    row.get("next_entry_seq"),
                    row.get("active_run_id"),
                    row.get("tainted_mask"),
                )
            })
        }
    };

    let Some((
        kind_raw,
        owner_raw,
        proj_opt,
        title,
        head_leaf_raw,
        head_rev_raw,
        next_entry_raw,
        run_opt,
        tainted_mask,
    )) = raw
    else {
        return Ok(None);
    };

    let kind = chat_thread_kind_from_db(&kind_raw)?;
    let owner = PrincipalId::parse(&owner_raw)
        .map_err(|_| internal_not_committed("corrupt_thread_owner", "invalid owner_id"))?;
    let project_folder = match proj_opt {
        Some(s) => Some(
            FolderId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_thread_proj", "invalid FolderId"))?,
        ),
        None => None,
    };
    let head_leaf_seq = ThreadEntrySeq::new(
        u64::try_from(head_leaf_raw)
            .map_err(|_| internal_not_committed("corrupt_head_leaf", "negative head_leaf_seq"))?,
    )?;
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_thread_rev", "invalid head_rev_id"))?;
    let next_entry_seq =
        ThreadEntrySeq::new(u64::try_from(next_entry_raw).map_err(|_| {
            internal_not_committed("corrupt_next_entry", "negative next_entry_seq")
        })?)?;
    let active_run_id = match run_opt {
        Some(s) => Some(
            AgentRunId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_thread_run", "invalid AgentRunId"))?,
        ),
        None => None,
    };

    Ok(Some(ThreadHeadRow {
        thread_id: thread_id.clone(),
        kind,
        owner,
        project_folder,
        title,
        head_leaf_seq,
        head_rev_id,
        next_entry_seq,
        active_run_id,
        tainted_mask,
    }))
}

async fn load_thread_head_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
) -> Result<ThreadHeadRow, PortError> {
    load_thread_head_opt_tx(tx, space_id, thread_id)
        .await?
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

fn entry_kind_to_db(kind: &ChatEntryKind) -> (&'static str, Option<&str>) {
    match kind {
        ChatEntryKind::Human => ("human", None),
        ChatEntryKind::Model => ("model", None),
        ChatEntryKind::Tool { call_id } => ("tool", Some(call_id.as_str())),
        ChatEntryKind::Compaction => ("compaction", None),
        ChatEntryKind::Redacted => ("redacted", None),
    }
}

fn entry_kind_from_db(
    kind: &str,
    tool_call_id: Option<String>,
) -> Result<ChatEntryKind, PortError> {
    match kind {
        "human" => Ok(ChatEntryKind::Human),
        "model" => Ok(ChatEntryKind::Model),
        "tool" => {
            let raw = tool_call_id.ok_or_else(|| {
                internal_not_committed("corrupt_tool_call_id", "tool entry missing tool_call_id")
            })?;
            let key = CommandKey::parse(&raw)
                .map_err(|_| internal_not_committed("corrupt_tool_key", "invalid CommandKey"))?;
            Ok(ChatEntryKind::Tool { call_id: key })
        }
        "compaction" => Ok(ChatEntryKind::Compaction),
        "redacted" => Ok(ChatEntryKind::Redacted),
        other => Err(internal_not_committed(
            "corrupt_chat_entry_kind",
            format!("unexpected chat entry kind '{other}'"),
        )),
    }
}

/// Jumps along `anc_256_seq` / `anc_16_seq` / `parent_seq` from `start_seq` (whose depth is `>= target_depth`)
/// to the exact ancestor at `target_depth` in a single bounded PK-indexed recursive query.
async fn jump_to_ancestor_at_depth_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    start_seq: ThreadEntrySeq,
    target_depth: u32,
) -> Result<Option<ThreadEntrySeq>, PortError> {
    let start_i64 = start_seq.get() as i64;
    let target_i64 = i64::from(target_depth);
    let landed_opt: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "WITH RECURSIVE jump(entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
                 SELECT entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, 0
                 FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?
                 UNION ALL
                 SELECT e.entry_seq, e.branch_depth, e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
                 FROM jump j
                 JOIN chat_entries e
                   ON e.space_id = ?
                  AND e.thread_id = ?
                  AND e.entry_seq = CASE
                      WHEN j.branch_depth - ? >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                      WHEN j.branch_depth - ? >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                      ELSE j.parent_seq
                  END
                 WHERE j.branch_depth > ? AND j.hops < 100000
             )
             SELECT entry_seq FROM jump WHERE branch_depth = ? LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(start_i64)
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(target_i64)
        .bind(target_i64)
        .bind(target_i64)
        .bind(target_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_jump_ancestor", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "WITH RECURSIVE jump(entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
                 SELECT entry_seq, branch_depth::BIGINT, parent_seq, anc_16_seq, anc_256_seq, 0::BIGINT
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
                 UNION ALL
                 SELECT e.entry_seq, e.branch_depth::BIGINT, e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
                 FROM jump j
                 JOIN chat_entries e
                   ON e.space_id = $1
                  AND e.thread_id = $2
                  AND e.entry_seq = CASE
                      WHEN j.branch_depth - $4 >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                      WHEN j.branch_depth - $4 >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                      ELSE j.parent_seq
                  END
                 WHERE j.branch_depth > $4 AND j.hops < 100000
             )
             SELECT entry_seq FROM jump WHERE branch_depth = $4 LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(start_i64)
        .bind(target_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_jump_ancestor", err.to_string()))?,
    };

    match landed_opt {
        Some(raw) => Ok(Some(ThreadEntrySeq::new(u64::try_from(raw).map_err(
            |_| internal_not_committed("corrupt_jump_seq", "negative entry_seq"),
        )?)?)),
        None => Ok(None),
    }
}

async fn load_entry_depth_and_taint_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    entry_seq: ThreadEntrySeq,
) -> Result<Option<(u32, bool)>, PortError> {
    let seq_i64 = entry_seq.get() as i64;
    let raw: Option<(i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT branch_depth, ext_space_tainted FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(seq_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_entry_depth", err.to_string()))?;
            r.map(|row| (row.get("branch_depth"), row.get("ext_space_tainted")))
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT branch_depth::BIGINT AS d, ext_space_tainted::BIGINT AS t
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(seq_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_entry_depth", err.to_string()))?;
            r.map(|row| (row.get("d"), row.get("t")))
        }
    };

    match raw {
        Some((d, t)) => {
            let depth = u32::try_from(d).map_err(|_| {
                internal_not_committed("corrupt_branch_depth", "invalid branch_depth")
            })?;
            Ok(Some((depth, t != 0)))
        }
        None => Ok(None),
    }
}

async fn compute_skip_pointers_for_parent_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    parent: ThreadEntrySeq,
) -> Result<
    (
        Option<ThreadEntrySeq>,
        u32,
        Option<ThreadEntrySeq>,
        Option<ThreadEntrySeq>,
        bool,
    ),
    PortError,
> {
    if parent == ThreadEntrySeq::ZERO {
        return Ok((None, 0, None, None, false));
    }
    let Some((parent_depth, parent_tainted)) =
        load_entry_depth_and_taint_tx(tx, space_id, thread_id, parent).await?
    else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let depth = parent_depth
        .checked_add(1)
        .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;

    let anc_16 = if depth >= 16 {
        let target_16 = depth - 16;
        let found = jump_to_ancestor_at_depth_tx(tx, space_id, thread_id, parent, target_16)
            .await?
            .ok_or_else(|| {
                internal_not_committed("missing_anc_16", "failed to resolve anc_16_seq")
            })?;
        Some(found)
    } else {
        None
    };

    let anc_256 = if depth >= 256 {
        let target_256 = depth - 256;
        let start = anc_16.expect("depth >= 256 implies anc_16 is Some");
        let found = jump_to_ancestor_at_depth_tx(tx, space_id, thread_id, start, target_256)
            .await?
            .ok_or_else(|| {
                internal_not_committed("missing_anc_256", "failed to resolve anc_256_seq")
            })?;
        Some(found)
    } else {
        None
    };

    Ok((Some(parent), depth, anc_16, anc_256, parent_tainted))
}

fn build_ancestors_vec(
    anc_16: Option<ThreadEntrySeq>,
    anc_256: Option<ThreadEntrySeq>,
) -> Vec<ThreadEntrySeq> {
    let mut v = Vec::new();
    if let Some(a16) = anc_16 {
        v.push(a16);
    }
    if let Some(a256) = anc_256 {
        v.push(a256);
    }
    v
}

async fn consume_one_staged_chat_ref_and_bind_entry_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    staged: &StagedChatBlob,
    thread_id: &ChatThreadId,
    entry_seq: ThreadEntrySeq,
    entry_rev_id: &RevisionId,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    let digest = staged.digest();
    let res_key = digest.to_hex();
    let lease_opt: Option<(String, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT r.owner_rev_id, c.raw_size
                 FROM blob_references r
                 JOIN blob_catalog c
                   ON c.space_id = r.space_id AND c.content_blake3 = r.content_blake3
                 WHERE r.space_id = ? AND r.owner_kind = 'staged_chat'
                   AND r.owner_id = ? AND r.resource_key = ?
                   AND c.blob_state = 'active' AND c.admission_state = 'open'
                 ORDER BY r.created_seq ASC
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(&res_key)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_staged_chat", err.to_string()))?;
            r.map(|row| (row.get("owner_rev_id"), row.get("raw_size")))
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT r.owner_rev_id, c.raw_size
                 FROM blob_references r
                 JOIN blob_catalog c
                   ON c.space_id = r.space_id AND c.content_blake3 = r.content_blake3
                 WHERE r.space_id = $1 AND r.owner_kind = 'staged_chat'
                   AND r.owner_id = $2 AND r.resource_key = $3
                   AND c.blob_state = 'active' AND c.admission_state = 'open'
                 ORDER BY r.created_seq ASC
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(&res_key)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_check_staged_chat", err.to_string()))?;
            r.map(|row| (row.get("owner_rev_id"), row.get("raw_size")))
        }
    };

    let Some((staging_lease, raw_size)) = lease_opt else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if u64::try_from(raw_size).ok() != Some(staged.byte_len()) {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }

    let entry_owner_id = format!("{}:{}", thread_id.as_str(), entry_seq.get());
    bind_existing_active_blob_ref_tx(
        tx,
        space_id,
        BlobOwnerKind::ChatEntry,
        &entry_owner_id,
        entry_rev_id.as_str(),
        "body",
        digest,
        seq,
    )
    .await?;

    // Release the single consumed staging lease and recompute exact `ref_count`.
    let now_ms = now_unix_ms()?;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "DELETE FROM blob_references
                 WHERE space_id = ? AND owner_kind = 'staged_chat'
                   AND owner_id = ? AND owner_rev_id = ? AND resource_key = ?",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(&staging_lease)
            .bind(&res_key)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_del_staged_chat", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "DELETE FROM blob_references
                 WHERE space_id = $1 AND owner_kind = 'staged_chat'
                   AND owner_id = $2 AND owner_rev_id = $3 AND resource_key = $4",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(&staging_lease)
            .bind(&res_key)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_del_staged_chat", err.to_string()))?;
        }
    }

    let exact_count = count_reachable_refs_tx(tx, space_id, digest).await?;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_catalog SET ref_count = ?, touched_at_ms = ?
                 WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(exact_count)
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_sync_staged_cnt", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_catalog SET ref_count = $1, touched_at_ms = $2
                 WHERE space_id = $3 AND content_blake3 = $4",
            )
            .bind(exact_count)
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_sync_staged_cnt", err.to_string()))?;
        }
    }

    Ok(())
}

async fn read_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<ChatBranch, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                let thread_tainted = th.tainted_mask != 0;
                auth.authorize_chat_read(&srec.space, thread_tainted)?;

                let thread_out = ChatThread {
                    id: th.thread_id.clone(),
                    space: scope.space_id.clone(),
                    kind: th.kind,
                    owner: th.owner,
                    project_folder: th.project_folder,
                    head: th.head_leaf_seq,
                    revision: th.head_rev_id,
                    tainted: thread_tainted,
                };

                if request.leaf == ThreadEntrySeq::ZERO {
                    if request.before.is_some() {
                        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
                    }
                    return Ok(ChatBranch {
                        thread: thread_out,
                        entries: Vec::new(),
                        next_ancestor: None,
                    });
                }

                let Some((leaf_depth, _)) =
                    load_entry_depth_and_taint_tx(tx, &scope.space_id, &request.thread, request.leaf)
                        .await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                let window_tip = match request.before {
                    None => request.leaf,
                    Some(anc_seq) => {
                        if anc_seq == ThreadEntrySeq::ZERO {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidRange).into()
                            );
                        }
                        let Some((anc_depth, _)) = load_entry_depth_and_taint_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            anc_seq,
                        )
                        .await?
                        else {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidRange).into()
                            );
                        };
                        if anc_depth >= leaf_depth {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidRange).into()
                            );
                        }
                        let actual_anc = jump_to_ancestor_at_depth_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            request.leaf,
                            anc_depth,
                        )
                        .await?;
                        if actual_anc != Some(anc_seq) {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidRange).into()
                            );
                        }
                        anc_seq
                    }
                };

                let max_n = i64::from(request.max_entries.get());
                let tip_i64 = window_tip.get() as i64;

                #[allow(clippy::type_complexity)]
                let raw_rows: Vec<(
                    i64,
                    Option<i64>,
                    String,
                    Option<String>,
                    String,
                    Option<String>,
                    Option<String>,
                    Option<Vec<u8>>,
                    String,
                    i64,
                    i64,
                    i64,
                    Option<i64>,
                    Option<i64>,
                )> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let rows = sqlx::query(
                            "WITH RECURSIVE win(
                                 entry_seq, parent_seq, kind, tool_call_id, author_id,
                                 agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                 ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, n
                             ) AS (
                                 SELECT entry_seq, parent_seq, kind, tool_call_id, author_id,
                                        agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                        ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, 1
                                 FROM chat_entries
                                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?
                                 UNION ALL
                                 SELECT e.entry_seq, e.parent_seq, e.kind, e.tool_call_id, e.author_id,
                                        e.agent_run_id, e.inline_text, e.payload_blake3, e.referenced_notes_json,
                                        e.ext_space_tainted, e.is_chain_node, e.branch_depth, e.anc_16_seq, e.anc_256_seq, w.n + 1
                                 FROM win w
                                 JOIN chat_entries e
                                   ON e.space_id = ? AND e.thread_id = ? AND e.entry_seq = w.parent_seq
                                 WHERE w.parent_seq IS NOT NULL AND w.n < ?
                             )
                             SELECT entry_seq, parent_seq, kind, tool_call_id, author_id,
                                    agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                    ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq
                             FROM win
                             ORDER BY branch_depth ASC",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(request.thread.as_str())
                        .bind(tip_i64)
                        .bind(scope.space_id.as_str())
                        .bind(request.thread.as_str())
                        .bind(max_n)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_read_chat_win", err.to_string()))?;

                        rows.into_iter()
                            .map(|r| {
                                (
                                    r.get("entry_seq"),
                                    r.get("parent_seq"),
                                    r.get("kind"),
                                    r.get("tool_call_id"),
                                    r.get("author_id"),
                                    r.get("agent_run_id"),
                                    r.get("inline_text"),
                                    r.get("payload_blake3"),
                                    r.get("referenced_notes_json"),
                                    r.get("ext_space_tainted"),
                                    r.get("is_chain_node"),
                                    r.get("branch_depth"),
                                    r.get("anc_16_seq"),
                                    r.get("anc_256_seq"),
                                )
                            })
                            .collect()
                    }
                    BackendConn::Postgres(conn) => {
                        let rows = sqlx::query(
                            "WITH RECURSIVE win(
                                 entry_seq, parent_seq, kind, tool_call_id, author_id,
                                 agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                 ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, n
                             ) AS (
                                 SELECT entry_seq, parent_seq, kind, tool_call_id, author_id,
                                        agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                        ext_space_tainted::BIGINT, is_chain_node::BIGINT, branch_depth::BIGINT,
                                        anc_16_seq, anc_256_seq, 1::BIGINT
                                 FROM chat_entries
                                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
                                 UNION ALL
                                 SELECT e.entry_seq, e.parent_seq, e.kind, e.tool_call_id, e.author_id,
                                        e.agent_run_id, e.inline_text, e.payload_blake3, e.referenced_notes_json,
                                        e.ext_space_tainted::BIGINT, e.is_chain_node::BIGINT, e.branch_depth::BIGINT,
                                        e.anc_16_seq, e.anc_256_seq, w.n + 1
                                 FROM win w
                                 JOIN chat_entries e
                                   ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = w.parent_seq
                                 WHERE w.parent_seq IS NOT NULL AND w.n < $4
                             )
                             SELECT entry_seq, parent_seq, kind, tool_call_id, author_id,
                                    agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                    ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq
                             FROM win
                             ORDER BY branch_depth ASC",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(request.thread.as_str())
                        .bind(tip_i64)
                        .bind(max_n)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_read_chat_win", err.to_string()))?;

                        rows.into_iter()
                            .map(|r| {
                                (
                                    r.get("entry_seq"),
                                    r.get("parent_seq"),
                                    r.get("kind"),
                                    r.get("tool_call_id"),
                                    r.get("author_id"),
                                    r.get("agent_run_id"),
                                    r.get("inline_text"),
                                    r.get("payload_blake3"),
                                    r.get("referenced_notes_json"),
                                    r.get("ext_space_tainted"),
                                    r.get("is_chain_node"),
                                    r.get("branch_depth"),
                                    r.get("anc_16_seq"),
                                    r.get("anc_256_seq"),
                                )
                            })
                            .collect()
                    }
                };

                let mut entries = Vec::with_capacity(raw_rows.len());
                for (
                    e_seq_raw,
                    p_seq_opt,
                    k_str,
                    tc_opt,
                    author_str,
                    run_opt,
                    inline_opt,
                    blob_opt,
                    refs_json,
                    taint_raw,
                    chain_raw,
                    depth_raw,
                    a16_opt,
                    a256_opt,
                ) in raw_rows
                {
                    let seq = ThreadEntrySeq::new(u64::try_from(e_seq_raw).map_err(|_| {
                        internal_not_committed("corrupt_entry_seq", "negative entry_seq")
                    })?)?;
                    let parent = match p_seq_opt {
                        Some(p) => Some(ThreadEntrySeq::new(u64::try_from(p).map_err(|_| {
                            internal_not_committed("corrupt_parent_seq", "negative parent_seq")
                        })?)?),
                        None => None,
                    };
                    let anc_16 = match a16_opt {
                        Some(a) => Some(ThreadEntrySeq::new(u64::try_from(a).map_err(|_| {
                            internal_not_committed("corrupt_a16", "negative anc_16_seq")
                        })?)?),
                        None => None,
                    };
                    let anc_256 = match a256_opt {
                        Some(a) => Some(ThreadEntrySeq::new(u64::try_from(a).map_err(|_| {
                            internal_not_committed("corrupt_a256", "negative anc_256_seq")
                        })?)?),
                        None => None,
                    };
                    let kind = entry_kind_from_db(&k_str, tc_opt)?;
                    let body = if kind == ChatEntryKind::Redacted {
                        ChatBody::Redacted
                    } else if let Some(txt) = inline_opt {
                        ChatBody::Inline(txt)
                    } else if let Some(b) = blob_opt {
                        let arr: [u8; 32] = b.try_into().map_err(|_| {
                            internal_not_committed("corrupt_chat_blob", "digest != 32B")
                        })?;
                        ChatBody::Blob(ContentDigest::from_bytes(arr))
                    } else {
                        return Err(internal_not_committed(
                            "corrupt_chat_body",
                            "entry lacks inline_text and payload_blake3",
                        ));
                    };
                    let author = PrincipalId::parse(&author_str).map_err(|_| {
                        internal_not_committed("corrupt_chat_author", "invalid PrincipalId")
                    })?;
                    let run = match run_opt {
                        Some(s) => Some(AgentRunId::parse(&s).map_err(|_| {
                            internal_not_committed("corrupt_chat_run", "invalid AgentRunId")
                        })?),
                        None => None,
                    };
                    let referenced_notes: Vec<NoteRef> =
                        serde_json::from_str(&refs_json).map_err(|err| {
                            internal_not_committed("corrupt_chat_refs", err.to_string())
                        })?;
                    let depth = u32::try_from(depth_raw).map_err(|_| {
                        internal_not_committed("corrupt_chat_depth", "invalid depth")
                    })?;
                    let entry_taint = taint_raw != 0;
                    if entry_taint {
                        auth.authorize_chat_read(&srec.space, true)?;
                    }

                    entries.push(ChatEntry {
                        thread: request.thread.clone(),
                        seq,
                        parent,
                        is_chain_node: chain_raw != 0,
                        depth,
                        ancestors: build_ancestors_vec(anc_16, anc_256),
                        author,
                        run,
                        kind,
                        body,
                        tainted: entry_taint,
                        referenced_notes,
                    });
                }

                let next_ancestor = entries.first().and_then(|oldest| oldest.parent);
                Ok(ChatBranch {
                    thread: thread_out,
                    entries,
                    next_ancestor,
                })
            })
        })
        .await
}

async fn create_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<CreateChat>,
) -> Result<Committed<ChatThread>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    if request.input.owner != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if request.input.title.trim().is_empty() {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let mut fp = blake3::Hasher::new();
    fp.update(request.input.thread.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(chat_thread_kind_to_db(request.input.kind).as_bytes());
    fp.update(&[0]);
    fp.update(request.input.owner.as_str().as_bytes());
    fp.update(&[0]);
    if let Some(pf) = &request.input.project_folder {
        fp.update(pf.as_str().as_bytes());
    }
    fp.update(&[0]);
    fp.update(request.input.title.as_bytes());
    let idemp =
        derive_command_identity_spec(&request.identity, "create_chat", fp.finalize().as_bytes());

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let tainted = auth.taint().is_tainted();
                if tainted
                    && (input.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                if load_thread_head_opt_tx(tx, &scope.space_id, &input.thread)
                    .await?
                    .is_some()
                {
                    return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
                }

                if let Some(pf) = &input.project_folder {
                    let frow = load_folder_head_row(tx, &scope.space_id, pf).await?;
                    if frow.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                }

                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let kind_str = chat_thread_kind_to_db(input.kind);
                let taint_mask: i64 = i64::from(u8::from(tainted));

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO chat_threads (
                                space_id, history_incarnation, thread_id, kind, owner_id,
                                project_folder_id, title, head_leaf_seq, head_rev_id,
                                next_entry_seq, active_run_id, ext_space_tainted_mask,
                                created_seq, updated_seq, created_at_sec, created_at_nsec,
                                updated_at_sec, updated_at_nsec
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice())
                        .bind(input.thread.as_str())
                        .bind(kind_str)
                        .bind(input.owner.as_str())
                        .bind(input.project_folder.as_ref().map(FolderId::as_str))
                        .bind(&input.title)
                        .bind(rev_id.as_str())
                        .bind(taint_mask)
                        .bind(seq_i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_create_chat", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO chat_threads (
                                space_id, history_incarnation, thread_id, kind, owner_id,
                                project_folder_id, title, head_leaf_seq, head_rev_id,
                                next_entry_seq, active_run_id, ext_space_tainted_mask,
                                created_seq, updated_seq, created_at_sec, created_at_nsec,
                                updated_at_sec, updated_at_nsec
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 1, NULL, $9, $10, $10, $11, $12, $11, $12)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice())
                        .bind(input.thread.as_str())
                        .bind(kind_str)
                        .bind(input.owner.as_str())
                        .bind(input.project_folder.as_ref().map(FolderId::as_str))
                        .bind(&input.title)
                        .bind(rev_id.as_str())
                        .bind(taint_mask)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_create_chat", err.to_string()))?;
                    }
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                    ThreadRevisionMetadata {
                        thread_id: input.thread.clone(),
                        kind: input.kind,
                        owner_id: input.owner.clone(),
                        project_folder_id: input.project_folder.clone(),
                        title: input.title.clone(),
                        head_leaf_seq: ThreadEntrySeq::ZERO,
                        tainted,
                    },
                ))
                .encode()?;

                let run_opt = extract_agent_run_from_auth(&auth);
                insert_revision_row(
                    tx,
                    &scope,
                    &rev_id,
                    "thread",
                    input.thread.as_str(),
                    seq,
                    seq,
                    None,
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                let thread_val = ChatThread {
                    id: input.thread.clone(),
                    space: scope.space_id.clone(),
                    kind: input.kind,
                    owner: input.owner,
                    project_folder: input.project_folder,
                    head: ThreadEntrySeq::ZERO,
                    revision: rev_id.clone(),
                    tainted,
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedChatThreadV1 {
                    value: (&thread_val).into(),
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "create_chat",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "create_chat".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: input.thread.as_str().to_owned(),
                        op_kind: "create".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedChatThreadV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn fork_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ForkChat>,
) -> Result<Committed<ChatThread>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "thread={};parent={}",
        request.input.thread.as_str(),
        request.input.parent.get()
    );
    let idemp = derive_command_identity_spec(&request.identity, "fork_chat", fp.as_bytes());

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions;
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != th.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let parent_tainted = if input.parent == ThreadEntrySeq::ZERO {
                    false
                } else {
                    let Some((_, pt)) = load_entry_depth_and_taint_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.parent,
                    )
                    .await?
                    else {
                        return Err(DomainError::ResourceNotFound.into());
                    };
                    pt
                };

                let new_tainted =
                    (th.tainted_mask != 0) || auth.taint().is_tainted() || parent_tainted;
                if new_tainted
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let leaf_i64 = input.parent.get() as i64;
                let taint_mask: i64 = i64::from(u8::from(new_tainted));

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE chat_threads
                             SET head_leaf_seq = ?, head_rev_id = ?, ext_space_tainted_mask = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND thread_id = ?",
                        )
                        .bind(leaf_i64)
                        .bind(new_rev.as_str())
                        .bind(taint_mask)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_fork_chat", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE chat_threads
                             SET head_leaf_seq = $1, head_rev_id = $2, ext_space_tainted_mask = $3,
                                 updated_seq = $4, updated_at_sec = $5, updated_at_nsec = $6
                             WHERE space_id = $7 AND thread_id = $8",
                        )
                        .bind(leaf_i64)
                        .bind(new_rev.as_str())
                        .bind(taint_mask)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_fork_chat", err.to_string()))?;
                    }
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                    ThreadRevisionMetadata {
                        thread_id: th.thread_id.clone(),
                        kind: th.kind,
                        owner_id: th.owner.clone(),
                        project_folder_id: th.project_folder.clone(),
                        title: th.title.clone(),
                        head_leaf_seq: input.parent,
                        tainted: new_tainted,
                    },
                ))
                .encode()?;

                let run_opt = extract_agent_run_from_auth(&auth);
                insert_revision_row(
                    tx,
                    &scope,
                    &new_rev,
                    "thread",
                    th.thread_id.as_str(),
                    seq,
                    seq,
                    Some(&th.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                let thread_val = ChatThread {
                    id: th.thread_id.clone(),
                    space: scope.space_id.clone(),
                    kind: th.kind,
                    owner: th.owner,
                    project_folder: th.project_folder,
                    head: input.parent,
                    revision: new_rev.clone(),
                    tainted: new_tainted,
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedChatThreadV1 {
                    value: (&thread_val).into(),
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "fork_chat",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "fork_chat".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: th.thread_id.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedChatThreadV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn append_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<AppendChat>,
) -> Result<Committed<ChatEntry>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    if request.input.kind == ChatEntryKind::Redacted {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    match &request.input.body {
        ChatInputBody::Text(s) => {
            if (s.len() as u64) > StagedChatBlob::INLINE_MAX_BYTES {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
        }
        ChatInputBody::Staged(staged) => {
            if staged.space() != &ctx.scope().space_id {
                return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
            }
            if staged.owner() != ctx.auth().principal() {
                return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
            }
            if staged.byte_len() <= StagedChatBlob::INLINE_MAX_BYTES {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
        }
    }

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let mut fp = blake3::Hasher::new();
    fp.update(request.input.thread.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(&request.input.parent.get().to_be_bytes());
    fp.update(&[0]);
    let (k_str, tc_opt) = entry_kind_to_db(&request.input.kind);
    fp.update(k_str.as_bytes());
    if let Some(tc) = tc_opt {
        fp.update(tc.as_bytes());
    }
    fp.update(&[0]);
    match &request.input.body {
        ChatInputBody::Text(s) => {
            fp.update(&[1]);
            fp.update(s.as_bytes());
        }
        ChatInputBody::Staged(st) => {
            fp.update(&[2]);
            fp.update(st.digest().as_bytes());
        }
    }
    for r in &request.input.referenced_notes {
        fp.update(r.space_id.as_str().as_bytes());
        fp.update(r.note_id.as_str().as_bytes());
    }
    fp.update(&[u8::from(request.input.tainted)]);
    let idemp =
        derive_command_identity_spec(&request.identity, "append_chat", fp.finalize().as_bytes());

    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedChatEntryV1>(
        store,
        &space_rec.scope,
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions: Preconditions = request.preconditions;
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != th.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let (parent_opt, depth, anc_16, anc_256, parent_tainted) =
                    compute_skip_pointers_for_parent_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.parent,
                    )
                    .await?;

                let mut effective_tainted =
                    auth.taint().is_tainted() || input.tainted || parent_tainted;
                let mut folder_cache = FolderAncestryCache::default();
                let mut owner_notes = Vec::new();

                for nref in &input.referenced_notes {
                    if nref.space_id == scope.space_id {
                        if is_note_purge_fenced_tx(tx, &scope.space_id, nref.note_id.as_str())
                            .await?
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let nhead =
                            load_note_head_row_tx(tx, &scope.space_id, &nref.note_id).await?;
                        if nhead.lifecycle == Lifecycle::Purged {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let (facts, _) = folder_cache
                            .build_resource_facts_tx(
                                tx,
                                &live_space.space,
                                &nhead.parent_folder_id,
                                nhead.doc_class,
                                nhead.ability_id,
                                false,
                            )
                            .await?;
                        auth.authorize_read(&facts)?;
                        owner_notes.push(nref.note_id.clone());
                    } else {
                        if !auth.spaces().contains_key(&nref.space_id) {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        auth.taint().mark_external_read();
                        effective_tainted = true;
                    }
                }
                if auth.taint().is_tainted() {
                    effective_tainted = true;
                }

                if effective_tainted
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                let entry_seq = th.next_entry_seq;
                let next_entry_seq = entry_seq.checked_next()?;
                let seq = item_ctx.alloc_next_seq()?;
                let entry_rev = new_revision_id()?;
                let new_thread_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                let (inline_text, payload_digest, body_out) = match &input.body {
                    ChatInputBody::Text(s) => (Some(s.clone()), None, ChatBody::Inline(s.clone())),
                    ChatInputBody::Staged(staged) => {
                        consume_one_staged_chat_ref_and_bind_entry_tx(
                            tx,
                            &scope.space_id,
                            staged,
                            &input.thread,
                            entry_seq,
                            &entry_rev,
                            seq,
                        )
                        .await?;
                        (None, Some(staged.digest()), ChatBody::Blob(staged.digest()))
                    }
                };

                let (kind_str, tool_call_opt) = entry_kind_to_db(&input.kind);
                let refs_json = serde_json::to_string(&input.referenced_notes)
                    .map_err(|err| internal_not_committed("encode_chat_refs", err.to_string()))?;
                let run_opt = extract_agent_run_from_auth(&auth);

                insert_chat_entry_row_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_seq,
                    parent_opt,
                    &entry_rev,
                    kind_str,
                    tool_call_opt,
                    auth.principal(),
                    run_opt.as_ref(),
                    inline_text.as_deref(),
                    payload_digest,
                    &refs_json,
                    effective_tainted,
                    depth,
                    anc_16,
                    anc_256,
                    seq,
                )
                .await?;

                let thread_tainted = (th.tainted_mask != 0) || effective_tainted;
                let taint_mask: i64 = i64::from(u8::from(thread_tainted));

                update_thread_after_append_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_seq,
                    &new_thread_rev,
                    next_entry_seq,
                    taint_mask,
                    seq_i64,
                    sec,
                    nsec,
                )
                .await?;

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                    ThreadRevisionMetadata {
                        thread_id: th.thread_id.clone(),
                        kind: th.kind,
                        owner_id: th.owner.clone(),
                        project_folder_id: th.project_folder.clone(),
                        title: th.title.clone(),
                        head_leaf_seq: entry_seq,
                        tainted: thread_tainted,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_thread_rev,
                    "thread",
                    th.thread_id.as_str(),
                    seq,
                    seq,
                    Some(&th.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let entry_val = ChatEntry {
                    thread: input.thread.clone(),
                    seq: entry_seq,
                    parent: parent_opt,
                    is_chain_node: true,
                    depth,
                    ancestors: build_ancestors_vec(anc_16, anc_256),
                    author: auth.principal().clone(),
                    run: run_opt,
                    kind: input.kind,
                    body: body_out,
                    tainted: effective_tainted,
                    referenced_notes: input.referenced_notes,
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_full = StoredCommittedChatEntryV1 {
                    value: (&entry_val).into(),
                    receipt,
                };
                let stored_sanitized = stored_full.sanitized_for_redaction();
                let full_bytes = CanonicalStore::encode_command_outcome(&stored_full)?;
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&stored_sanitized)?;

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "append_chat",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    owner_notes.clone(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "append_chat".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: input.thread.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_thread_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: Some(full_bytes.clone()),
                    receipt_sanitized_blob: sanitized_bytes,
                    receipt_owner_note_ids: owner_notes,
                    response_bytes: full_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedChatEntryV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

#[allow(clippy::too_many_arguments)]
async fn insert_chat_entry_row_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    entry_seq: ThreadEntrySeq,
    parent_opt: Option<ThreadEntrySeq>,
    entry_rev: &RevisionId,
    kind_str: &str,
    tool_call_opt: Option<&str>,
    author: &PrincipalId,
    run_opt: Option<&AgentRunId>,
    inline_text: Option<&str>,
    payload_digest: Option<ContentDigest>,
    refs_json: &str,
    tainted: bool,
    depth: u32,
    anc_16: Option<ThreadEntrySeq>,
    anc_256: Option<ThreadEntrySeq>,
    created_space_seq: SpaceSeq,
) -> Result<(), PortError> {
    let e_i64 = entry_seq.get() as i64;
    let p_i64 = parent_opt.map(|p| p.get() as i64);
    let a16_i64 = anc_16.map(|a| a.get() as i64);
    let a256_i64 = anc_256.map(|a| a.get() as i64);
    let d_bytes = payload_digest.as_ref().map(|d| d.as_bytes().as_slice());
    let taint_i32 = i32::from(u8::from(tainted));
    let cseq_i64 = created_space_seq.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO chat_entries (
                    space_id, thread_id, entry_seq, parent_seq, revision_id, kind,
                    tool_call_id, author_id, agent_run_id, inline_text, payload_blake3,
                    referenced_notes_json, ext_space_tainted, is_chain_node, branch_depth,
                    anc_16_seq, anc_256_seq, created_space_seq, redacted_at_seq, checkpoint_stale
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 0)",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(e_i64)
            .bind(p_i64)
            .bind(entry_rev.as_str())
            .bind(kind_str)
            .bind(tool_call_opt)
            .bind(author.as_str())
            .bind(run_opt.map(AgentRunId::as_str))
            .bind(inline_text)
            .bind(d_bytes)
            .bind(refs_json)
            .bind(taint_i32)
            .bind(i64::from(depth))
            .bind(a16_i64)
            .bind(a256_i64)
            .bind(cseq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_chat_entry", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO chat_entries (
                    space_id, thread_id, entry_seq, parent_seq, revision_id, kind,
                    tool_call_id, author_id, agent_run_id, inline_text, payload_blake3,
                    referenced_notes_json, ext_space_tainted, is_chain_node, branch_depth,
                    anc_16_seq, anc_256_seq, created_space_seq, redacted_at_seq, checkpoint_stale
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, NULL, 0)",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .bind(e_i64)
            .bind(p_i64)
            .bind(entry_rev.as_str())
            .bind(kind_str)
            .bind(tool_call_opt)
            .bind(author.as_str())
            .bind(run_opt.map(AgentRunId::as_str))
            .bind(inline_text)
            .bind(d_bytes)
            .bind(refs_json)
            .bind(i16::try_from(taint_i32).unwrap_or(0))
            .bind(i32::try_from(depth).map_err(|_| {
                DomainError::validation(ValidationReason::SequenceOverflow)
            })?)
            .bind(a16_i64)
            .bind(a256_i64)
            .bind(cseq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_chat_entry", err.to_string()))?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn update_thread_after_append_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    head_leaf_seq: ThreadEntrySeq,
    new_rev: &RevisionId,
    next_entry_seq: ThreadEntrySeq,
    taint_mask: i64,
    seq_i64: i64,
    sec: i64,
    nsec: i32,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE chat_threads
                 SET head_leaf_seq = ?, head_rev_id = ?, next_entry_seq = ?,
                     ext_space_tainted_mask = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                 WHERE space_id = ? AND thread_id = ?",
            )
            .bind(head_leaf_seq.get() as i64)
            .bind(new_rev.as_str())
            .bind(next_entry_seq.get() as i64)
            .bind(taint_mask)
            .bind(seq_i64)
            .bind(sec)
            .bind(nsec)
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_upd_thread_append", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE chat_threads
                 SET head_leaf_seq = $1, head_rev_id = $2, next_entry_seq = $3,
                     ext_space_tainted_mask = $4, updated_seq = $5, updated_at_sec = $6, updated_at_nsec = $7
                 WHERE space_id = $8 AND thread_id = $9",
            )
            .bind(head_leaf_seq.get() as i64)
            .bind(new_rev.as_str())
            .bind(next_entry_seq.get() as i64)
            .bind(taint_mask)
            .bind(seq_i64)
            .bind(sec)
            .bind(nsec)
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_upd_thread_append", err.to_string()))?;
        }
    }
    Ok(())
}

async fn queue_chat_input_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<PendingChatInput>,
) -> Result<QueueInputOutcome, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    if request.input.sender != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let mut fp = blake3::Hasher::new();
    fp.update(request.input.id.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.thread.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.sender.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.body.as_bytes());
    fp.update(&[0]);
    fp.update(&request.input.queued_base_leaf.get().to_be_bytes());
    fp.update(&[0]);
    fp.update(request.input.in_flight_run.as_str().as_bytes());
    fp.update(&[u8::from(request.input.mentions_agent)]);
    let idemp = derive_command_identity_spec(
        &request.identity,
        "queue_chat_input",
        fp.finalize().as_bytes(),
    );

    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedQueuedInputV1>(
        store,
        &space_rec.scope,
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(QueueInputOutcome::Queued(replayed.into_committed()));
    }

    let staged_opt = if (request.input.body.len() as u64) > StagedChatBlob::INLINE_MAX_BYTES {
        let prepared =
            PreparedBlobSource::prepare(request.input.body.as_bytes(), store.blob_codec())?;
        let ticket = store
            .stage_blob(&space_rec.scope, space_rec.active_epoch, &prepared)
            .await?;
        Some((prepared.digest, ticket))
    } else {
        None
    };

    let queue_full_flag = Arc::new(AtomicBool::new(false));
    let flag_cl = Arc::clone(&queue_full_flag);
    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let input = request.input;
    let staged_bytes = staged_opt
        .as_ref()
        .map(|(_, t)| t.compressed_size)
        .unwrap_or(0);

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                if auth.taint().is_tainted()
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                if input.queued_base_leaf != ThreadEntrySeq::ZERO
                    && load_entry_depth_and_taint_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.queued_base_leaf,
                    )
                    .await?
                    .is_none()
                {
                    return Err(DomainError::ResourceNotFound.into());
                }

                // Check duplicate `input_id` first before active count check.
                let existing_input: Option<i64> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT 1 FROM chat_pending_inputs
                         WHERE space_id = ? AND thread_id = ? AND input_id = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .bind(input.id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_chk_dup_pending", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT 1::BIGINT FROM chat_pending_inputs
                         WHERE space_id = $1 AND thread_id = $2 AND input_id = $3",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .bind(input.id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_chk_dup_pending", err.to_string()))?,
                };
                if existing_input.is_some() {
                    return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
                }

                // Under Space write lock: enforce active pending queue bound <= 16 BEFORE any seq/ref allocation!
                let active_pending: i64 = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT COUNT(*) FROM chat_pending_inputs
                         WHERE space_id = ? AND thread_id = ? AND status = 'pending'",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_cnt_pending", err.to_string()))?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT COUNT(*)::BIGINT FROM chat_pending_inputs
                         WHERE space_id = $1 AND thread_id = $2 AND status = 'pending'",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_cnt_pending", err.to_string()))?,
                };

                if active_pending >= i64::from(PENDING_CHAT_QUEUE_LIMIT) {
                    flag_cl.store(true, Ordering::SeqCst);
                    return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
                }

                let next_ordinal: i64 = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM chat_pending_inputs
                         WHERE space_id = ? AND thread_id = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_next_ordinal", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT (COALESCE(MAX(ordinal), 0) + 1)::BIGINT FROM chat_pending_inputs
                         WHERE space_id = $1 AND thread_id = $2",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(input.thread.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_next_ordinal", err.to_string()))?,
                };

                let seq = item_ctx.alloc_next_seq()?;
                let ev_rev = new_revision_id()?;
                let seq_i64 = seq.get() as i64;
                let position = u8::try_from(active_pending + 1).unwrap_or(PENDING_CHAT_QUEUE_LIMIT);

                let (inline_opt, payload_opt) = match staged_opt {
                    None => (Some(input.body.as_str()), None),
                    Some((digest, ticket)) => {
                        item_ctx.record_staged_ticket(ticket.clone());
                        let owner_id = format!("{}:{}", input.thread.as_str(), input.id.as_str());
                        activate_and_bind_blob_ref_tx(
                            tx,
                            item_ctx.active_epoch,
                            &BlobReferenceClaim {
                                ticket,
                                owner_kind: BlobOwnerKind::ChatPendingInput,
                                owner_id,
                                owner_rev_id: ev_rev.as_str().to_owned(),
                                resource_key: "body".to_owned(),
                            },
                            seq,
                        )
                        .await?;
                        (None, Some(digest))
                    }
                };

                let d_bytes = payload_opt.as_ref().map(|d| d.as_bytes().as_slice());
                let mentions_i32 = i32::from(u8::from(input.mentions_agent));

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO chat_pending_inputs (
                                space_id, thread_id, input_id, ordinal, author_id,
                                inline_text, payload_blake3, queued_base_leaf_seq,
                                in_flight_run_id, mentions_agent, status, enqueued_seq, consumed_entry_seq
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.id.as_str())
                        .bind(next_ordinal)
                        .bind(input.sender.as_str())
                        .bind(inline_opt)
                        .bind(d_bytes)
                        .bind(input.queued_base_leaf.get() as i64)
                        .bind(input.in_flight_run.as_str())
                        .bind(mentions_i32)
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_ins_pending", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO chat_pending_inputs (
                                space_id, thread_id, input_id, ordinal, author_id,
                                inline_text, payload_blake3, queued_base_leaf_seq,
                                in_flight_run_id, mentions_agent, status, enqueued_seq, consumed_entry_seq
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, NULL)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.id.as_str())
                        .bind(next_ordinal)
                        .bind(input.sender.as_str())
                        .bind(inline_opt)
                        .bind(d_bytes)
                        .bind(input.queued_base_leaf.get() as i64)
                        .bind(input.in_flight_run.as_str())
                        .bind(i16::try_from(mentions_i32).unwrap_or(0))
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_ins_pending", err.to_string()))?;
                    }
                }

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedQueuedInputV1 {
                    value: StoredQueuedInputV1 {
                        input: input.id.clone(),
                        position,
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "queue_chat_input",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "queue_chat_input".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: input.thread.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: ev_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    match store
        .submit_write_command::<StoredCommittedQueuedInputV1>(&ctx.budget, intent)
        .await
    {
        Ok(stored) => Ok(QueueInputOutcome::Queued(stored.into_committed())),
        Err(_) if queue_full_flag.load(Ordering::SeqCst) => Ok(QueueInputOutcome::Full {
            limit: PENDING_CHAT_QUEUE_LIMIT,
        }),
        Err(other) => Err(other),
    }
}

async fn consume_chat_input_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ConsumePending>,
) -> Result<Committed<ConsumedPending>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "thread={};input={};run={};leaf={}",
        request.input.thread.as_str(),
        request.input.input.as_str(),
        request.input.expected_run.as_str(),
        request.input.current_leaf.get()
    );
    let idemp =
        derive_command_identity_spec(&request.identity, "consume_chat_input", fp.as_bytes());

    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedConsumedPendingV1>(
        store,
        &space_rec.scope,
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions;
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != th.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                #[allow(clippy::type_complexity)]
                let pending_row: Option<(
                    String,
                    Option<String>,
                    Option<Vec<u8>>,
                    i64,
                    String,
                    String,
                )> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let r = sqlx::query(
                            "SELECT author_id, inline_text, payload_blake3, queued_base_leaf_seq,
                                    in_flight_run_id, status
                             FROM chat_pending_inputs
                             WHERE space_id = ? AND thread_id = ? AND input_id = ?",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.input.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_load_pending", err.to_string())
                        })?;
                        r.map(|row| {
                            (
                                row.get("author_id"),
                                row.get("inline_text"),
                                row.get("payload_blake3"),
                                row.get("queued_base_leaf_seq"),
                                row.get("in_flight_run_id"),
                                row.get("status"),
                            )
                        })
                    }
                    BackendConn::Postgres(conn) => {
                        let r = sqlx::query(
                            "SELECT author_id, inline_text, payload_blake3, queued_base_leaf_seq,
                                    in_flight_run_id, status
                             FROM chat_pending_inputs
                             WHERE space_id = $1 AND thread_id = $2 AND input_id = $3",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.input.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_load_pending", err.to_string())
                        })?;
                        r.map(|row| {
                            (
                                row.get("author_id"),
                                row.get("inline_text"),
                                row.get("payload_blake3"),
                                row.get("queued_base_leaf_seq"),
                                row.get("in_flight_run_id"),
                                row.get("status"),
                            )
                        })
                    }
                };

                let Some((author_raw, inline_opt, blob_opt, queued_raw, run_raw, status)) =
                    pending_row
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                if status == "consumed" {
                    let seq = item_ctx.alloc_next_seq()?;
                    let ev_rev = new_revision_id()?;
                    let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                    let stored = StoredCommittedConsumedPendingV1 {
                        value: StoredConsumedPendingV1::AlreadyConsumed,
                        receipt,
                    };
                    let resp_bytes = CanonicalStore::encode_command_outcome(&stored)?;
                    let cmd_id = new_prefixed_hex_id("cmd_")?;
                    return Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "consume_chat_input".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "thread".to_owned(),
                            entity_id: input.thread.as_str().to_owned(),
                            op_kind: "edit".to_owned(),
                            rev_id: ev_rev,
                            lifecycle: Lifecycle::Active,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp_bytes.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp_bytes,
                    });
                }
                if status != "pending" {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if run_raw != input.expected_run.as_str() {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }

                let queued_leaf =
                    ThreadEntrySeq::new(u64::try_from(queued_raw).map_err(|_| {
                        internal_not_committed(
                            "corrupt_queued_leaf",
                            "negative queued_base_leaf_seq",
                        )
                    })?)?;

                // Verify continuation ancestry: `queued_leaf` must be an ancestor of (or equal to) `current_leaf`.
                let branch_matches = if queued_leaf == ThreadEntrySeq::ZERO {
                    if input.current_leaf == ThreadEntrySeq::ZERO {
                        true
                    } else {
                        load_entry_depth_and_taint_tx(
                            tx,
                            &scope.space_id,
                            &input.thread,
                            input.current_leaf,
                        )
                        .await?
                        .is_some()
                    }
                } else if input.current_leaf == ThreadEntrySeq::ZERO {
                    false
                } else {
                    let Some((cur_depth, _)) = load_entry_depth_and_taint_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.current_leaf,
                    )
                    .await?
                    else {
                        return Err(DomainError::ResourceNotFound.into());
                    };
                    let Some((queued_depth, _)) = load_entry_depth_and_taint_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        queued_leaf,
                    )
                    .await?
                    else {
                        return Err(DomainError::ResourceNotFound.into());
                    };
                    if cur_depth < queued_depth {
                        false
                    } else if cur_depth == queued_depth {
                        input.current_leaf == queued_leaf
                    } else {
                        jump_to_ancestor_at_depth_tx(
                            tx,
                            &scope.space_id,
                            &input.thread,
                            input.current_leaf,
                            queued_depth,
                        )
                        .await?
                            == Some(queued_leaf)
                    }
                };

                if !branch_matches {
                    // Leave `chat_pending_inputs` untouched in `status = 'pending'` so caller can decide explicitly!
                    let seq = item_ctx.alloc_next_seq()?;
                    let ev_rev = new_revision_id()?;
                    let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                    let stored = StoredCommittedConsumedPendingV1 {
                        value: StoredConsumedPendingV1::BranchChanged {
                            queued: queued_leaf,
                            current: input.current_leaf,
                        },
                        receipt,
                    };
                    let resp_bytes = CanonicalStore::encode_command_outcome(&stored)?;
                    let cmd_id = new_prefixed_hex_id("cmd_")?;
                    return Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "consume_chat_input".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "thread".to_owned(),
                            entity_id: input.thread.as_str().to_owned(),
                            op_kind: "edit".to_owned(),
                            rev_id: ev_rev,
                            lifecycle: Lifecycle::Active,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp_bytes.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp_bytes,
                    });
                }

                let (parent_opt, depth, anc_16, anc_256, parent_tainted) =
                    compute_skip_pointers_for_parent_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.current_leaf,
                    )
                    .await?;

                let effective_tainted = auth.taint().is_tainted() || parent_tainted;
                if effective_tainted
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                let author = PrincipalId::parse(&author_raw).map_err(|_| {
                    internal_not_committed("corrupt_pending_author", "invalid PrincipalId")
                })?;
                let entry_seq = th.next_entry_seq;
                let next_entry_seq = entry_seq.checked_next()?;
                let seq = item_ctx.alloc_next_seq()?;
                let entry_rev = new_revision_id()?;
                let new_thread_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                let (inline_for_entry, digest_opt, body_out) = if let Some(txt) = inline_opt {
                    (Some(txt.clone()), None, ChatBody::Inline(txt))
                } else if let Some(b) = blob_opt {
                    let arr: [u8; 32] = b.try_into().map_err(|_| {
                        internal_not_committed("corrupt_pending_digest", "digest != 32B")
                    })?;
                    let digest = ContentDigest::from_bytes(arr);
                    let entry_owner = format!("{}:{}", input.thread.as_str(), entry_seq.get());
                    bind_existing_active_blob_ref_tx(
                        tx,
                        &scope.space_id,
                        BlobOwnerKind::ChatEntry,
                        &entry_owner,
                        entry_rev.as_str(),
                        "body",
                        digest,
                        seq,
                    )
                    .await?;
                    let pending_owner =
                        format!("{}:{}", input.thread.as_str(), input.input.as_str());
                    let _ = release_owner_blob_refs_tx(
                        tx,
                        &scope.space_id,
                        BlobOwnerKind::ChatPendingInput,
                        &pending_owner,
                    )
                    .await?;
                    (None, Some(digest), ChatBody::Blob(digest))
                } else {
                    return Err(internal_not_committed(
                        "corrupt_pending_body",
                        "pending input missing body",
                    ));
                };

                insert_chat_entry_row_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_seq,
                    parent_opt,
                    &entry_rev,
                    "human",
                    None,
                    &author,
                    Some(&input.expected_run),
                    inline_for_entry.as_deref(),
                    digest_opt,
                    "[]",
                    effective_tainted,
                    depth,
                    anc_16,
                    anc_256,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE chat_pending_inputs
                             SET status = 'consumed', consumed_entry_seq = ?
                             WHERE space_id = ? AND thread_id = ? AND input_id = ?",
                        )
                        .bind(entry_seq.get() as i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.input.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_consume_pending", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE chat_pending_inputs
                             SET status = 'consumed', consumed_entry_seq = $1
                             WHERE space_id = $2 AND thread_id = $3 AND input_id = $4",
                        )
                        .bind(entry_seq.get() as i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(input.input.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_consume_pending", err.to_string())
                        })?;
                    }
                }

                let thread_tainted = (th.tainted_mask != 0) || effective_tainted;
                let taint_mask = i64::from(u8::from(thread_tainted));
                update_thread_after_append_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_seq,
                    &new_thread_rev,
                    next_entry_seq,
                    taint_mask,
                    seq_i64,
                    sec,
                    nsec,
                )
                .await?;

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                    ThreadRevisionMetadata {
                        thread_id: th.thread_id.clone(),
                        kind: th.kind,
                        owner_id: th.owner.clone(),
                        project_folder_id: th.project_folder.clone(),
                        title: th.title.clone(),
                        head_leaf_seq: entry_seq,
                        tainted: thread_tainted,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_thread_rev,
                    "thread",
                    th.thread_id.as_str(),
                    seq,
                    seq,
                    Some(&th.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    Some(&input.expected_run),
                    now_ts,
                )
                .await?;

                let entry_val = ChatEntry {
                    thread: input.thread.clone(),
                    seq: entry_seq,
                    parent: parent_opt,
                    is_chain_node: true,
                    depth,
                    ancestors: build_ancestors_vec(anc_16, anc_256),
                    author,
                    run: Some(input.expected_run),
                    kind: ChatEntryKind::Human,
                    body: body_out,
                    tainted: effective_tainted,
                    referenced_notes: Vec::new(),
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_full = StoredCommittedConsumedPendingV1 {
                    value: StoredConsumedPendingV1::Appended((&entry_val).into()),
                    receipt,
                };
                let stored_sanitized = stored_full.sanitized_for_redaction();
                let full_bytes = CanonicalStore::encode_command_outcome(&stored_full)?;
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&stored_sanitized)?;

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "consume_chat_input",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "consume_chat_input".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: input.thread.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_thread_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: Some(full_bytes.clone()),
                    receipt_sanitized_blob: sanitized_bytes,
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: full_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedConsumedPendingV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn redact_chat_entry_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RedactChatEntry>,
) -> Result<Committed<RedactedChat>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "thread={};entry={};expected_rev={}",
        request.input.thread.as_str(),
        request.input.entry.get(),
        request.input.expected_thread_revision.as_str()
    );
    let idemp = derive_command_identity_spec(&request.identity, "redact_chat_entry", fp.as_bytes());

    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedRedactedChatV1>(
        store,
        &space_rec.scope,
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        let (committed, zero_refs) = replayed.into_committed();
        if !zero_refs.is_empty() {
            let _ = store
                .retire_zero_ref_digests(
                    &space_rec.scope,
                    space_rec.active_epoch,
                    &zero_refs,
                    RetirementReason::Gc,
                    None,
                )
                .await;
        }
        return Ok(committed);
    }

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions;
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_chat_write_on_space(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                if input.expected_thread_revision != th.head_rev_id {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != th.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let entry_i64 = input.entry.get() as i64;
                let entry_info: Option<(Option<i64>, i64)> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let r = sqlx::query(
                            "SELECT parent_seq, created_space_seq FROM chat_entries
                             WHERE space_id = ? AND thread_id = ? AND entry_seq = ?",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(entry_i64)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_load_redact_entry", err.to_string())
                        })?;
                        r.map(|row| (row.get("parent_seq"), row.get("created_space_seq")))
                    }
                    BackendConn::Postgres(conn) => {
                        let r = sqlx::query(
                            "SELECT parent_seq, created_space_seq FROM chat_entries
                             WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(entry_i64)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_load_redact_entry", err.to_string())
                        })?;
                        r.map(|row| (row.get("parent_seq"), row.get("created_space_seq")))
                    }
                };

                let Some((direct_parent_opt, created_space_seq)) = entry_info else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                let seq = item_ctx.alloc_next_seq()?;
                let new_thread_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

                // Clear inline_text, payload_blake3, tool_call_id, referenced_notes_json; preserve parent/depth/skip connectivity!
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE chat_entries
                             SET kind = 'redacted', tool_call_id = NULL, inline_text = NULL,
                                 payload_blake3 = NULL, referenced_notes_json = '[]',
                                 is_chain_node = 1, redacted_at_seq = ?
                             WHERE space_id = ? AND thread_id = ? AND entry_seq = ?",
                        )
                        .bind(seq_i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(entry_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_redact_entry", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE chat_entries
                             SET kind = 'redacted', tool_call_id = NULL, inline_text = NULL,
                                 payload_blake3 = NULL, referenced_notes_json = '[]',
                                 is_chain_node = 1, redacted_at_seq = $1
                             WHERE space_id = $2 AND thread_id = $3 AND entry_seq = $4",
                        )
                        .bind(seq_i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .bind(entry_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_redact_entry", err.to_string())
                        })?;
                    }
                }

                // Release CAS reference owned by this chat entry!
                let entry_owner = format!("{}:{}", input.thread.as_str(), input.entry.get());
                let zero_ref_digests = release_owner_blob_refs_tx(
                    tx,
                    &scope.space_id,
                    BlobOwnerKind::ChatEntry,
                    &entry_owner,
                )
                .await?;

                // Sanitize original append/consume `command_receipts` detail payload so replaying never leaks redacted text!
                sanitize_chat_entry_receipt_tx(tx, &scope, created_space_seq).await?;

                // Walk strictly up `parent_seq` chain (NEVER `MAX(entry_seq)`) to nearest non-redacted ancestor!
                let nearest_non_redacted = match direct_parent_opt {
                    None => None,
                    Some(p_i64) => {
                        find_nearest_non_redacted_ancestor_tx(
                            tx,
                            &scope.space_id,
                            &input.thread,
                            p_i64,
                        )
                        .await?
                    }
                };

                // Mark ONLY true descendant `compaction` checkpoints stale along `parent_seq` (sibling forks untouched)!
                let invalidated_contexts = mark_descendant_compactions_stale_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_i64,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE chat_threads
                             SET head_rev_id = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                             WHERE space_id = ? AND thread_id = ?",
                        )
                        .bind(new_thread_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_upd_thread_redact", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE chat_threads
                             SET head_rev_id = $1, updated_seq = $2, updated_at_sec = $3, updated_at_nsec = $4
                             WHERE space_id = $5 AND thread_id = $6",
                        )
                        .bind(new_thread_rev.as_str())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(scope.space_id.as_str())
                        .bind(input.thread.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_upd_thread_redact", err.to_string()))?;
                    }
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                    ThreadRevisionMetadata {
                        thread_id: th.thread_id.clone(),
                        kind: th.kind,
                        owner_id: th.owner.clone(),
                        project_folder_id: th.project_folder.clone(),
                        title: th.title.clone(),
                        head_leaf_seq: th.head_leaf_seq,
                        tainted: th.tainted_mask != 0,
                    },
                ))
                .encode()?;

                let run_opt = extract_agent_run_from_auth(&auth);
                insert_revision_row(
                    tx,
                    &scope,
                    &new_thread_rev,
                    "thread",
                    th.thread_id.as_str(),
                    seq,
                    seq,
                    Some(&th.head_rev_id),
                    None,
                    None,
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_resp = StoredCommittedRedactedChatV1 {
                    value: StoredRedactedChatV1 {
                        thread: input.thread.clone(),
                        entry: input.entry,
                        parent: nearest_non_redacted,
                        invalidated_contexts,
                        zero_ref_digests,
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "redact_chat_entry",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "redact_chat_entry".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "thread".to_owned(),
                        entity_id: input.thread.as_str().to_owned(),
                        op_kind: "redact".to_owned(),
                        rev_id: new_thread_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedRedactedChatV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    let (committed, zero_refs) = stored.into_committed();
    if !zero_refs.is_empty() {
        // Best-effort physical GC when no backup holds block retirement; ref_count is already 0.
        let _ = store
            .retire_zero_ref_digests(
                &space_rec.scope,
                space_rec.active_epoch,
                &zero_refs,
                RetirementReason::Gc,
                None,
            )
            .await;
    }
    Ok(committed)
}

async fn sanitize_chat_entry_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    created_space_seq: i64,
) -> Result<(), PortError> {
    let payload_ids: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let pids: Vec<String> = sqlx::query_scalar(
                "SELECT response_payload_id FROM command_receipts
                 WHERE space_id = ? AND history_incarnation = ? AND canonical_seq = ?
                   AND response_payload_id IS NOT NULL",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(created_space_seq)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_find_chat_rcpt", err.to_string()))?;

            sqlx::query(
                "UPDATE command_receipts SET response_payload_id = NULL
                 WHERE space_id = ? AND history_incarnation = ? AND canonical_seq = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(created_space_seq)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_null_chat_rcpt", err.to_string()))?;
            pids
        }
        BackendConn::Postgres(conn) => {
            let pids: Vec<String> = sqlx::query_scalar(
                "SELECT response_payload_id FROM command_receipts
                 WHERE space_id = $1 AND history_incarnation = $2 AND canonical_seq = $3
                   AND response_payload_id IS NOT NULL",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(created_space_seq)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_find_chat_rcpt", err.to_string()))?;

            sqlx::query(
                "UPDATE command_receipts SET response_payload_id = NULL
                 WHERE space_id = $1 AND history_incarnation = $2 AND canonical_seq = $3",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(created_space_seq)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_null_chat_rcpt", err.to_string()))?;
            pids
        }
    };

    for pid in payload_ids {
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE change_payloads SET erased_by_purge = 1, effect_msgpack = NULL
                     WHERE space_id = ? AND payload_id = ?",
                )
                .bind(scope.space_id.as_str())
                .bind(&pid)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_erase_chat_rcpt", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE change_payloads SET erased_by_purge = 1, effect_msgpack = NULL
                     WHERE space_id = $1 AND payload_id = $2",
                )
                .bind(scope.space_id.as_str())
                .bind(&pid)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_erase_chat_rcpt", err.to_string()))?;
            }
        }
    }
    Ok(())
}

async fn find_nearest_non_redacted_ancestor_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    start_parent_seq: i64,
) -> Result<Option<ThreadEntrySeq>, PortError> {
    let found_opt: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "WITH RECURSIVE anc(entry_seq, parent_seq, kind, hops) AS (
                 SELECT entry_seq, parent_seq, kind, 0
                 FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?
                 UNION ALL
                 SELECT e.entry_seq, e.parent_seq, e.kind, a.hops + 1
                 FROM anc a
                 JOIN chat_entries e
                   ON e.space_id = ? AND e.thread_id = ? AND e.entry_seq = a.parent_seq
                 WHERE a.kind = 'redacted' AND a.parent_seq IS NOT NULL AND a.hops < 100000
             )
             SELECT entry_seq FROM anc WHERE kind <> 'redacted' ORDER BY hops ASC LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(start_parent_seq)
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_nearest_non_redacted", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "WITH RECURSIVE anc(entry_seq, parent_seq, kind, hops) AS (
                 SELECT entry_seq, parent_seq, kind, 0::BIGINT
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
                 UNION ALL
                 SELECT e.entry_seq, e.parent_seq, e.kind, a.hops + 1
                 FROM anc a
                 JOIN chat_entries e
                   ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = a.parent_seq
                 WHERE a.kind = 'redacted' AND a.parent_seq IS NOT NULL AND a.hops < 100000
             )
             SELECT entry_seq FROM anc WHERE kind <> 'redacted' ORDER BY hops ASC LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(start_parent_seq)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_nearest_non_redacted", err.to_string()))?,
    };

    match found_opt {
        Some(raw) => Ok(Some(ThreadEntrySeq::new(u64::try_from(raw).map_err(
            |_| internal_not_committed("corrupt_non_redacted_seq", "negative entry_seq"),
        )?)?)),
        None => Ok(None),
    }
}

async fn mark_descendant_compactions_stale_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_id: &ChatThreadId,
    target_entry_seq: i64,
) -> Result<Vec<ThreadEntrySeq>, PortError> {
    let raw_seqs: Vec<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "WITH RECURSIVE desc_tree(entry_seq, kind) AS (
                 SELECT entry_seq, kind
                 FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND parent_seq = ?
                 UNION ALL
                 SELECT c.entry_seq, c.kind
                 FROM desc_tree d
                 JOIN chat_entries c
                   ON c.space_id = ? AND c.thread_id = ? AND c.parent_seq = d.entry_seq
             )
             SELECT entry_seq FROM desc_tree WHERE kind = 'compaction' ORDER BY entry_seq ASC",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(target_entry_seq)
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_desc_compactions", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "WITH RECURSIVE desc_tree(entry_seq, kind) AS (
                 SELECT entry_seq, kind
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND parent_seq = $3
                 UNION ALL
                 SELECT c.entry_seq, c.kind
                 FROM desc_tree d
                 JOIN chat_entries c
                   ON c.space_id = $1 AND c.thread_id = $2 AND c.parent_seq = d.entry_seq
             )
             SELECT entry_seq FROM desc_tree WHERE kind = 'compaction' ORDER BY entry_seq ASC",
        )
        .bind(space_id.as_str())
        .bind(thread_id.as_str())
        .bind(target_entry_seq)
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_desc_compactions", err.to_string()))?,
    };

    let mut out = Vec::with_capacity(raw_seqs.len());
    for raw in raw_seqs {
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE chat_entries SET checkpoint_stale = 1
                     WHERE space_id = ? AND thread_id = ? AND entry_seq = ?",
                )
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(raw)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_mark_compaction_stale", err.to_string())
                })?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE chat_entries SET checkpoint_stale = 1
                     WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3",
                )
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(raw)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_mark_compaction_stale", err.to_string())
                })?;
            }
        }
        out.push(ThreadEntrySeq::new(u64::try_from(raw).map_err(|_| {
            internal_not_committed("corrupt_compaction_seq", "negative entry_seq")
        })?)?);
    }

    Ok(out)
}

mod compaction;
mod content;
mod queue;
pub mod search;
mod staging;
mod submission;

#[cfg(feature = "test-support")]
pub use compaction::THREAD_TAINTED_RANGE_SQL;
#[cfg(feature = "test-support")]
pub use queue::OTHER_HUMAN_ON_BRANCH_SQL;

#[cfg(feature = "test-support")]
pub mod preparation_test {
    use std::{cell::Cell, future::Future, sync::Arc};
    use tokio::sync::Barrier;

    tokio::task_local! {
        static PAUSE: Cell<Option<Arc<Barrier>>>;
    }

    /// Let a competing command commit after this command's receipt miss and
    /// before its prefix validation or first proof page.
    pub async fn pause_once<T>(barrier: Arc<Barrier>, command: impl Future<Output = T>) -> T {
        PAUSE.scope(Cell::new(Some(barrier)), command).await
    }

    pub(super) async fn pause() {
        if let Ok(Some(barrier)) = PAUSE.try_with(Cell::take) {
            barrier.wait().await;
            barrier.wait().await;
        }
    }
}

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) use content::{
    ProofFoldCache, chat_source_tx, load_current_chat_for_egress_tx, verify_confirmed_chat_step_tx,
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind, Space, SpaceKind, SpaceLifecycle},
    error::{PortError, ValidationReason},
    ids::{
        AgentRunId, ChatThreadId, CommandKey, ContentDigest, FolderId, LeaseEpoch, PendingInputId,
        PrincipalId, RevisionId, SpaceId, SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, Lifecycle, NoteRef},
    ports::{
        AppendChat, CanonicalChatProposal, ChatBody, ChatBranch, ChatContentRead, ChatEntry,
        ChatEntryKind, ChatInputBody, ChatPort, ChatProposalRead, ChatRead, ChatRunRequest,
        ChatThread, ChatThreadKind, ClaimChatRun, ClaimChatRunOutcome, Committed, ConsumePending,
        ConsumedPending, CreateChat, DismissPending, FinishChatRunOutcome, ForkChat,
        HydratedChatEntry, Mutation, PendingChatInput, PortFuture, Preconditions,
        QueueInputOutcome, QueuedChatInput, QueuedInput, RedactChatEntry, RedactedChat,
        SpaceContext, StagedChatBlob, SubmitUserChatInput, SubmitUserChatOutcome,
    },
    receipt::MutationReceiptToken,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, PreparedBlobSource, PublicationDiscard,
        RetirementReason, StagedBlobTicket, activate_and_bind_blob_ref_tx,
        bind_existing_active_blob_ref_tx, count_reachable_refs_tx, release_owner_blob_refs_tx,
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
            CommandDeadline, FolderAncestryCache, derive_command_identity_spec,
            extract_agent_run_from_auth, load_note_head_row_tx, validate_mutation_identity,
        },
        notes::{read_space_and_receipt, try_replay_completed_receipt},
    },
    runtime::{
        insert_revision_row, is_note_purge_fenced_tx, load_folder_head_row, load_space_record,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, ItemExecCtx, PreparedWriteIntent},
};
use submission::{StoredQueuedChatMetadataV1, StoredUserChatSubmissionV1, UserInputReceipt};

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
    #[serde(default)]
    title: String,
    #[serde(default)]
    active_run: Option<AgentRunId>,
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
            title: t.title.clone(),
            active_run: t.active_run.clone(),
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
            title: s.title,
            active_run: s.active_run,
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

pub(crate) fn recorded_reference_digest(detail: &[u8]) -> Option<ContentDigest> {
    let recorded: StoredCommittedChatEntryV1 = rmp_serde::from_slice(detail).ok()?;
    if matches!(recorded.value.body, StoredChatBodyV1::Redacted) {
        return None;
    }
    Some(crate::writer::fingerprint::chat_reference_digest(
        &recorded.value.referenced_notes,
    ))
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
    AppendedWithIntervention {
        entry: StoredChatEntryV1,
        intervening_human: bool,
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
            StoredConsumedPendingV1::Appended(entry) => ConsumedPending::Appended {
                entry: Box::new(entry.into()),
                intervening_human: true,
            },
            StoredConsumedPendingV1::AppendedWithIntervention {
                entry,
                intervening_human,
            } => ConsumedPending::Appended {
                entry: Box::new(entry.into()),
                intervening_human,
            },
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
            StoredConsumedPendingV1::Appended(e)
            | StoredConsumedPendingV1::AppendedWithIntervention { entry: e, .. } => {
                let mut copy = e.clone();
                copy.is_chain_node = true;
                copy.kind = StoredChatEntryKindV1::Redacted;
                copy.body = StoredChatBodyV1::Redacted;
                copy.referenced_notes = Vec::new();
                Self {
                    value: StoredConsumedPendingV1::AppendedWithIntervention {
                        entry: copy,
                        intervening_human: true,
                    },
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
        Box::pin(async move {
            if store.is_postgres() {
                return Self::run_pg_read_request(
                    ctx.budget.clone(),
                    read_chat_impl(&store, ctx, request),
                )
                .await;
            }
            read_chat_impl(&store, ctx, request).await
        })
    }

    fn read_chat_context(
        &self,
        ctx: SpaceContext,
        request: ChatRead,
    ) -> PortFuture<'_, ChatBranch> {
        Box::pin(compaction::context(self, ctx, request))
    }

    fn read_chat_compaction_prefix(
        &self,
        ctx: SpaceContext,
        request: ChatRead,
    ) -> PortFuture<'_, notarium_core::ports::ChatCompactionPrefix> {
        Box::pin(compaction::hydrated_prefix(self, ctx, request))
    }

    fn read_chat_contents(
        &self,
        ctx: SpaceContext,
        request: ChatContentRead,
    ) -> PortFuture<'_, Vec<HydratedChatEntry>> {
        Box::pin(content::read_chat_contents(self, ctx, request))
    }

    fn read_chat_proposal(
        &self,
        ctx: SpaceContext,
        request: ChatProposalRead,
    ) -> PortFuture<'_, CanonicalChatProposal> {
        Box::pin(content::read_chat_proposal(self, ctx, request))
    }

    fn stage_chat_blob(&self, ctx: SpaceContext, text: String) -> PortFuture<'_, StagedChatBlob> {
        Box::pin(async move { CanonicalStore::stage_chat_blob(self, ctx, &text).await })
    }

    fn discard_staged_chat_blob(
        &self,
        ctx: SpaceContext,
        staged: StagedChatBlob,
    ) -> PortFuture<'_, ()> {
        Box::pin(CanonicalStore::discard_staged_chat_blob(self, ctx, staged))
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

    fn submit_user_chat_input(
        &self,
        ctx: SpaceContext,
        request: SubmitUserChatInput,
    ) -> PortFuture<'_, SubmitUserChatOutcome> {
        Box::pin(submission::submit(self, ctx, request))
    }

    fn lookup_user_chat_input(
        &self,
        ctx: SpaceContext,
        request: &SubmitUserChatInput,
    ) -> PortFuture<'_, Option<SubmitUserChatOutcome>> {
        let idemp = submission::identity(&ctx, request);
        Box::pin(async move { submission::lookup(self, ctx, idemp?).await })
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

    fn list_pending_chat_inputs(
        &self,
        ctx: SpaceContext,
        thread: ChatThreadId,
    ) -> PortFuture<'_, Vec<QueuedChatInput>> {
        Box::pin(queue::list_pending(self, ctx, thread))
    }

    fn dismiss_chat_input(
        &self,
        ctx: SpaceContext,
        request: DismissPending,
    ) -> PortFuture<'_, bool> {
        Box::pin(queue::dismiss_pending(self, ctx, request))
    }

    fn claim_active_run(
        &self,
        ctx: SpaceContext,
        request: ClaimChatRun,
    ) -> PortFuture<'_, ClaimChatRunOutcome> {
        Box::pin(queue::claim(self, ctx, request))
    }

    fn finish_run_if_queue_empty(
        &self,
        ctx: SpaceContext,
        request: ChatRunRequest,
    ) -> PortFuture<'_, FinishChatRunOutcome> {
        Box::pin(queue::finish(self, ctx, request, false))
    }

    fn recover_active_run(
        &self,
        ctx: SpaceContext,
        request: ChatRunRequest,
    ) -> PortFuture<'_, FinishChatRunOutcome> {
        Box::pin(queue::finish(self, ctx, request, true))
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
        if ctx.confirmed_chat_step().is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        let deadline =
            crate::domain::common::CommandDeadline::start(&ctx.budget, "stage_chat_blob");
        let byte_len = raw.len() as u64;
        let attested = StagedChatBlob::attest_canonical(
            ctx.scope().space_id.clone(),
            ctx.auth().principal().clone(),
            ContentDigest::from_bytes(*blake3::hash(raw.as_bytes()).as_bytes()),
            byte_len,
        )?;

        let space_rec = deadline
            .prepare(&ctx.budget, || {
                self.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
            })
            .await?;
        space_rec.scope.check(ctx.scope())?;
        authorize_chat_write_on_space(ctx.auth(), &space_rec.space)?;
        if let Some(effect) = ctx.canonical_effect() {
            effect.check()?;
        }

        let prepared = PreparedBlobSource::prepare(raw.as_bytes(), self.blob_codec())?;
        let ticket = deadline
            .prepare(&ctx.budget, || {
                self.stage_blob_for_batch(&space_rec.scope, space_rec.active_epoch, &prepared)
            })
            .await?;

        let scope = space_rec.scope.clone();
        let staged_epoch = space_rec.active_epoch;
        let auth_cl = ctx.auth().clone();
        let owner_id = ctx.auth().principal().as_str().to_owned();
        let mut lease = [0u8; 16];
        getrandom::fill(&mut lease)
            .map_err(|err| internal_not_committed("chat_staging_lease", err.to_string()))?;
        let resource_key = staging::request_key(ctx.auth(), &ctx.budget.request);
        let publish_ticket = ticket.clone();
        let publisher = self.clone();
        let abort_publisher = self.clone();
        type PublishedBlobGuard = std::sync::Arc<
            std::sync::Mutex<
                Option<(
                    crate::blobs::StagedBlobTicket,
                    Vec<(SpaceId, ContentDigest)>,
                )>,
            >,
        >;
        let published_guard: PublishedBlobGuard = std::sync::Arc::new(std::sync::Mutex::new(None));
        let published_guard_op = std::sync::Arc::clone(&published_guard);
        let published_guard_abort = std::sync::Arc::clone(&published_guard);
        let effect = ctx.canonical_effect().cloned();
        let value = self
            .with_guarded_auxiliary_command_with_abort_cleanup(
                ctx.scope().space_id.clone(),
                None,
                Some((&ctx.budget, deadline)),
                effect,
                Ok,
                move || {
                    Box::pin(async move {
                        let pending = published_guard_abort
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take();
                        if let Some((held_ticket, newly_published)) = pending {
                            // Release our LocalSharedGuard BEFORE scheduling synchronized
                            // orphan cleanup off the writer/effect path so we never deadlock.
                            drop(held_ticket);
                            abort_publisher
                                .schedule_unretained_local_files_cleanup(newly_published);
                        }
                    })
                },
                move |tx, effect| {
                    Box::pin(async move {
                        let live_space =
                            crate::runtime::load_space_record_for_update_opt(tx, &scope.space_id)
                                .await?
                                .ok_or(DomainError::ResourceNotFound)?;
                        effect.begin().await?;
                        live_space.scope.check(&scope)?;
                        publisher.inner.check_writer_epoch(
                            &live_space.scope.space_id,
                            live_space.active_epoch,
                        )?;
                        authorize_chat_write_on_space(&auth_cl, &live_space.space)?;
                        if live_space.active_epoch != staged_epoch {
                            return Err(crate::codec::unavailable_retryable(
                                "stage_chat_blob_epoch_changed",
                                "Space active_epoch changed while staging chat blob",
                                std::time::Duration::from_millis(25),
                            ));
                        }
                        let owner_lease =
                            staged_chat_lease_key(lease, auth_cl.taint().is_tainted());
                        activate_and_bind_blob_ref_tx(
                            tx,
                            &live_space.scope,
                            live_space.active_epoch,
                            &BlobReferenceClaim {
                                ticket,
                                owner_kind: BlobOwnerKind::StagedChat,
                                owner_id,
                                owner_rev_id: owner_lease.clone(),
                                resource_key,
                            },
                            live_space.last_seq,
                        )
                        .await?;
                        effect.check()?;
                        let mut newly_published = Vec::new();
                        let pub_res = publisher
                            .publish_deferred_local_tickets_async(
                                std::slice::from_ref(&publish_ticket),
                                &mut newly_published,
                            )
                            .await;
                        *published_guard_op.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((publish_ticket, newly_published));
                        let dirs = pub_res?;
                        publisher.flush_pending_local_dirs_async(&dirs).await?;
                        Ok(staging::UndeliveredLease::new(
                            publisher,
                            scope,
                            attested.with_lease(lease),
                            owner_lease,
                        ))
                    })
                },
            )
            .await?;
        drop(
            published_guard
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(),
        );
        Ok(value.deliver())
    }
}

pub(super) async fn filter_branch_referenced_notes_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    entries: &mut [ChatEntry],
) -> Result<(), PortError> {
    let mut by_space: std::collections::BTreeMap<SpaceId, Vec<notarium_core::ids::NoteId>> =
        std::collections::BTreeMap::new();
    let mut seen: std::collections::HashSet<(SpaceId, notarium_core::ids::NoteId)> =
        std::collections::HashSet::new();
    for entry in entries.iter() {
        for note_ref in &entry.referenced_notes {
            if seen.insert((note_ref.space_id.clone(), note_ref.note_id.clone())) {
                by_space
                    .entry(note_ref.space_id.clone())
                    .or_default()
                    .push(note_ref.note_id.clone());
            }
        }
    }
    if by_space.is_empty() {
        return Ok(());
    }

    let mut readable: std::collections::HashSet<(SpaceId, notarium_core::ids::NoteId)> =
        std::collections::HashSet::new();
    let mut folder_cache = crate::domain::common::FolderAncestryCache::default();

    for (target_space_id, note_ids) in by_space {
        let target_space: Option<Space> = if target_space_id == space.id {
            Some(space.clone())
        } else if auth
            .spaces()
            .get(&target_space_id)
            .is_none_or(|grant| grant.read_classes.is_empty())
        {
            None
        } else {
            crate::domain::common::optional_read(
                crate::runtime::load_space_record(tx, &target_space_id).await,
            )?
            .filter(|rec| rec.space.lifecycle == SpaceLifecycle::Active)
            .map(|rec| rec.space)
        };
        let Some(target_space) = target_space else {
            continue;
        };

        for chunk in note_ids.chunks(200) {
            let rows: Vec<(String, String, String, Option<String>)> = match tx {
                BackendConn::Sqlite(conn) => {
                    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                        "SELECT nh.note_id, nh.parent_folder_id, nh.doc_class, nh.ability_id
                         FROM note_heads nh
                         WHERE nh.space_id = ",
                    );
                    qb.push_bind(target_space.id.as_str())
                        .push(" AND nh.lifecycle_state = 'active' AND nh.note_id IN (");
                    let mut sep = qb.separated(", ");
                    for nid in chunk {
                        sep.push_bind(nid.as_str());
                    }
                    sep.push_unseparated(
                        ") AND NOT EXISTS (
                            SELECT 1 FROM revision_purge_fences pf
                            WHERE pf.space_id = nh.space_id AND pf.note_id = nh.note_id
                         )",
                    );
                    qb.build()
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_batch_chat_refs", err.to_string())
                        })?
                        .into_iter()
                        .map(|r| {
                            (
                                r.get("note_id"),
                                r.get("parent_folder_id"),
                                r.get("doc_class"),
                                r.get("ability_id"),
                            )
                        })
                        .collect()
                }
                BackendConn::Postgres(conn) => {
                    let ids: Vec<&str> = chunk.iter().map(|n| n.as_str()).collect();
                    sqlx::query(
                        "SELECT nh.note_id, nh.parent_folder_id, nh.doc_class, nh.ability_id
                         FROM note_heads nh
                         WHERE nh.space_id = $1
                           AND nh.lifecycle_state = 'active'
                           AND nh.note_id = ANY($2::text[])
                           AND NOT EXISTS (
                               SELECT 1 FROM revision_purge_fences pf
                               WHERE pf.space_id = nh.space_id AND pf.note_id = nh.note_id
                           )",
                    )
                    .bind(target_space.id.as_str())
                    .bind(&ids)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_batch_chat_refs", err))?
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("note_id"),
                            r.get("parent_folder_id"),
                            r.get("doc_class"),
                            r.get("ability_id"),
                        )
                    })
                    .collect()
                }
            };
            for (nid_raw, parent_raw, class_raw, ability_raw) in rows {
                let note_id = notarium_core::ids::NoteId::parse(&nid_raw)
                    .map_err(|_| internal_not_committed("corrupt_ref_nid", "invalid note_id"))?;
                let parent_id = notarium_core::ids::FolderId::parse(&parent_raw)
                    .map_err(|_| internal_not_committed("corrupt_ref_fid", "invalid folder_id"))?;
                let doc_class = crate::codec::doc_class_from_db(&class_raw)?;
                let ability_id = ability_raw
                    .as_deref()
                    .map(notarium_core::ids::AbilityId::parse)
                    .transpose()
                    .map_err(|_| internal_not_committed("corrupt_ref_aid", "invalid ability_id"))?;
                if let Some((facts, _)) = crate::domain::common::optional_read(
                    folder_cache
                        .build_resource_facts_tx(
                            tx,
                            &target_space,
                            &parent_id,
                            doc_class,
                            ability_id,
                            true,
                        )
                        .await,
                )? && auth.can_view_resource(&facts).is_ok()
                {
                    readable.insert((target_space.id.clone(), note_id));
                }
            }
        }
    }

    for entry in entries.iter_mut() {
        if !entry.referenced_notes.is_empty() {
            entry
                .referenced_notes
                .retain(|nref| readable.contains(&(nref.space_id.clone(), nref.note_id.clone())));
        }
    }
    Ok(())
}

fn filter_branch_referenced_notes_rusqlite(
    conn: &rusqlite::Connection,
    space: &Space,
    auth: &EngineAuthContext,
    entries: &mut [ChatEntry],
) -> Result<(), PortError> {
    let mut by_space: std::collections::BTreeMap<SpaceId, Vec<notarium_core::ids::NoteId>> =
        std::collections::BTreeMap::new();
    let mut seen: std::collections::HashSet<(SpaceId, notarium_core::ids::NoteId)> =
        std::collections::HashSet::new();
    for entry in entries.iter() {
        for note_ref in &entry.referenced_notes {
            if seen.insert((note_ref.space_id.clone(), note_ref.note_id.clone())) {
                by_space
                    .entry(note_ref.space_id.clone())
                    .or_default()
                    .push(note_ref.note_id.clone());
            }
        }
    }
    if by_space.is_empty() {
        return Ok(());
    }

    let mut readable: std::collections::HashSet<(SpaceId, notarium_core::ids::NoteId)> =
        std::collections::HashSet::new();
    let mut placement_cache: std::collections::HashMap<
        (
            SpaceId,
            notarium_core::ids::FolderId,
            notarium_core::classes::DocClass,
            Option<notarium_core::ids::AbilityId>,
        ),
        bool,
    > = std::collections::HashMap::new();

    for (target_space_id, note_ids) in by_space {
        let target_space: Option<Space> = if target_space_id == space.id {
            Some(space.clone())
        } else if auth
            .spaces()
            .get(&target_space_id)
            .is_none_or(|grant| grant.read_classes.is_empty())
        {
            None
        } else {
            crate::domain::common::optional_read(crate::sqlite_fast::load_space_record_rusqlite(
                conn,
                &target_space_id,
            ))?
            .filter(|rec| rec.space.lifecycle == SpaceLifecycle::Active)
            .map(|rec| rec.space)
        };
        let Some(target_space) = target_space else {
            continue;
        };

        for chunk in note_ids.chunks(200) {
            let mut sql = String::from(
                "SELECT nh.note_id, nh.parent_folder_id, nh.doc_class, nh.ability_id
                 FROM note_heads nh
                 WHERE nh.space_id = ?1 AND nh.lifecycle_state = 'active' AND nh.note_id IN (",
            );
            for idx in 0..chunk.len() {
                if idx > 0 {
                    sql.push(',');
                }
                sql.push('?');
                sql.push_str(&(idx + 2).to_string());
            }
            sql.push_str(
                ") AND NOT EXISTS (
                    SELECT 1 FROM revision_purge_fences pf
                    WHERE pf.space_id = nh.space_id AND pf.note_id = nh.note_id
                 )",
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            let sp_str = target_space.id.as_str();
            params.push(&sp_str);
            let id_strs: Vec<&str> = chunk.iter().map(|n| n.as_str()).collect();
            for s in &id_strs {
                params.push(s);
            }
            let mut stmt = conn.prepare(&sql).map_err(|err| {
                internal_not_committed("rusqlite_batch_chat_refs_prep", err.to_string())
            })?;
            let rows = stmt
                .query_map(params.as_slice(), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|err| {
                    internal_not_committed("rusqlite_batch_chat_refs_query", err.to_string())
                })?;
            for row in rows {
                let (nid_raw, parent_raw, class_raw, ability_raw) = row.map_err(|err| {
                    internal_not_committed("rusqlite_batch_chat_refs_row", err.to_string())
                })?;
                let note_id = notarium_core::ids::NoteId::parse(&nid_raw)
                    .map_err(|_| internal_not_committed("corrupt_ref_nid", "invalid note_id"))?;
                let parent_id = notarium_core::ids::FolderId::parse(&parent_raw)
                    .map_err(|_| internal_not_committed("corrupt_ref_fid", "invalid folder_id"))?;
                let doc_class = crate::codec::doc_class_from_db(&class_raw)?;
                let ability_id = ability_raw
                    .as_deref()
                    .map(notarium_core::ids::AbilityId::parse)
                    .transpose()
                    .map_err(|_| internal_not_committed("corrupt_ref_aid", "invalid ability_id"))?;
                let pkey = (
                    target_space.id.clone(),
                    parent_id.clone(),
                    doc_class,
                    ability_id.clone(),
                );
                let ok = if let Some(&cached) = placement_cache.get(&pkey) {
                    cached
                } else {
                    let allowed = match crate::domain::common::optional_read(
                        crate::sqlite_fast::build_resource_facts_rusqlite(
                            conn,
                            &target_space,
                            &parent_id,
                            doc_class,
                            ability_id,
                            true,
                        ),
                    )? {
                        Some((facts, _)) => auth.can_view_resource(&facts).is_ok(),
                        None => false,
                    };
                    placement_cache.insert(pkey, allowed);
                    allowed
                };
                if ok {
                    readable.insert((target_space.id.clone(), note_id));
                }
            }
        }
    }

    for entry in entries.iter_mut() {
        if !entry.referenced_notes.is_empty() {
            entry
                .referenced_notes
                .retain(|nref| readable.contains(&(nref.space_id.clone(), nref.note_id.clone())));
        }
    }
    Ok(())
}

fn authorize_chat_write_on_space(auth: &EngineAuthContext, space: &Space) -> Result<(), PortError> {
    if space.lifecycle != SpaceLifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    auth.authorize_write_space_pin(space)?;
    if auth.spaces()[&space.id].project_root.is_some()
        && auth.keeper_log().is_none()
        && !matches!(auth.kind(), PrincipalKind::AgentRun(_))
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

fn forbid_project_agent_run(auth: &EngineAuthContext, space: &Space) -> Result<(), PortError> {
    if matches!(auth.kind(), PrincipalKind::AgentRun(_))
        && auth
            .spaces()
            .get(&space.id)
            .is_some_and(|grant| grant.project_root.is_some())
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

fn forbid_keeper_chat_mutation(auth: &EngineAuthContext) -> Result<(), PortError> {
    if matches!(auth.kind(), PrincipalKind::Keeper(_)) || auth.keeper_log().is_some() {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

/// Change listings have no selected leaf, so use the live thread audit state.
pub(crate) async fn can_view_live_thread_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    thread: &ChatThreadId,
) -> Result<bool, PortError> {
    let head = load_thread_head_tx(tx, &space.id, thread).await?;
    auth.can_view_chat_thread(
        space,
        thread,
        head.kind,
        &head.owner,
        head.project_folder.as_ref(),
        head.tainted_mask != 0,
    )?;
    Ok(head.tainted_mask != 0)
}

pub(crate) async fn authorize_chat_replay_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    thread: &ChatThreadId,
    leaf: Option<ThreadEntrySeq>,
    legacy_staged: bool,
) -> Result<(), PortError> {
    authorize_chat_write_on_space(auth, space)?;
    let th = load_thread_head_opt_tx(tx, &space.id, thread)
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    let tainted = match leaf {
        Some(leaf) => read_leaf_taint(tx, &space.id, thread, leaf).await?,
        None => th.tainted_mask != 0,
    };
    authorize_thread_mutation(auth, space, &th, tainted || legacy_staged)
}

fn authorize_thread_mutation(
    auth: &EngineAuthContext,
    space: &Space,
    th: &ThreadHeadRow,
    tainted: bool,
) -> Result<(), PortError> {
    authorize_thread_mutation_inner(auth, space, th, tainted, true)
}

/// Active-run claim lifecycle check (`finish_run_if_queue_empty`,
/// `list_pending_chat_inputs`, `dismiss_chat_input` by the live claim owner):
/// enforces all space/thread/grant/project/audience/ownership/leaf-taint gates
/// without rejecting a run whose own `auth.taint()` flipped cross-space during
/// a turn, so a tainted Personal chat in a Shared Space can still release its
/// `active_run_id` claim cleanly instead of wedging the thread.
fn authorize_thread_claim_lifecycle(
    auth: &EngineAuthContext,
    space: &Space,
    th: &ThreadHeadRow,
    tainted: bool,
) -> Result<(), PortError> {
    authorize_thread_mutation_inner(auth, space, th, tainted, false)
}

fn authorize_thread_mutation_inner(
    auth: &EngineAuthContext,
    space: &Space,
    th: &ThreadHeadRow,
    tainted: bool,
    enforce_caller_taint: bool,
) -> Result<(), PortError> {
    if space.lifecycle != SpaceLifecycle::Active || !auth.spaces().contains_key(&space.id) {
        return Err(DomainError::ResourceNotFound.into());
    }
    // Verify visibility and Personal-chat/KeeperLog/project-scope read access
    // BEFORE returning SpaceReadOnly or CrossSpaceTainted so callers cannot
    // distinguish invisible threads from absent threads.
    auth.can_view_chat_thread(
        space,
        &th.thread_id,
        th.kind,
        &th.owner,
        th.project_folder.as_ref(),
        false,
    )?;
    if (matches!(auth.kind(), PrincipalKind::Keeper(_)) || auth.keeper_log().is_some())
        && (th.kind != ChatThreadKind::KeeperLog
            || auth.keeper_log() != Some(&th.thread_id)
            || auth
                .spaces()
                .get(&space.id)
                .and_then(|grant| grant.project_root.as_ref())
                != th.project_folder.as_ref())
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    if matches!(auth.kind(), PrincipalKind::AgentRun(_))
        && (th.kind == ChatThreadKind::KeeperLog
            || auth
                .spaces()
                .get(&space.id)
                .and_then(|grant| grant.project_root.as_ref())
                .is_some_and(|root| th.project_folder.as_ref() != Some(root)))
    {
        return Err(DomainError::SpaceReadOnly.into());
    }
    auth.can_view_chat_thread(
        space,
        &th.thread_id,
        th.kind,
        &th.owner,
        th.project_folder.as_ref(),
        tainted,
    )?;
    if ((enforce_caller_taint && auth.taint().is_tainted()) || tainted)
        && (th.kind == ChatThreadKind::SpaceGroup || space.kind == SpaceKind::Shared)
    {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    auth.mark_chat_read_taint(space, tainted);
    Ok(())
}

async fn read_leaf_taint(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    leaf: ThreadEntrySeq,
) -> Result<bool, PortError> {
    if leaf == ThreadEntrySeq::ZERO {
        return Ok(false);
    }
    load_entry_depth_and_taint_tx(tx, space, thread, leaf)
        .await?
        .map(|(_, tainted)| tainted)
        .ok_or_else(|| DomainError::ResourceNotFound.into())
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
    active_run_id: Option<AgentRunId>,
    active_run_epoch: Option<LeaseEpoch>,
    active_run_generation: Option<String>,
    tainted_mask: i64,
    redaction_epoch: i64,
}

#[allow(clippy::type_complexity)]
fn parse_thread_head_row(
    thread_id: ChatThreadId,
    raw: (
        String,
        String,
        Option<String>,
        String,
        i64,
        String,
        i64,
        Option<String>,
        i64,
        Option<i64>,
        Option<String>,
        i64,
    ),
) -> Result<ThreadHeadRow, PortError> {
    let (
        kind_raw,
        owner_raw,
        proj_opt,
        title,
        head_leaf_raw,
        head_rev_raw,
        next_entry_raw,
        run_opt,
        tainted_mask,
        raw_epoch,
        active_run_generation,
        redaction_epoch,
    ) = raw;
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

    Ok(ThreadHeadRow {
        thread_id,
        kind,
        owner,
        project_folder,
        title,
        head_leaf_seq,
        head_rev_id,
        next_entry_seq,
        active_run_id,
        active_run_epoch: raw_epoch
            .map(|epoch| LeaseEpoch::new(epoch as u64))
            .transpose()?,
        active_run_generation,
        tainted_mask,
        redaction_epoch,
    })
}

async fn load_thread_heads_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    thread_ids: &[ChatThreadId],
) -> Result<std::collections::BTreeMap<ChatThreadId, ThreadHeadRow>, PortError> {
    let mut out = std::collections::BTreeMap::new();
    if thread_ids.is_empty() {
        return Ok(out);
    }
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        String,
        i64,
        String,
        i64,
        Option<String>,
        i64,
        Option<i64>,
        Option<String>,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut acc = Vec::with_capacity(thread_ids.len());
            for chunk in thread_ids.chunks(200) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT thread_id, kind, owner_id, project_folder_id, title, head_leaf_seq,
                            head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask,
                            active_run_epoch, active_run_generation, redaction_epoch
                     FROM chat_threads WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str());
                qb.push(" AND thread_id IN (");
                let mut sep = qb.separated(", ");
                for id in chunk {
                    sep.push_bind(id.as_str());
                }
                qb.push(")");
                let part = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_load_threads_batch", err.to_string())
                })?;
                for row in part {
                    acc.push((
                        row.get("thread_id"),
                        row.get("kind"),
                        row.get("owner_id"),
                        row.get("project_folder_id"),
                        row.get("title"),
                        row.get("head_leaf_seq"),
                        row.get("head_rev_id"),
                        row.get("next_entry_seq"),
                        row.get("active_run_id"),
                        row.get("ext_space_tainted_mask"),
                        row.get("active_run_epoch"),
                        row.get("active_run_generation"),
                        row.get("redaction_epoch"),
                    ));
                }
            }
            acc
        }
        BackendConn::Postgres(conn) => {
            let id_strs: Vec<&str> = thread_ids.iter().map(ChatThreadId::as_str).collect();
            let part = sqlx::query(
                "SELECT thread_id, kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask::BIGINT AS tainted_mask,
                        active_run_epoch, active_run_generation, redaction_epoch
                 FROM chat_threads WHERE space_id = $1 AND thread_id = ANY($2)",
            )
            .bind(space_id.as_str())
            .bind(&id_strs)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_threads_batch", err))?;
            part.into_iter()
                .map(|row| {
                    (
                        row.get("thread_id"),
                        row.get("kind"),
                        row.get("owner_id"),
                        row.get("project_folder_id"),
                        row.get("title"),
                        row.get("head_leaf_seq"),
                        row.get("head_rev_id"),
                        row.get("next_entry_seq"),
                        row.get("active_run_id"),
                        row.get("tainted_mask"),
                        row.get("active_run_epoch"),
                        row.get("active_run_generation"),
                        row.get("redaction_epoch"),
                    )
                })
                .collect()
        }
    };
    for (
        thread_raw,
        kind_raw,
        owner_raw,
        proj_opt,
        title,
        head_leaf_raw,
        head_rev_raw,
        next_entry_raw,
        run_opt,
        tainted_mask,
        raw_epoch,
        active_run_generation,
        redaction_epoch,
    ) in rows
    {
        let thread_id = ChatThreadId::parse(&thread_raw)
            .map_err(|_| internal_not_committed("corrupt_thread_id", "invalid thread_id"))?;
        let head = parse_thread_head_row(
            thread_id.clone(),
            (
                kind_raw,
                owner_raw,
                proj_opt,
                title,
                head_leaf_raw,
                head_rev_raw,
                next_entry_raw,
                run_opt,
                tainted_mask,
                raw_epoch,
                active_run_generation,
                redaction_epoch,
            ),
        )?;
        out.insert(thread_id, head);
    }
    Ok(out)
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
        Option<i64>,
        Option<String>,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask,
                        active_run_epoch, active_run_generation, redaction_epoch
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
                    row.get("active_run_epoch"),
                    row.get("active_run_generation"),
                    row.get("redaction_epoch"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask::BIGINT AS tainted_mask,
                        active_run_epoch, active_run_generation, redaction_epoch
                 FROM chat_threads WHERE space_id = $1 AND thread_id = $2",
            )
            .bind(space_id.as_str())
            .bind(thread_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_thread", err))?;
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
                    row.get("active_run_epoch"),
                    row.get("active_run_generation"),
                    row.get("redaction_epoch"),
                )
            })
        }
    };

    raw.map(|row| parse_thread_head_row(thread_id.clone(), row))
        .transpose()
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
        .map_err(|err| crate::runtime::pg_read_error("pg_jump_ancestor", err))?,
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
            .map_err(|err| crate::runtime::pg_read_error("pg_entry_depth", err))?;
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

fn staged_chat_lease_key(lease: [u8; 16], tainted: bool) -> String {
    let prefix = if tainted { "st2t_" } else { "st2c_" };
    format!("{prefix}{:032x}", u128::from_be_bytes(lease))
}

async fn lookup_staged_chat_lease_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    staged: &StagedChatBlob,
) -> Result<String, PortError> {
    let legacy = i32::from(staged.lease().is_none());
    let clean_key = staged
        .lease()
        .map(|lease| staged_chat_lease_key(lease, false))
        .unwrap_or_default();
    let tainted_key = staged
        .lease()
        .map(|lease| staged_chat_lease_key(lease, true))
        .unwrap_or_default();
    let digest = staged.digest();
    let lease_opt: Option<(String, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT r.owner_rev_id, c.raw_size
                 FROM blob_references r
                 JOIN blob_catalog c
                   ON c.space_id = r.space_id AND c.content_blake3 = r.content_blake3
                 WHERE r.space_id = ? AND r.owner_kind = 'staged_chat'
                   AND r.owner_id = ?2 AND r.content_blake3 = ?3
                   AND ((?4 = 1 AND substr(r.owner_rev_id,1,4) = 'stg_')
                   OR (?4 = 0 AND r.owner_rev_id IN (?5,?6)))
                   AND c.blob_state = 'active' AND c.admission_state = 'open'
                 ORDER BY r.created_seq, r.owner_rev_id
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(digest.as_bytes().as_slice())
            .bind(legacy)
            .bind(&clean_key)
            .bind(&tainted_key)
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
                   AND r.owner_id = $2 AND r.content_blake3 = $3
                   AND (($4::int = 1 AND substr(r.owner_rev_id,1,4) = 'stg_')
                   OR ($4::int = 0 AND r.owner_rev_id IN ($5,$6)))
                   AND c.blob_state = 'active' AND c.admission_state = 'open'
                 ORDER BY r.created_seq, r.owner_rev_id COLLATE \"C\"
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .bind(staged.owner().as_str())
            .bind(digest.as_bytes().as_slice())
            .bind(legacy)
            .bind(&clean_key)
            .bind(&tainted_key)
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

    Ok(staging_lease)
}

#[allow(clippy::too_many_arguments)]
async fn consume_one_staged_chat_ref_and_bind_entry_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    staged: &StagedChatBlob,
    staging_lease: &str,
    thread_id: &ChatThreadId,
    entry_seq: ThreadEntrySeq,
    entry_rev_id: &RevisionId,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    let digest = staged.digest();
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

    remove_staging_lease_tx(tx, space_id, staged, staging_lease).await?;
    Ok(())
}

async fn remove_staging_lease_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    staged: &StagedChatBlob,
    staging_lease: &str,
) -> Result<Option<i64>, PortError> {
    let digest = staged.digest();
    // Release the single consumed staging lease and recompute exact `ref_count`.
    let now_ms = now_unix_ms()?;
    let affected = match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "DELETE FROM blob_references
                 WHERE space_id = ? AND owner_kind = 'staged_chat'
                   AND owner_id = ? AND owner_rev_id = ? AND content_blake3 = ?",
        )
        .bind(space_id.as_str())
        .bind(staged.owner().as_str())
        .bind(staging_lease)
        .bind(digest.as_bytes().as_slice())
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_del_staged_chat", err.to_string()))?
        .rows_affected(),
        BackendConn::Postgres(conn) => sqlx::query(
            "DELETE FROM blob_references
                 WHERE space_id = $1 AND owner_kind = 'staged_chat'
                   AND owner_id = $2 AND owner_rev_id = $3 AND content_blake3 = $4",
        )
        .bind(space_id.as_str())
        .bind(staged.owner().as_str())
        .bind(staging_lease)
        .bind(digest.as_bytes().as_slice())
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_del_staged_chat", err.to_string()))?
        .rows_affected(),
    };
    if affected == 0 {
        return Ok(None);
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

    Ok(Some(exact_count))
}

async fn read_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<ChatBranch, PortError> {
    store.ensure_open()?;
    if let crate::runtime::SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql {
        let wal = store.inner.wal_coord.get().ok_or_else(|| {
            internal_not_committed(
                "sqlite_wal_coord_missing",
                "SqliteWalCoordinator not initialized",
            )
        })?;
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        return fast_read_pool
            .with_read_conn(wal, Some(&ctx.budget), move |conn| {
                read_chat_rusqlite(conn, &scope, &auth, &request)
            })
            .await;
    }

    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();

    if store.is_postgres() && request.before.is_none() && request.leaf != ThreadEntrySeq::ZERO {
        return store
            .with_pg_autocommit_read_budget(Some(&ctx.budget), |conn| {
                Box::pin(
                    async move { read_chat_pg_single_query(conn, &scope, &auth, &request).await },
                )
            })
            .await;
    }

    // Every table lookup in `read_chat` (`spaces`, `chat_threads`, `chat_entries`) is an exact
    // primary-key probe. Disable `seqscan` locally inside the PostgreSQL `BEGIN READ ONLY`
    // Simple Query for multi-statement `before: Some(...)` reads.
    store
        .with_read_tx_budget_pg_local_sql(
            Some(&ctx.budget),
            Some("SET LOCAL enable_seqscan = off"),
            |tx| {
                Box::pin(async move {
                    let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                auth.can_view_chat_thread(&srec.space, &request.thread, th.kind,
                    &th.owner, th.project_folder.as_ref(), false)?;
                let thread_tainted = read_leaf_taint(tx, &scope.space_id, &request.thread, request.leaf).await?;
                auth.authorize_chat_thread_read(&srec.space, &request.thread, th.kind,
                    &th.owner, th.project_folder.as_ref(), thread_tainted)?;

                let thread_out = ChatThread {
                    id: th.thread_id.clone(),
                    space: scope.space_id.clone(),
                    kind: th.kind,
                    owner: th.owner,
                    project_folder: th.project_folder,
                    head: th.head_leaf_seq,
                    revision: th.head_rev_id,
                    tainted: thread_tainted,
                    title: th.title,
                    active_run: th.active_run_id,
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

                let window_tip = match request.before {
                    None => request.leaf,
                    Some(anc_seq) => {
                        let Some((leaf_depth, _)) = load_entry_depth_and_taint_tx(
                            tx,
                            &scope.space_id,
                            &request.thread,
                            request.leaf,
                        )
                        .await?
                        else {
                            return Err(DomainError::ResourceNotFound.into());
                        };
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
                                 SELECT entry_seq, parent_seq,
                                        CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END, tool_call_id, author_id,
                                        agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                        ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, 1
                                 FROM chat_entries
                                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?
                                 UNION ALL
                                 SELECT e.entry_seq, e.parent_seq,
                                        CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END, e.tool_call_id, e.author_id,
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
                                 SELECT entry_seq, parent_seq,
                                        CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END, tool_call_id, author_id,
                                        agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                        ext_space_tainted::BIGINT, is_chain_node::BIGINT, branch_depth::BIGINT,
                                        anc_16_seq, anc_256_seq, 1::BIGINT
                                 FROM chat_entries
                                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
                                 UNION ALL
                                 SELECT e.entry_seq, e.parent_seq,
                                        CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END, e.tool_call_id, e.author_id,
                                        e.agent_run_id, e.inline_text, e.payload_blake3, e.referenced_notes_json,
                                        e.ext_space_tainted::BIGINT, e.is_chain_node::BIGINT, e.branch_depth::BIGINT,
                                        e.anc_16_seq, e.anc_256_seq, w.n + 1
                                 FROM win w
                                 CROSS JOIN LATERAL (
                                     SELECT entry_seq, parent_seq, kind, checkpoint_stale, tool_call_id, author_id,
                                            agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                                            ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq
                                     FROM chat_entries ce
                                     WHERE ce.space_id = $1 AND ce.thread_id = $2 AND ce.entry_seq = w.parent_seq
                                     LIMIT 1
                                 ) e
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
                        .map_err(|err| crate::runtime::pg_read_error("pg_read_chat_win", err))?;

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

                if raw_rows.is_empty() {
                    return Err(DomainError::ResourceNotFound.into());
                }

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
                    let referenced_notes: Vec<NoteRef> = if kind == ChatEntryKind::Redacted || refs_json == "[]" {
                        Vec::new()
                    } else {
                        serde_json::from_str(&refs_json).map_err(|err| {
                            internal_not_committed("corrupt_chat_refs", err.to_string())
                        })?
                    };
                    let depth = u32::try_from(depth_raw).map_err(|_| {
                        internal_not_committed("corrupt_chat_depth", "invalid depth")
                    })?;
                    let entry_taint = taint_raw != 0;
                    if entry_taint {
                        auth.authorize_chat_thread_read(
                            &srec.space,
                            &thread_out.id,
                            thread_out.kind,
                            &thread_out.owner,
                            thread_out.project_folder.as_ref(),
                            true,
                        )?;
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

                filter_branch_referenced_notes_tx(tx, &srec.space, &auth, &mut entries).await?;
                let next_ancestor = entries.first().and_then(|oldest| oldest.parent);
                Ok(ChatBranch {
                    thread: thread_out,
                    entries,
                    next_ancestor,
                })
            })
        },
    )
    .await
}

async fn read_chat_pg_single_query(
    conn: &mut sqlx::PgConnection,
    scope: &HistoryScope,
    auth: &EngineAuthContext,
    request: &ChatRead,
) -> Result<ChatBranch, PortError> {
    let tip_i64 = request.leaf.get() as i64;
    // Read the header and exactly the requested parent chain at one MVCC cut.
    // A lateral point lookup bounds every hop by the composite entry primary key.
    let rows = sqlx::query(
        "SELECT
            CASE WHEN COALESCE(w.n, 1) = 1 THEN s.history_incarnation ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN s.space_kind ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN s.lifecycle_state ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.thread_id ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.kind ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.owner_id ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.project_folder_id ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.head_leaf_seq ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.head_rev_id ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.ext_space_tainted_mask ELSE NULL END,
            w.entry_seq,
            w.parent_seq,
            w.kind,
            w.tool_call_id,
            w.author_id,
            w.agent_run_id,
            w.inline_text,
            w.payload_blake3,
            w.referenced_notes_json,
            w.ext_space_tainted,
            w.is_chain_node,
            w.branch_depth,
            w.anc_16_seq,
            w.anc_256_seq,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.title ELSE NULL END,
            CASE WHEN COALESCE(w.n, 1) = 1 THEN ct.active_run_id ELSE NULL END
         FROM spaces s
         LEFT JOIN chat_threads ct
           ON ct.space_id = s.space_id AND ct.thread_id = $2
         LEFT JOIN LATERAL (
             WITH RECURSIVE win AS (
                 SELECT e.entry_seq, e.parent_seq,
                        CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END AS kind,
                        e.tool_call_id, e.author_id, e.agent_run_id, e.inline_text,
                        e.payload_blake3, e.referenced_notes_json, e.ext_space_tainted,
                        e.is_chain_node, e.branch_depth, e.anc_16_seq, e.anc_256_seq, 1::BIGINT AS n
                 FROM chat_entries e
                 WHERE e.space_id = ct.space_id AND e.thread_id = ct.thread_id AND e.entry_seq = $3
                 UNION ALL
                 SELECT parent.*, w.n + 1
                 FROM win w
                 CROSS JOIN LATERAL (
                     SELECT e.entry_seq, e.parent_seq,
                            CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END AS kind,
                            e.tool_call_id, e.author_id, e.agent_run_id, e.inline_text,
                            e.payload_blake3, e.referenced_notes_json, e.ext_space_tainted,
                            e.is_chain_node, e.branch_depth, e.anc_16_seq, e.anc_256_seq
                     FROM chat_entries e
                     WHERE e.space_id = ct.space_id AND e.thread_id = ct.thread_id AND e.entry_seq = w.parent_seq
                     LIMIT 1
                 ) parent
                 WHERE w.n < $4 AND w.parent_seq IS NOT NULL
             )
             SELECT * FROM win
         ) w ON ct.thread_id IS NOT NULL
         WHERE s.space_id = $1
         ORDER BY w.n DESC",
    )
    .bind(scope.space_id.as_str())
    .bind(request.thread.as_str())
    .bind(tip_i64)
    .bind(i64::from(request.max_entries.get()))
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| crate::runtime::pg_read_error("pg_read_chat_single", err))?;

    // Descending hop count returns the oldest entry first and the tip/header last.
    let hdr = rows.last().ok_or(DomainError::ResourceNotFound)?;

    let inc_bytes: &[u8] = hdr
        .get::<Option<&[u8]>, usize>(0)
        .ok_or_else(|| internal_not_committed("corrupt_incarnation", "missing incarnation"))?;
    let inc_arr: [u8; 16] = inc_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_incarnation", "incarnation not 16 bytes"))?;
    let db_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: notarium_core::ids::HistoryIncarnation::from_bytes(inc_arr),
    };
    db_scope.check(scope)?;

    let s_kind_raw: &str = hdr
        .get::<Option<&str>, usize>(1)
        .ok_or_else(|| internal_not_committed("corrupt_space_kind", "missing space_kind"))?;
    let s_lc_raw: &str = hdr
        .get::<Option<&str>, usize>(2)
        .ok_or_else(|| internal_not_committed("corrupt_space_lifecycle", "missing lifecycle"))?;
    let space_kind = match s_kind_raw {
        "personal" => SpaceKind::Personal,
        "shared" => SpaceKind::Shared,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_kind",
                format!("unexpected space_kind '{other}'"),
            ));
        }
    };
    let space_lc = match s_lc_raw {
        "active" => SpaceLifecycle::Active,
        "closing" => SpaceLifecycle::Closing,
        "archived" => SpaceLifecycle::Archived,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_lifecycle",
                format!("unexpected space lifecycle '{other}'"),
            ));
        }
    };
    let space = Space {
        id: scope.space_id.clone(),
        lifecycle: space_lc,
        kind: space_kind,
    };

    let ct_id_opt: Option<&str> = hdr.get::<Option<&str>, usize>(3);
    if ct_id_opt.is_none() {
        return Err(DomainError::ResourceNotFound.into());
    }
    let ct_kind_raw: &str = hdr
        .get::<Option<&str>, usize>(4)
        .ok_or_else(|| internal_not_committed("corrupt_thread_kind", "missing thread kind"))?;
    let ct_owner_raw: &str = hdr
        .get::<Option<&str>, usize>(5)
        .ok_or_else(|| internal_not_committed("corrupt_thread_owner", "missing owner_id"))?;
    let ct_proj_raw: Option<&str> = hdr.get::<Option<&str>, usize>(6);
    let ct_head_leaf_raw: i64 = hdr
        .get::<Option<i64>, usize>(7)
        .ok_or_else(|| internal_not_committed("corrupt_head_leaf", "missing head_leaf_seq"))?;
    let ct_head_rev_raw: &str = hdr
        .get::<Option<&str>, usize>(8)
        .ok_or_else(|| internal_not_committed("corrupt_thread_rev", "missing head_rev_id"))?;

    let th_kind = chat_thread_kind_from_db(ct_kind_raw)?;
    let th_owner = PrincipalId::parse(ct_owner_raw)
        .map_err(|_| internal_not_committed("corrupt_thread_owner", "invalid owner_id"))?;
    let th_proj = match ct_proj_raw {
        Some(s) => Some(
            FolderId::parse(s)
                .map_err(|_| internal_not_committed("corrupt_thread_proj", "invalid FolderId"))?,
        ),
        None => None,
    };
    let th_head = ThreadEntrySeq::new(
        u64::try_from(ct_head_leaf_raw)
            .map_err(|_| internal_not_committed("corrupt_head_leaf", "negative head_leaf_seq"))?,
    )?;
    let th_rev = RevisionId::parse(ct_head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_thread_rev", "invalid head_rev_id"))?;
    auth.can_view_chat_thread(
        &space,
        &request.thread,
        th_kind,
        &th_owner,
        th_proj.as_ref(),
        false,
    )?;

    let first_e_seq: Option<i64> = hdr.get::<Option<i64>, usize>(10);
    if first_e_seq != Some(tip_i64) {
        return Err(DomainError::ResourceNotFound.into());
    }

    let thread_tainted = hdr.get::<i32, usize>(19) != 0;
    auth.authorize_chat_thread_read(
        &space,
        &request.thread,
        th_kind,
        &th_owner,
        th_proj.as_ref(),
        thread_tainted,
    )?;
    let title = hdr
        .get::<Option<String>, usize>(24)
        .ok_or_else(|| internal_not_committed("corrupt_thread_title", "missing title"))?;
    let active_run = hdr
        .get::<Option<String>, usize>(25)
        .as_deref()
        .map(AgentRunId::parse)
        .transpose()?;

    let thread_out = ChatThread {
        id: request.thread.clone(),
        space: scope.space_id.clone(),
        kind: th_kind,
        owner: th_owner,
        project_folder: th_proj,
        head: th_head,
        revision: th_rev,
        tainted: thread_tainted,
        title,
        active_run,
    };

    let decode_entry_row = |r: &sqlx::postgres::PgRow,
                            base_col: usize|
     -> Result<ChatEntry, PortError> {
        let e_seq_raw: i64 = r.get::<i64, usize>(base_col);
        let p_seq_opt: Option<i64> = r.get::<Option<i64>, usize>(base_col + 1);
        let k_str: &str = r.get::<&str, usize>(base_col + 2);
        let tc_opt: Option<&str> = r.get::<Option<&str>, usize>(base_col + 3);
        let author_str: &str = r.get::<&str, usize>(base_col + 4);
        let run_opt: Option<&str> = r.get::<Option<&str>, usize>(base_col + 5);
        let inline_opt: Option<&str> = r.get::<Option<&str>, usize>(base_col + 6);
        let blob_opt: Option<&[u8]> = r.get::<Option<&[u8]>, usize>(base_col + 7);
        let refs_json: &str = r.get::<&str, usize>(base_col + 8);
        let taint_raw: i32 = r.get::<i32, usize>(base_col + 9);
        let chain_raw: i32 = r.get::<i32, usize>(base_col + 10);
        let depth_raw: i32 = r.get::<i32, usize>(base_col + 11);
        let a16_opt: Option<i64> = r.get::<Option<i64>, usize>(base_col + 12);
        let a256_opt: Option<i64> = r.get::<Option<i64>, usize>(base_col + 13);

        let seq = ThreadEntrySeq::new(
            u64::try_from(e_seq_raw)
                .map_err(|_| internal_not_committed("corrupt_entry_seq", "negative entry_seq"))?,
        )?;
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
        let kind = entry_kind_from_db(k_str, tc_opt.map(str::to_owned))?;
        let body = if kind == ChatEntryKind::Redacted {
            ChatBody::Redacted
        } else if let Some(txt) = inline_opt {
            ChatBody::Inline(txt.to_owned())
        } else if let Some(b) = blob_opt {
            let arr: [u8; 32] = b
                .try_into()
                .map_err(|_| internal_not_committed("corrupt_chat_blob", "digest != 32B"))?;
            ChatBody::Blob(ContentDigest::from_bytes(arr))
        } else {
            return Err(internal_not_committed(
                "corrupt_chat_body",
                "entry lacks inline_text and payload_blake3",
            ));
        };
        let author = PrincipalId::parse(author_str)
            .map_err(|_| internal_not_committed("corrupt_chat_author", "invalid PrincipalId"))?;
        let run =
            match run_opt {
                Some(s) => Some(AgentRunId::parse(s).map_err(|_| {
                    internal_not_committed("corrupt_chat_run", "invalid AgentRunId")
                })?),
                None => None,
            };
        let referenced_notes: Vec<NoteRef> = if kind == ChatEntryKind::Redacted || refs_json == "[]"
        {
            Vec::new()
        } else {
            serde_json::from_str(refs_json)
                .map_err(|err| internal_not_committed("corrupt_chat_refs", err.to_string()))?
        };
        let depth = u32::try_from(depth_raw)
            .map_err(|_| internal_not_committed("corrupt_chat_depth", "invalid depth"))?;
        let entry_taint = taint_raw != 0;
        if entry_taint {
            auth.authorize_chat_thread_read(
                &space,
                &thread_out.id,
                thread_out.kind,
                &thread_out.owner,
                thread_out.project_folder.as_ref(),
                true,
            )?;
        }

        Ok(ChatEntry {
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
        })
    };

    let mut entries = Vec::with_capacity(rows.len());
    for row in &rows {
        entries.push(decode_entry_row(row, 10)?);
    }
    let mut backend = BackendConn::Postgres(conn);
    filter_branch_referenced_notes_tx(&mut backend, &space, auth, &mut entries).await?;
    let next_ancestor = entries.first().and_then(|oldest| oldest.parent);
    Ok(ChatBranch {
        thread: thread_out,
        entries,
        next_ancestor,
    })
}

fn read_chat_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    auth: &EngineAuthContext,
    request: &ChatRead,
) -> Result<ChatBranch, PortError> {
    use rusqlite::{OptionalExtension, params};

    let srec = crate::sqlite_fast::load_space_record_rusqlite(conn, &scope.space_id)?;
    srec.scope.check(scope)?;

    let th =
        {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT kind, owner_id, project_folder_id, title, head_leaf_seq,
                        head_rev_id, next_entry_seq, active_run_id, ext_space_tainted_mask
                 FROM chat_threads WHERE space_id = ?1 AND thread_id = ?2",
                )
                .map_err(|err| internal_not_committed("sqlite_load_thread", err.to_string()))?;
            let raw = stmt
                .query_row(
                    params![scope.space_id.as_str(), request.thread.as_str()],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, i64>(6)?,
                            r.get::<_, Option<String>>(7)?,
                            r.get::<_, i64>(8)?,
                        ))
                    },
                )
                .optional()
                .map_err(|err| {
                    crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_load_thread")
                })?
                .ok_or(DomainError::ResourceNotFound)?;

            let kind = chat_thread_kind_from_db(&raw.0)?;
            let owner = PrincipalId::parse(&raw.1)
                .map_err(|_| internal_not_committed("corrupt_thread_owner", "invalid owner_id"))?;
            let project_folder = match raw.2 {
                Some(s) => Some(FolderId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_thread_proj", "invalid FolderId")
                })?),
                None => None,
            };
            let head_leaf_seq = ThreadEntrySeq::new(u64::try_from(raw.4).map_err(|_| {
                internal_not_committed("corrupt_head_leaf", "negative head_leaf_seq")
            })?)?;
            let head_rev_id = RevisionId::parse(&raw.5)
                .map_err(|_| internal_not_committed("corrupt_thread_rev", "invalid head_rev_id"))?;
            let next_entry_seq = ThreadEntrySeq::new(u64::try_from(raw.6).map_err(|_| {
                internal_not_committed("corrupt_next_entry", "negative next_entry_seq")
            })?)?;
            let active_run_id = match raw.7 {
                Some(s) => Some(AgentRunId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_thread_run", "invalid AgentRunId")
                })?),
                None => None,
            };
            ThreadHeadRow {
                thread_id: request.thread.clone(),
                kind,
                owner,
                project_folder,
                title: raw.3,
                head_leaf_seq,
                head_rev_id,
                next_entry_seq,
                active_run_id,
                active_run_epoch: None,
                active_run_generation: None,
                tainted_mask: raw.8,
                redaction_epoch: 0,
            }
        };

    auth.can_view_chat_thread(
        &srec.space,
        &request.thread,
        th.kind,
        &th.owner,
        th.project_folder.as_ref(),
        false,
    )?;
    let thread_tainted = if request.leaf == ThreadEntrySeq::ZERO {
        false
    } else {
        conn.prepare_cached(
            "SELECT ext_space_tainted FROM chat_entries
                WHERE space_id = ?1 AND thread_id = ?2 AND entry_seq = ?3",
        )
        .and_then(|mut statement| {
            statement.query_row(
                params![
                    scope.space_id.as_str(),
                    request.thread.as_str(),
                    request.leaf.get() as i64
                ],
                |row| row.get::<_, i64>(0),
            )
        })
        .optional()
        .map_err(|err| {
            crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_chat_leaf_taint")
        })?
        .ok_or(DomainError::ResourceNotFound)?
            != 0
    };
    auth.authorize_chat_thread_read(
        &srec.space,
        &request.thread,
        th.kind,
        &th.owner,
        th.project_folder.as_ref(),
        thread_tainted,
    )?;

    let thread_out = ChatThread {
        id: th.thread_id,
        space: scope.space_id.clone(),
        kind: th.kind,
        owner: th.owner,
        project_folder: th.project_folder,
        head: th.head_leaf_seq,
        revision: th.head_rev_id,
        tainted: thread_tainted,
        title: th.title,
        active_run: th.active_run_id,
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

    let load_depth_rusqlite = |seq: ThreadEntrySeq| -> Result<Option<u32>, PortError> {
        let mut dstmt = conn
            .prepare_cached(
                "SELECT branch_depth FROM chat_entries
                 WHERE space_id = ?1 AND thread_id = ?2 AND entry_seq = ?3",
            )
            .map_err(|err| internal_not_committed("sqlite_entry_depth", err.to_string()))?;
        let d_opt: Option<i64> = dstmt
            .query_row(
                params![
                    scope.space_id.as_str(),
                    request.thread.as_str(),
                    seq.get() as i64
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(|err| {
                crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_entry_depth")
            })?;
        match d_opt {
            Some(d) => Ok(Some(u32::try_from(d).map_err(|_| {
                internal_not_committed("corrupt_branch_depth", "invalid branch_depth")
            })?)),
            None => Ok(None),
        }
    };

    let window_tip = match request.before {
        None => request.leaf,
        Some(anc_seq) => {
            let Some(leaf_depth) = load_depth_rusqlite(request.leaf)? else {
                return Err(DomainError::ResourceNotFound.into());
            };
            if anc_seq == ThreadEntrySeq::ZERO {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
            let Some(anc_depth) = load_depth_rusqlite(anc_seq)? else {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            };
            if anc_depth >= leaf_depth {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
            let mut jstmt = conn
                .prepare_cached(
                    "WITH RECURSIVE jump(entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, hops) AS (
                         SELECT entry_seq, branch_depth, parent_seq, anc_16_seq, anc_256_seq, 0
                         FROM chat_entries
                         WHERE space_id = ?1 AND thread_id = ?2 AND entry_seq = ?3
                         UNION ALL
                         SELECT e.entry_seq, e.branch_depth, e.parent_seq, e.anc_16_seq, e.anc_256_seq, j.hops + 1
                         FROM jump j
                         CROSS JOIN chat_entries e
                         WHERE e.space_id = ?1
                           AND e.thread_id = ?2
                           AND e.entry_seq = CASE
                               WHEN j.branch_depth - ?4 >= 256 AND j.anc_256_seq IS NOT NULL THEN j.anc_256_seq
                               WHEN j.branch_depth - ?4 >= 16 AND j.anc_16_seq IS NOT NULL THEN j.anc_16_seq
                               ELSE j.parent_seq
                           END
                           AND j.branch_depth > ?4 AND j.hops < 100000
                     )
                     SELECT entry_seq FROM jump WHERE branch_depth = ?4 LIMIT 1",
                )
                .map_err(|err| internal_not_committed("sqlite_jump_ancestor", err.to_string()))?;
            let landed_opt: Option<i64> = jstmt
                .query_row(
                    params![
                        scope.space_id.as_str(),
                        request.thread.as_str(),
                        request.leaf.get() as i64,
                        i64::from(anc_depth),
                    ],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|err| {
                    crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_jump_ancestor")
                })?;
            let actual_anc = match landed_opt {
                Some(raw) => Some(ThreadEntrySeq::new(u64::try_from(raw).map_err(|_| {
                    internal_not_committed("corrupt_jump_seq", "negative entry_seq")
                })?)?),
                None => None,
            };
            if actual_anc != Some(anc_seq) {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
            anc_seq
        }
    };

    let max_n = i64::from(request.max_entries.get());
    let tip_i64 = window_tip.get() as i64;

    let mut wstmt = conn
        .prepare_cached(
            "WITH RECURSIVE win(
                 entry_seq, parent_seq, kind, tool_call_id, author_id,
                 agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                 ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, n
             ) AS (
                 SELECT entry_seq, parent_seq,
                        CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END, tool_call_id, author_id,
                        agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                        ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq, 1
                 FROM chat_entries
                 WHERE space_id = ?1 AND thread_id = ?2 AND entry_seq = ?3
                 UNION ALL
                 SELECT e.entry_seq, e.parent_seq,
                        CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END, e.tool_call_id, e.author_id,
                        e.agent_run_id, e.inline_text, e.payload_blake3, e.referenced_notes_json,
                        e.ext_space_tainted, e.is_chain_node, e.branch_depth, e.anc_16_seq, e.anc_256_seq, w.n + 1
                 FROM win w
                 CROSS JOIN chat_entries e
                 WHERE e.space_id = ?1 AND e.thread_id = ?2 AND e.entry_seq = w.parent_seq
                   AND w.parent_seq IS NOT NULL AND w.n < ?4
             )
             SELECT entry_seq, parent_seq, kind, tool_call_id, author_id,
                    agent_run_id, inline_text, payload_blake3, referenced_notes_json,
                    ext_space_tainted, is_chain_node, branch_depth, anc_16_seq, anc_256_seq
             FROM win
             ORDER BY branch_depth ASC",
        )
        .map_err(|err| internal_not_committed("sqlite_read_chat_win", err.to_string()))?;

    let rows = wstmt
        .query_map(
            params![
                scope.space_id.as_str(),
                request.thread.as_str(),
                tip_i64,
                max_n
            ],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<Vec<u8>>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, i64>(11)?,
                    r.get::<_, Option<i64>>(12)?,
                    r.get::<_, Option<i64>>(13)?,
                ))
            },
        )
        .map_err(|err| {
            crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_read_chat_win")
        })?;

    let mut entries = Vec::with_capacity(usize::from(request.max_entries.get().min(256)));
    for item in rows {
        let (
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
        ) = item.map_err(|err| {
            crate::sqlite_fast::map_interrupt_or_internal(err, "sqlite_read_chat_win")
        })?;
        let seq = ThreadEntrySeq::new(
            u64::try_from(e_seq_raw)
                .map_err(|_| internal_not_committed("corrupt_entry_seq", "negative entry_seq"))?,
        )?;
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
            let arr: [u8; 32] = b
                .try_into()
                .map_err(|_| internal_not_committed("corrupt_chat_blob", "digest != 32B"))?;
            ChatBody::Blob(ContentDigest::from_bytes(arr))
        } else {
            return Err(internal_not_committed(
                "corrupt_chat_body",
                "entry lacks inline_text and payload_blake3",
            ));
        };
        let author = PrincipalId::parse(&author_str)
            .map_err(|_| internal_not_committed("corrupt_chat_author", "invalid PrincipalId"))?;
        let run =
            match run_opt {
                Some(s) => Some(AgentRunId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_chat_run", "invalid AgentRunId")
                })?),
                None => None,
            };
        let referenced_notes: Vec<NoteRef> = if kind == ChatEntryKind::Redacted || refs_json == "[]"
        {
            Vec::new()
        } else {
            serde_json::from_str(&refs_json)
                .map_err(|err| internal_not_committed("corrupt_chat_refs", err.to_string()))?
        };
        let depth = u32::try_from(depth_raw)
            .map_err(|_| internal_not_committed("corrupt_chat_depth", "invalid depth"))?;
        let entry_taint = taint_raw != 0;
        if entry_taint {
            auth.authorize_chat_thread_read(
                &srec.space,
                &thread_out.id,
                thread_out.kind,
                &thread_out.owner,
                thread_out.project_folder.as_ref(),
                true,
            )?;
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

    if entries.is_empty() {
        return Err(DomainError::ResourceNotFound.into());
    }

    filter_branch_referenced_notes_rusqlite(conn, &srec.space, auth, &mut entries)?;
    let next_ancestor = entries.first().and_then(|oldest| oldest.parent);
    Ok(ChatBranch {
        thread: thread_out,
        entries,
        next_ancestor,
    })
}

async fn create_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<CreateChat>,
) -> Result<Committed<ChatThread>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "create_chat");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;
    if request.input.owner != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if request.input.title.trim().is_empty() || request.input.title.contains('\0') {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }

    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;
    forbid_project_agent_run(ctx.auth(), &space_rec.space)?;

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
    let idemp = derive_command_identity_spec(
        &ctx,
        &request.identity,
        "create_chat",
        fp.finalize().as_bytes(),
    )
    .for_chat(ctx.auth(), &request.input.thread, Vec::new());

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
                forbid_project_agent_run(&auth, &live_space.space)?;

                let tainted = auth.taint().is_tainted();
                if tainted
                    && (input.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                let keeper =
                    matches!(auth.kind(), PrincipalKind::Keeper(_)) || auth.keeper_log().is_some();
                if (keeper || input.kind == ChatThreadKind::KeeperLog)
                    && (input.kind != ChatThreadKind::KeeperLog
                        || auth.keeper_log() != Some(&input.thread)
                        || auth
                            .spaces()
                            .get(&scope.space_id)
                            .and_then(|grant| grant.project_root.as_ref())
                            != input.project_folder.as_ref())
                {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                auth.authorize_chat_thread_read(
                    &live_space.space,
                    &input.thread,
                    input.kind,
                    &input.owner,
                    input.project_folder.as_ref(),
                    tainted,
                )?;
                if let Some(existing) =
                    load_thread_head_opt_tx(tx, &scope.space_id, &input.thread).await?
                {
                    authorize_thread_mutation(&auth, &live_space.space, &existing, false)?;
                    return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
                }

                if let Some(pf) = &input.project_folder {
                    let frow = load_folder_head_row(tx, &scope.space_id, pf).await?;
                    if frow.lifecycle != Lifecycle::Active || frow.is_root || !frow.is_project {
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
                    title: input.title,
                    active_run: None,
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

    let stored: StoredCommittedChatThreadV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn fork_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ForkChat>,
) -> Result<Committed<ChatThread>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "fork_chat");
    validate_mutation_identity(&ctx, &request.identity)?;
    forbid_keeper_chat_mutation(ctx.auth())?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;
    forbid_project_agent_run(ctx.auth(), &space_rec.space)?;

    let fp = format!(
        "thread={};parent={}",
        request.input.thread.as_str(),
        request.input.parent.get()
    );
    let idemp = derive_command_identity_spec(&ctx, &request.identity, "fork_chat", fp.as_bytes())
        .with_preconditions(
            &request.preconditions,
            "thread",
            request.input.thread.as_str(),
        )
        .for_chat_leaf(ctx.auth(), &request.input.thread, request.input.parent);

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
                forbid_project_agent_run(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                authorize_thread_mutation(&auth, &live_space.space, &th, false)?;
                if th.kind == ChatThreadKind::KeeperLog
                    && !matches!(auth.kind(), PrincipalKind::Keeper(_))
                {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                if th.active_run_id.is_some() || auth.taint().is_tainted() {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
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

                let new_tainted = parent_tainted;
                let ever_tainted = th.tainted_mask != 0 || new_tainted;
                if new_tainted
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != th.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let leaf_i64 = input.parent.get() as i64;
                let taint_mask: i64 = i64::from(u8::from(ever_tainted));

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
                        tainted: ever_tainted,
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
                    title: th.title,
                    active_run: th.active_run_id,
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

    let stored: StoredCommittedChatThreadV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn append_chat_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    mut request: Mutation<AppendChat>,
) -> Result<Committed<ChatEntry>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "append_chat");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    if request.input.kind == ChatEntryKind::Redacted {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let is_run = matches!(
        ctx.auth().kind(),
        PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
    );
    if request.input.kind == ChatEntryKind::Human
        && ctx.auth().kind() != &PrincipalKind::DirectHuman
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if (!request.input.tool_calls.is_empty()
        || request.input.interruption.is_some()
        || request.input.provenance.is_some()
        || request.input.proposed_diff.is_some())
        && !is_run
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let format = content::prepare(&mut request.input)?;
    let provenance_json = content::proof_json(request.input.provenance.as_ref())?;
    match &request.input.body {
        ChatInputBody::Text(s) => {
            if (s.len() as u64) > StagedChatBlob::INLINE_MAX_BYTES
                && (!is_run
                    || request.input.kind == ChatEntryKind::Human
                    || s.len() > content::MAX_TURN_BYTES)
            {
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
            if let Some(lease) = st.lease() {
                fp.update(&lease);
            }
        }
    }
    for r in &request.input.referenced_notes {
        fp.update(r.space_id.as_str().as_bytes());
        fp.update(r.note_id.as_str().as_bytes());
    }
    fp.update(&[u8::from(request.input.tainted)]);
    if format != content::BodyFormat::Plain || provenance_json.is_some() {
        fp.update(b"chat-derived-v1");
        fp.update(&format.db().to_be_bytes());
        if let Some(proof) = &provenance_json {
            fp.update(proof.as_bytes());
        }
    }
    let legacy_staged =
        matches!(&request.input.body,ChatInputBody::Staged(st) if st.lease().is_none());
    let idemp = derive_command_identity_spec(
        &ctx,
        &request.identity,
        "append_chat",
        fp.finalize().as_bytes(),
    )
    .with_preconditions(
        &request.preconditions,
        "thread",
        request.input.thread.as_str(),
    )
    .with_chat_body(&request.input.body, &request.input.referenced_notes)
    .with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::Chat(
            request.input.thread.clone(),
            Some(request.input.parent),
            request.input.referenced_notes.clone(),
            legacy_staged,
        ),
    );

    let (space_rec, replayed) = deadline
        .prepare_read(&ctx.budget, || {
            read_space_and_receipt::<StoredCommittedChatEntryV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await?;
    if let Some(mut replayed) = replayed {
        // Older receipts can retain a compaction detail whose checkpoint was
        // already invalidated. Resolve its current visibility before returning it.
        if matches!(replayed.value.kind, StoredChatEntryKindV1::Compaction) {
            let limit = notarium_core::ports::PageLimit::new(1)?;
            let branch = deadline
                .prepare(&ctx.budget, || {
                    store.read_chat(
                        ctx.clone(),
                        ChatRead {
                            thread: replayed.value.thread.clone(),
                            leaf: replayed.value.seq,
                            before: None,
                            max_entries: limit,
                        },
                    )
                })
                .await?;
            if !branch.entries.first().is_some_and(|entry| {
                entry.seq == replayed.value.seq && entry.kind == ChatEntryKind::Compaction
            }) {
                replayed = replayed.sanitized_for_redaction();
            }
        }
        replayed.value.tainted |= legacy_staged;
        if replayed.value.tainted {
            ctx.auth().taint().mark_external_read();
        }
        return Ok(replayed.into_committed());
    }

    if request.input.kind == ChatEntryKind::Human
        && let ChatInputBody::Text(text) = &request.input.body
    {
        content::require_human_text(text)?;
    }

    let prefix = deadline
        .prepare(&ctx.budget, || {
            compaction::verify_prefix(store, ctx.clone(), &request)
        })
        .await;
    match prefix {
        // A different revision cannot pass the writer's CAS. Submit the original
        // command so an identical winner can replay under the current authority.
        Err(PortError::Domain(DomainError::RevisionConflict { ref current, .. }))
            if request
                .preconditions
                .revision
                .as_ref()
                .is_some_and(|rev| rev != current) => {}
        result => result?,
    }

    let provenance_json = deadline
        .prepare(&ctx.budget, || {
            content::prepare_proof(store, &ctx, &request, provenance_json)
        })
        .await?;

    let large_text = match &request.input.body {
        ChatInputBody::Text(text) if text.len() as u64 > StagedChatBlob::INLINE_MAX_BYTES => {
            authorize_chat_write_on_space(ctx.auth(), &space_rec.space)?;
            let prepared = PreparedBlobSource::prepare(text.as_bytes(), store.blob_codec())?;
            let ticket = deadline
                .prepare(&ctx.budget, || {
                    store.stage_blob_for_batch(&space_rec.scope, space_rec.active_epoch, &prepared)
                })
                .await?;
            Some(ticket)
        }
        _ => None,
    };
    let discard = large_text.as_ref().and_then(StagedBlobTicket::discard);
    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions: Preconditions = request.preconditions;
    let input = request.input;
    let owner_store = store.clone();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: large_text
            .as_ref()
            .map_or(0, |ticket| ticket.compressed_size),
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                append_chat_tx(
                    &owner_store,
                    tx,
                    item_ctx,
                    AppendChatWrite {
                        auth,
                        preconditions,
                        input,
                        format,
                        provenance_json,
                        staged: large_text,
                        receipt_kind: UserInputReceipt::Standalone,
                    },
                )
                .await
            })
        }),
    };

    let result: Result<StoredCommittedChatEntryV1, PortError> =
        deadline.submit(store, &ctx.budget, intent).await;
    settle_queue_upload(deadline, &ctx.budget, discard, &result).await?;
    let mut stored = result?;
    stored.value.tainted |= legacy_staged;
    Ok(stored.into_committed())
}

struct AppendChatWrite {
    auth: EngineAuthContext,
    preconditions: Preconditions,
    input: AppendChat,
    format: content::BodyFormat,
    provenance_json: Option<String>,
    staged: Option<StagedBlobTicket>,
    receipt_kind: UserInputReceipt,
}

async fn append_chat_tx(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    item_ctx: &mut ItemExecCtx,
    write: AppendChatWrite,
) -> Result<ItemCommitArtifacts, PortError> {
    let AppendChatWrite {
        auth,
        preconditions,
        input,
        format,
        provenance_json,
        staged,
        receipt_kind,
    } = write;
    let scope = item_ctx.scope.clone();
    let active_epoch = item_ctx.active_epoch;
    let live_space = load_space_record(tx, &scope.space_id).await?;
    authorize_chat_write_on_space(&auth, &live_space.space)?;

    let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
    authorize_thread_mutation(&auth, &live_space.space, &th, false)?;
    if th.kind == ChatThreadKind::KeeperLog && !matches!(auth.kind(), PrincipalKind::Keeper(_)) {
        return Err(DomainError::SpaceReadOnly.into());
    }
    if let PrincipalKind::AgentRun(run) = auth.kind() {
        queue::authorize_run_claim(store, &live_space, &th, run)?;
    }
    if th.active_run_id.is_some() && input.parent != th.head_leaf_seq {
        return Err(DomainError::RevisionConflict {
            current: th.head_rev_id,
            lineage: None,
        }
        .into());
    }
    if format == content::BodyFormat::Proposal
        && (th.kind != ChatThreadKind::Personal
            || live_space.space.kind != SpaceKind::Personal
            || !matches!(auth.kind(), PrincipalKind::AgentRun(_)))
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let (parent_opt, depth, anc_16, anc_256, parent_tainted) =
        compute_skip_pointers_for_parent_tx(tx, &scope.space_id, &input.thread, input.parent)
            .await?;

    let mut effective_tainted = auth.taint().is_tainted() || input.tainted || parent_tainted;
    if let Some(proof) = &input.provenance {
        content::authorize_recorded_sources(
            &input.thread,
            input.parent,
            &scope.space_id,
            &auth,
            proof,
        )?;
        effective_tainted |= auth.taint().is_tainted();
    }
    let mut folder_cache = FolderAncestryCache::default();
    let mut owner_notes = Vec::new();

    for nref in &input.referenced_notes {
        if nref.space_id == scope.space_id {
            if is_note_purge_fenced_tx(tx, &scope.space_id, nref.note_id.as_str()).await? {
                return Err(DomainError::ResourceNotFound.into());
            }
            let nhead = load_note_head_row_tx(tx, &scope.space_id, &nref.note_id).await?;
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
            if auth
                .spaces()
                .get(&nref.space_id)
                .is_none_or(|g| g.read_classes.is_empty())
            {
                return Err(DomainError::ResourceNotFound.into());
            }
            let target_space = crate::runtime::load_space_record(tx, &nref.space_id).await?;
            if target_space.space.lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            if is_note_purge_fenced_tx(tx, &nref.space_id, nref.note_id.as_str()).await? {
                return Err(DomainError::ResourceNotFound.into());
            }
            let nhead = load_note_head_row_tx(tx, &nref.space_id, &nref.note_id).await?;
            if nhead.lifecycle == Lifecycle::Purged {
                return Err(DomainError::ResourceNotFound.into());
            }
            let (facts, _) = folder_cache
                .build_resource_facts_tx(
                    tx,
                    &target_space.space,
                    &nhead.parent_folder_id,
                    nhead.doc_class,
                    nhead.ability_id,
                    false,
                )
                .await?;
            auth.authorize_read(&facts)?;
            auth.taint().mark_external_read();
            effective_tainted = true;
        }
    }
    if auth.taint().is_tainted() {
        effective_tainted = true;
    }

    let staging_lease = if let ChatInputBody::Staged(staged) = &input.body {
        let lease = lookup_staged_chat_lease_tx(tx, &scope.space_id, staged).await?;
        // Legacy references carried no provenance. Only a verified v2 clean lease is clean.
        if !lease.starts_with("st2c_") {
            effective_tainted = true;
        }
        Some(lease)
    } else {
        None
    };

    if effective_tainted
        && (th.kind == ChatThreadKind::SpaceGroup || live_space.space.kind == SpaceKind::Shared)
    {
        return Err(DomainError::CrossSpaceTainted.into());
    }

    if let Some(expected_rev) = &preconditions.revision
        && *expected_rev != th.head_rev_id
    {
        return Err(DomainError::RevisionConflict {
            current: th.head_rev_id,
            lineage: None,
        }
        .into());
    }

    if effective_tainted {
        auth.taint().mark_external_read();
    }
    let entry_seq = th.next_entry_seq;
    let next_entry_seq = entry_seq.checked_next()?;
    let seq = item_ctx.alloc_next_seq()?;
    let entry_rev = new_revision_id()?;
    let new_thread_rev = new_revision_id()?;
    let now_ts = now_utc_timestamp()?;
    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let seq_i64 = seq.get() as i64;

    let (inline_text, payload_digest, body_out) = match (&input.body, staged) {
        (ChatInputBody::Text(_), Some(ticket)) => {
            let digest = ticket.digest;
            item_ctx.record_staged_ticket(ticket.clone());
            activate_and_bind_blob_ref_tx(
                tx,
                &scope,
                active_epoch,
                &BlobReferenceClaim {
                    ticket,
                    owner_kind: BlobOwnerKind::ChatEntry,
                    owner_id: format!("{}:{}", input.thread.as_str(), entry_seq.get()),
                    owner_rev_id: entry_rev.as_str().to_owned(),
                    resource_key: "body".to_owned(),
                },
                seq,
            )
            .await?;
            (None, Some(digest), ChatBody::Blob(digest))
        }
        (ChatInputBody::Text(s), None) => (Some(s.clone()), None, ChatBody::Inline(s.clone())),
        (ChatInputBody::Staged(staged), _) => {
            consume_one_staged_chat_ref_and_bind_entry_tx(
                tx,
                &scope.space_id,
                staged,
                staging_lease
                    .as_deref()
                    .ok_or(DomainError::ResourceNotFound)?,
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
        format,
        provenance_json.as_deref(),
        effective_tainted,
        depth,
        anc_16,
        anc_256,
        seq,
    )
    .await?;

    let thread_tainted = th.tainted_mask != 0 || effective_tainted;
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

    let meta =
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(ThreadRevisionMetadata {
            thread_id: th.thread_id.clone(),
            kind: th.kind,
            owner_id: th.owner.clone(),
            project_folder_id: th.project_folder.clone(),
            title: th.title.clone(),
            head_leaf_seq: entry_seq,
            tainted: thread_tainted,
        }))
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

    // Chat entries are not rollbackable corpus mutations; do not record a
    // synthetic `agent_run_heads` row for chat-only appends so zero-edit
    // private/Keeper runs remain invisible to foreign rollback probes.

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
    let encode = |entry| match receipt_kind {
        UserInputReceipt::Standalone => CanonicalStore::encode_command_outcome(&entry),
        UserInputReceipt::Submission => {
            CanonicalStore::encode_command_outcome(&StoredUserChatSubmissionV1::Appended(entry))
        }
    };
    let full_bytes = encode(stored_full)?;
    let sanitized_bytes = encode(stored_sanitized)?;

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
    format: content::BodyFormat,
    provenance_json: Option<&str>,
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
                    anc_16_seq, anc_256_seq, created_space_seq, redacted_at_seq, checkpoint_stale,
                    human_origin, body_format, provenance_json
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 0, ?, ?, ?)",
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
            .bind(i32::from(kind_str == "human"))
            .bind(format.db())
            .bind(provenance_json)
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
                    anc_16_seq, anc_256_seq, created_space_seq, redacted_at_seq, checkpoint_stale,
                    human_origin, body_format, provenance_json
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $17, NULL, 0, $18, $19, $20)",
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
            .bind(i32::from(kind_str == "human"))
            .bind(format.db())
            .bind(provenance_json)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_chat_entry", err.to_string()))?;
        }
    }
    crate::projection_chat::write_chat_note_refs_json_tx(
        tx,
        space_id.as_str(),
        thread_id.as_str(),
        e_i64,
        cseq_i64,
        refs_json,
    )
    .await
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

#[allow(clippy::too_many_arguments)]
async fn check_queue_admission_tx(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    auth: &EngineAuthContext,
    thread: &ChatThreadId,
    id: &PendingInputId,
    base: ThreadEntrySeq,
    expected_run: &AgentRunId,
) -> Result<Option<i64>, PortError> {
    let live_space = load_space_record(tx, &scope.space_id).await?;
    live_space.scope.check(scope)?;
    forbid_project_agent_run(auth, &live_space.space)?;
    authorize_chat_replay_tx(tx, &live_space.space, auth, thread, Some(base), false).await?;
    let head = load_thread_head_tx(tx, &scope.space_id, thread).await?;
    if head.kind == ChatThreadKind::KeeperLog {
        return Err(DomainError::SpaceReadOnly.into());
    }
    if queue::authorize_run_claim(store, &live_space, &head, expected_run).is_err() {
        return Ok(None);
    }

    if base != ThreadEntrySeq::ZERO
        && load_entry_depth_and_taint_tx(tx, &scope.space_id, thread, base)
            .await?
            .is_none()
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    queue_admission_count_tx(tx, &scope.space_id, thread, id)
        .await
        .map(Some)
}

async fn queue_admission_count_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    id: &PendingInputId,
) -> Result<i64, PortError> {
    const COUNTS: &str = "SELECT
        (SELECT COUNT(*) FROM chat_pending_inputs WHERE space_id=$1 AND thread_id=$2 AND input_id=$3),
        (SELECT COUNT(*) FROM chat_pending_inputs WHERE space_id=$1 AND thread_id=$2 AND status='pending')";
    let (duplicates, pending): (i64, i64) = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(COUNTS)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(id.as_str())
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(COUNTS)
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(id.as_str())
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|err| crate::runtime::pg_read_error("queue_admission_counts", err))?;
    if duplicates != 0 {
        return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
    }
    Ok(pending)
}

async fn queue_chat_input_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<PendingChatInput>,
) -> Result<QueueInputOutcome, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "queue_chat_input");
    validate_mutation_identity(&ctx, &request.identity)?;
    forbid_keeper_chat_mutation(ctx.auth())?;
    if ctx.auth().kind() != &PrincipalKind::DirectHuman {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if request.input.body.contains('\0') || request.input.body.len() > content::MAX_TURN_BYTES {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    if request.input.sender != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;

    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;
    forbid_project_agent_run(ctx.auth(), &space_rec.space)?;

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
        &ctx,
        &request.identity,
        "queue_chat_input",
        fp.finalize().as_bytes(),
    )
    .for_chat_leaf(
        ctx.auth(),
        &request.input.thread,
        request.input.queued_base_leaf,
    );

    // A concurrent retry can commit between these reads. Resolve its receipt before
    // returning a duplicate or full result from admission.
    let check_scope = space_rec.scope.clone();
    let check_auth = ctx.auth().clone();
    let check_thread = request.input.thread.clone();
    let check_id = request.input.id.clone();
    let base = request.input.queued_base_leaf;
    let expected_run = request.input.in_flight_run.clone();
    let precheck_store = store.clone();
    let admission = deadline
        .prepare(&ctx.budget, || {
            store.with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    check_queue_admission_tx(
                        &precheck_store,
                        tx,
                        &check_scope,
                        &check_auth,
                        &check_thread,
                        &check_id,
                        base,
                        &expected_run,
                    )
                    .await
                })
            })
        })
        .await;
    if let Some(replayed) = deadline
        .prepare(&ctx.budget, || {
            try_replay_completed_receipt::<StoredCommittedQueuedInputV1>(
                store,
                &space_rec.scope,
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await?
    {
        return Ok(QueueInputOutcome::Queued(replayed.into_committed()));
    }

    content::require_human_text(&request.input.body)?;
    let Some(admission) = admission? else {
        return Ok(QueueInputOutcome::Changed);
    };
    if admission >= i64::from(PENDING_CHAT_QUEUE_LIMIT) {
        return Ok(QueueInputOutcome::Full {
            limit: PENDING_CHAT_QUEUE_LIMIT,
        });
    }

    let staged_opt = if (request.input.body.len() as u64) > StagedChatBlob::INLINE_MAX_BYTES {
        let prepared =
            PreparedBlobSource::prepare(request.input.body.as_bytes(), store.blob_codec())?;
        let ticket = tokio::select! {
            biased;
            () = ctx.budget.cancellation.cancelled() => return Err(crate::codec::cancelled_not_committed("queue_upload_cancelled", "queue upload cancelled before writer admission")),
            () = tokio::time::sleep_until(deadline.at) => return Err(crate::codec::deadline_not_committed("queue_upload_deadline", "queue upload deadline before writer admission")),
            result = store.stage_blob_for_batch(&space_rec.scope, space_rec.active_epoch, &prepared) => result?,
        };
        Some(ticket)
    } else {
        None
    };

    let discard = staged_opt.as_ref().and_then(StagedBlobTicket::discard);
    let queue_full_flag = Arc::new(AtomicBool::new(false));
    let flag_cl = Arc::clone(&queue_full_flag);
    let queue_changed = Arc::new(AtomicBool::new(false));
    let changed = Arc::clone(&queue_changed);
    let owner_store = store.clone();
    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let input = request.input;
    let staged_bytes = staged_opt
        .as_ref()
        .map_or(0, |ticket| ticket.compressed_size);

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let Some(active_pending) = check_queue_admission_tx(
                    &owner_store,
                    tx,
                    &scope,
                    &auth,
                    &input.thread,
                    &input.id,
                    input.queued_base_leaf,
                    &input.in_flight_run,
                )
                .await?
                else {
                    changed.store(true, Ordering::SeqCst);
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                };
                if active_pending >= i64::from(PENDING_CHAT_QUEUE_LIMIT) {
                    flag_cl.store(true, Ordering::SeqCst);
                    return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
                }

                enqueue_chat_tx(
                    tx,
                    item_ctx,
                    input,
                    auth.taint().is_tainted(),
                    active_pending,
                    staged_opt,
                    UserInputReceipt::Standalone,
                )
                .await
            })
        }),
    };

    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let result = deadline
        .submit::<StoredCommittedQueuedInputV1>(store, &ctx.budget, intent)
        .await;
    settle_queue_upload(deadline, &ctx.budget, discard, &result).await?;
    match result {
        Ok(stored) => Ok(QueueInputOutcome::Queued(stored.into_committed())),
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::InvalidLimit
                && queue_full_flag.load(Ordering::SeqCst) =>
        {
            Ok(QueueInputOutcome::Full {
                limit: PENDING_CHAT_QUEUE_LIMIT,
            })
        }
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::InvalidState
                && queue_changed.load(Ordering::SeqCst) =>
        {
            Ok(QueueInputOutcome::Changed)
        }
        Err(other) => Err(other),
    }
}

async fn settle_queue_upload<T>(
    deadline: CommandDeadline,
    budget: &notarium_core::ports::CallBudget,
    discard: Option<Arc<PublicationDiscard>>,
    result: &Result<T, PortError>,
) -> Result<(), PortError> {
    if let Some(discard) = discard {
        // A pending writer may still commit after an ambiguous response. Its ticket
        // retains cleanup ownership until the writer resolves its transaction.
        let definitive = match result {
            Ok(_) | Err(PortError::Domain(_)) => true,
            Err(
                PortError::Cancelled(f)
                | PortError::DeadlineExceeded(f)
                | PortError::Unavailable(f)
                | PortError::Internal(f),
            ) => f.effect() == notarium_core::error::CommitEffect::NotCommitted,
        };
        if definitive {
            let cleanup = deadline.wait(budget, || discard.finish()).await;
            // The accepted receipt is already durable. A failed cleanup of an unused
            // private upload stays recorded for recovery.
            if result.is_err()
                && let Ok(cleanup) = cleanup
            {
                cleanup?;
            }
        }
    }
    Ok(())
}

async fn enqueue_chat_tx(
    tx: &mut BackendConn<'_>,
    item_ctx: &mut ItemExecCtx,
    input: PendingChatInput,
    tainted: bool,
    active_pending: i64,
    staged: Option<StagedBlobTicket>,
    receipt_kind: UserInputReceipt,
) -> Result<ItemCommitArtifacts, PortError> {
    let scope = item_ctx.scope.clone();
    let next_ordinal: i64 = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM chat_pending_inputs
             WHERE space_id = ? AND thread_id = ?",
        )
        .bind(scope.space_id.as_str())
        .bind(input.thread.as_str())
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_next_ordinal", err.to_string()))?,
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

    let (inline_opt, payload_opt) = match staged {
        None => (Some(input.body.as_str()), None),
        Some(ticket) => {
            let digest = ticket.digest;
            item_ctx.record_staged_ticket(ticket.clone());
            let owner_id = format!("{}:{}", input.thread.as_str(), input.id.as_str());
            activate_and_bind_blob_ref_tx(
                tx,
                &item_ctx.scope,
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
                    in_flight_run_id, mentions_agent, status, enqueued_seq, consumed_entry_seq, ext_space_tainted
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)",
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
            .bind(i32::from(tainted))
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_ins_pending", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO chat_pending_inputs (
                    space_id, thread_id, input_id, ordinal, author_id,
                    inline_text, payload_blake3, queued_base_leaf_seq,
                    in_flight_run_id, mentions_agent, status, enqueued_seq, consumed_entry_seq, ext_space_tainted
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, NULL, $12)",
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
            .bind(i32::from(tainted))
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_ins_pending", err.to_string()))?;
        }
    }

    let resp_bytes = match receipt_kind {
        UserInputReceipt::Standalone => {
            CanonicalStore::encode_command_outcome(&StoredCommittedQueuedInputV1 {
                value: StoredQueuedInputV1 {
                    input: input.id,
                    position,
                },
                receipt: MutationReceiptToken::new(scope.clone(), seq)?,
            })?
        }
        UserInputReceipt::Submission => CanonicalStore::encode_command_outcome(
            &StoredUserChatSubmissionV1::Queued(StoredQueuedChatMetadataV1 {
                id: input.id,
                sender: input.sender,
                queued_base_leaf: input.queued_base_leaf,
                in_flight_run: input.in_flight_run,
                mentions_agent: input.mentions_agent,
            }),
        )?,
    };
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
}

async fn consume_chat_input_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ConsumePending>,
) -> Result<Committed<ConsumedPending>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "consume_chat_input");
    validate_mutation_identity(&ctx, &request.identity)?;
    forbid_keeper_chat_mutation(ctx.auth())?;
    if ctx.auth().kind() != &PrincipalKind::DirectHuman {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let mut fp = format!(
        "thread={};input={};run={};leaf={}",
        request.input.thread.as_str(),
        request.input.input.as_str(),
        request.input.expected_run.as_str(),
        request.input.current_leaf.get()
    );
    if request.input.expected_active_run != request.input.expected_run {
        fp.push_str(";active=");
        fp.push_str(request.input.expected_active_run.as_str());
    }
    let idemp =
        derive_command_identity_spec(&ctx, &request.identity, "consume_chat_input", fp.as_bytes())
            .with_preconditions(
                &request.preconditions,
                "thread",
                request.input.thread.as_str(),
            )
            .for_chat_leaf(
                ctx.auth(),
                &request.input.thread,
                request.input.current_leaf,
            );

    if let Some(replayed) = deadline
        .prepare(&ctx.budget, || {
            try_replay_completed_receipt::<StoredCommittedConsumedPendingV1>(
                store,
                &space_rec.scope,
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await?
    {
        let committed = replayed.into_committed();
        if matches!(&committed.value, ConsumedPending::Appended { entry, .. } if entry.tainted) {
            ctx.auth().taint().mark_external_read();
        }
        return Ok(committed);
    }

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions;
    let input = request.input;
    let owner_store = store.clone();

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
                authorize_thread_mutation(&auth, &live_space.space, &th, false)?;
                if th.kind == ChatThreadKind::KeeperLog
                    && !matches!(auth.kind(), PrincipalKind::Keeper(_))
                {
                    return Err(DomainError::SpaceReadOnly.into());
                }
                queue::authorize_run_claim(
                    &owner_store,
                    &live_space,
                    &th,
                    &input.expected_active_run,
                )?;
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
                    i32,
                )> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let r = sqlx::query(
                            "SELECT author_id, inline_text, payload_blake3, queued_base_leaf_seq,
                                    in_flight_run_id, status, ext_space_tainted
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
                                row.get("ext_space_tainted"),
                            )
                        })
                    }
                    BackendConn::Postgres(conn) => {
                        let r = sqlx::query(
                            "SELECT author_id, inline_text, payload_blake3, queued_base_leaf_seq,
                                    in_flight_run_id, status, ext_space_tainted
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
                                row.get("ext_space_tainted"),
                            )
                        })
                    }
                };

                let Some((
                    author_raw,
                    inline_opt,
                    blob_opt,
                    queued_raw,
                    run_raw,
                    status,
                    queued_taint,
                )) = pending_row
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                if author_raw != auth.principal().as_str() {
                    return Err(DomainError::ResourceNotFound.into());
                }
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
                if input.current_leaf != th.head_leaf_seq {
                    return Err(DomainError::RevisionConflict {
                        current: th.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                queue::require_oldest_pending(tx, &scope.space_id, &input.thread, &input.input)
                    .await?;

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

                let intervening_human = queue::other_human_on_branch(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    input.current_leaf,
                    queued_leaf,
                    &author_raw,
                )
                .await?;
                let (parent_opt, depth, anc_16, anc_256, parent_tainted) =
                    compute_skip_pointers_for_parent_tx(
                        tx,
                        &scope.space_id,
                        &input.thread,
                        input.current_leaf,
                    )
                    .await?;

                let effective_tainted =
                    queued_taint != 0 || auth.taint().is_tainted() || parent_tainted;
                if effective_tainted
                    && (th.kind == ChatThreadKind::SpaceGroup
                        || live_space.space.kind == SpaceKind::Shared)
                {
                    return Err(DomainError::CrossSpaceTainted.into());
                }

                auth.authorize_chat_thread_read(
                    &live_space.space,
                    &th.thread_id,
                    th.kind,
                    &th.owner,
                    th.project_folder.as_ref(),
                    effective_tainted,
                )?;
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
                    Some(&input.expected_active_run),
                    inline_for_entry.as_deref(),
                    digest_opt,
                    "[]",
                    content::BodyFormat::Plain,
                    None,
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
                             SET status = 'consumed', inline_text = '', payload_blake3 = NULL, consumed_entry_seq = ?
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
                             SET status = 'consumed', inline_text = '', payload_blake3 = NULL, consumed_entry_seq = $1
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

                let thread_tainted = th.tainted_mask != 0 || effective_tainted;
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
                    Some(&input.expected_active_run),
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
                    run: Some(input.expected_active_run),
                    kind: ChatEntryKind::Human,
                    body: body_out,
                    tainted: effective_tainted,
                    referenced_notes: Vec::new(),
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let stored_full = StoredCommittedConsumedPendingV1 {
                    value: StoredConsumedPendingV1::AppendedWithIntervention {
                        entry: (&entry_val).into(),
                        intervening_human,
                    },
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
        deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

/// Give a healthy store a short opportunity to reclaim bytes inline. Once the
/// receipt is committed, a slow backend or a competing local guard is GC's concern.
async fn wait_for_redaction_gc(
    budget: &notarium_core::ports::CallBudget,
    started: tokio::time::Instant,
    gc: impl std::future::Future,
) {
    let remaining = budget.remaining.saturating_sub(started.elapsed());
    let grace = remaining.min(std::time::Duration::from_millis(50));
    if !grace.is_zero() {
        tokio::select! {
            biased;
            () = budget.cancellation.cancelled() => {},
            _ = tokio::time::timeout(grace, gc) => {},
        }
    }
}

async fn finish_redacted_projection_replay(
    store: &CanonicalStore,
    committed: &Committed<RedactedChat>,
    budget: &notarium_core::ports::CallBudget,
    deadline: &crate::domain::common::CommandDeadline,
) -> Result<(), PortError> {
    deadline
        .wait(budget, || {
            store.retry_redacted_chat_cleanup(committed, budget)
        })
        .await
        .map_err(|error| {
            crate::codec::unknown_commit_outcome("redaction_projection_cleanup", error.to_string())
        })?
}

async fn redact_chat_entry_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RedactChatEntry>,
) -> Result<Committed<RedactedChat>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "redact_chat_entry");
    let started = tokio::time::Instant::now();
    validate_mutation_identity(&ctx, &request.identity)?;
    forbid_keeper_chat_mutation(ctx.auth())?;
    crate::domain::common::require_revision_only(&request.preconditions)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;
    forbid_project_agent_run(ctx.auth(), &space_rec.space)?;

    let fp = format!(
        "thread={};entry={};expected_rev={}",
        request.input.thread.as_str(),
        request.input.entry.get(),
        request.input.expected_thread_revision.as_str()
    );
    let idemp =
        derive_command_identity_spec(&ctx, &request.identity, "redact_chat_entry", fp.as_bytes())
            .with_preconditions(
                &request.preconditions,
                "thread",
                request.input.thread.as_str(),
            )
            .with_known_base(&request.input.expected_thread_revision)
            .for_chat(ctx.auth(), &request.input.thread, Vec::new());

    if idemp.canonical_effect().is_none()
        && let Some(replayed) = deadline
            .prepare(&ctx.budget, || {
                try_replay_completed_receipt::<StoredCommittedRedactedChatV1>(
                    store,
                    &space_rec.scope,
                    &idemp,
                    Some(&ctx.budget),
                )
            })
            .await?
    {
        let (committed, zero_refs) = replayed.into_committed();
        finish_redacted_projection_replay(store, &committed, &ctx.budget, &deadline).await?;
        if !zero_refs.is_empty() {
            // A receipt from an older writer can refer to bytes released before
            // it gained transactional GC. Reconciliation on open/lease also covers these.
            wait_for_redaction_gc(
                &ctx.budget,
                started,
                store.retire_zero_ref_digests(
                    &space_rec.scope,
                    space_rec.active_epoch,
                    &zero_refs,
                    RetirementReason::Gc,
                    None,
                ),
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

    let cleanup_store = store.clone();
    let (attempted, first_attempt) = tokio::sync::oneshot::channel();
    let committed_in_writer = Arc::new(AtomicBool::new(false));
    let observe_commit = Arc::clone(&committed_in_writer);
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
                forbid_project_agent_run(&auth, &live_space.space)?;

                let th = load_thread_head_tx(tx, &scope.space_id, &input.thread).await?;
                authorize_thread_mutation(&auth, &live_space.space, &th, false)?;
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
                                 provenance_json = NULL, body_format = 0,
                                 is_chain_node = 1, redacted_at_seq = COALESCE(redacted_at_seq, ?)
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
                                 provenance_json = NULL, body_format = 0,
                                 is_chain_node = 1, redacted_at_seq = COALESCE(redacted_at_seq, $1)
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

                crate::projection_chat::clear_chat_note_refs_tx(
                    tx,
                    &scope.space_id,
                    &input.thread,
                    entry_i64,
                )
                .await?;

                // Release the CAS reference owned by this chat entry.
                let entry_owner = format!("{}:{}", input.thread.as_str(), input.entry.get());
                let mut zero_ref_digests = release_owner_blob_refs_tx(
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
                // Advancing `chat_threads.redaction_epoch` below invalidates cached folded proofs in O(1).
                let invalidated_contexts = mark_descendant_compactions_stale_tx(
                    tx,
                    &scope,
                    &input.thread,
                    entry_i64,
                    seq_i64,
                    &mut zero_ref_digests,
                )
                .await?;

                // End peer admission and record the physical work with the reference removal.
                // A backup holds the bytes, but cannot extend ownership of a chat payload.
                let mut retirements = Vec::new();
                for digest in &zero_ref_digests {
                    if let Some(id) = crate::blobs::initiate_digest_retirement_tx(
                        tx,
                        &scope,
                        active_epoch,
                        *digest,
                        RetirementReason::Gc,
                        None,
                        None,
                    )
                    .await?
                    {
                        retirements.push(id);
                    }
                }
                if !retirements.is_empty() {
                    item_ctx.retain_until_batch_commit(cleanup_store.retirement_handoff(
                        &scope,
                        active_epoch,
                        retirements,
                        Some(attempted),
                    ));
                }

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE chat_threads
                             SET head_rev_id = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                 redaction_epoch = redaction_epoch + 1
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
                             SET head_rev_id = $1, updated_seq = $2, updated_at_sec = $3, updated_at_nsec = $4,
                                 redaction_epoch = redaction_epoch + 1
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
                        // The durable retirement records now carry the physical work.
                        zero_ref_digests: Vec::new(),
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

                item_ctx.on_commit(move || observe_commit.store(true, Ordering::Release));
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

    let stored: StoredCommittedRedactedChatV1 = deadline.submit(store, &ctx.budget, intent).await?;
    let (committed, zero_refs) = stored.into_committed();
    if !committed_in_writer.load(Ordering::Acquire) {
        finish_redacted_projection_replay(store, &committed, &ctx.budget, &deadline).await?;
    }
    if !zero_refs.is_empty() {
        wait_for_redaction_gc(
            &ctx.budget,
            started,
            store.retire_zero_ref_digests(
                &space_rec.scope,
                space_rec.active_epoch,
                &zero_refs,
                RetirementReason::Gc,
                None,
            ),
        )
        .await;
    }
    wait_for_redaction_gc(
        &ctx.budget,
        started,
        crate::blobs::retirement_worker::handoff_outcome(first_attempt),
    )
    .await;
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
                 SELECT entry_seq, parent_seq, CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END, 0
                 FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND entry_seq = ?
                 UNION ALL
                 SELECT e.entry_seq, e.parent_seq, CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END, a.hops + 1
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
                 SELECT entry_seq, parent_seq, CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END, 0::BIGINT
                 FROM chat_entries
                 WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
                 UNION ALL
                 SELECT e.entry_seq, e.parent_seq, CASE WHEN e.checkpoint_stale <> 0 THEN 'redacted' ELSE e.kind END, a.hops + 1
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
    scope: &HistoryScope,
    thread_id: &ChatThreadId,
    target_entry_seq: i64,
    redaction_seq: i64,
    zero_refs: &mut Vec<ContentDigest>,
) -> Result<Vec<ThreadEntrySeq>, PortError> {
    let space_id = &scope.space_id;
    let raw_seqs: Vec<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "WITH RECURSIVE desc_tree(entry_seq, kind) AS (
                 SELECT entry_seq, kind
                 FROM chat_entries
                 WHERE space_id = ? AND thread_id = ? AND parent_seq = ?
                 UNION ALL
                 SELECT c.entry_seq, c.kind
                 FROM desc_tree d
                 CROSS JOIN chat_entries c
                 WHERE c.space_id = ? AND c.thread_id = ? AND c.parent_seq = d.entry_seq
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
                 CROSS JOIN chat_entries c
                 WHERE c.space_id = $1 AND c.thread_id = $2 AND c.parent_seq = d.entry_seq
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
        let created_at: i64 = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query_scalar(
                    "UPDATE chat_entries SET checkpoint_stale = 1, kind='redacted', inline_text=NULL,
                            payload_blake3=NULL, referenced_notes_json='[]', provenance_json=NULL, body_format=0, redacted_at_seq=COALESCE(redacted_at_seq, ?4)
                     WHERE space_id = ?1 AND thread_id = ?2 AND entry_seq = ?3 RETURNING created_space_seq",
                )
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(raw)
                .bind(redaction_seq)
                .fetch_one(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_mark_compaction_stale", err.to_string())
                })?
            }
            BackendConn::Postgres(conn) => {
                sqlx::query_scalar(
                    "UPDATE chat_entries SET checkpoint_stale = 1, kind='redacted', inline_text=NULL,
                            payload_blake3=NULL, referenced_notes_json='[]', provenance_json=NULL, body_format=0, redacted_at_seq=COALESCE(redacted_at_seq, $4)
                     WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3 RETURNING created_space_seq",
                )
                .bind(space_id.as_str())
                .bind(thread_id.as_str())
                .bind(raw)
                .bind(redaction_seq)
                .fetch_one(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_mark_compaction_stale", err.to_string())
                })?
            }
        };
        crate::projection_chat::clear_chat_note_refs_tx(tx, space_id, thread_id, raw).await?;
        let owner = format!("{}:{raw}", thread_id.as_str());
        zero_refs.extend(
            release_owner_blob_refs_tx(tx, space_id, BlobOwnerKind::ChatEntry, &owner).await?,
        );
        sanitize_chat_entry_receipt_tx(tx, scope, created_at).await?;
        out.push(ThreadEntrySeq::new(u64::try_from(raw).map_err(|_| {
            internal_not_committed("corrupt_compaction_seq", "negative entry_seq")
        })?)?);
    }

    Ok(out)
}

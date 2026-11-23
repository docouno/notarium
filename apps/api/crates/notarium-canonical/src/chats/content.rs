mod checkpoint;

use std::collections::{BTreeSet, HashMap};

use notarium_core::{
    classes::{CanonicalChatContent, ProviderCurrentContent, ProviderOrigin},
    ports::{
        CallBudget, ChatProposalEntryWitness, ChatProposalWitness, ChatProvenance,
        CompletionFinish, ConfirmedChatStep, ProviderToolCall,
    },
};

use super::*;
use crate::{domain::common::CommandDeadline, runtime::SpaceRecord};
use checkpoint::PageReader;

const MODEL_MARKER: &str = "\u{FDD0}notarium_model_turn_v1\n";
const PROPOSAL_MARKER: &str = "\u{FDD0}notarium_proposed_diff_v1\n";
pub(super) const MAX_TURN_BYTES: usize = AppendChat::MAX_STRUCTURED_BODY_BYTES;
const MAX_TURN_CALLS: usize = 64;

pub(super) fn require_human_text(text: &str) -> Result<(), PortError> {
    if text.is_empty() {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    Ok(())
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum BodyFormat {
    Plain = 0,
    Model = 1,
    Proposal = 2,
}

impl BodyFormat {
    pub(super) fn db(self) -> i32 {
        self as i32
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct ModelTurn {
    pub(super) text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interruption: Option<CompletionFinish>,
    tool_calls: Vec<ProviderToolCall>,
}

#[derive(Serialize, Deserialize)]
struct ProposalTurn {
    text: String,
    envelope: String,
}

pub(super) fn prepare(input: &mut AppendChat) -> Result<BodyFormat, PortError> {
    if let Some(proof) = &input.provenance {
        if proof.origins.len() > ChatProvenance::MAX_ORIGINS
            || proof.projects.len() > notarium_core::ports::MAX_PROVIDER_SECONDARY_PROJECTS
        {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        if !matches!(
            input.kind,
            ChatEntryKind::Model | ChatEntryKind::Tool { .. } | ChatEntryKind::Compaction
        ) || (proof.compacts_through.is_some() && input.kind != ChatEntryKind::Compaction)
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    }
    if input.interruption.is_some_and(|reason| {
        reason.interruption().is_none()
            || input.kind != ChatEntryKind::Model
            || !input.tool_calls.is_empty()
            || !matches!(&input.body, ChatInputBody::Text(_))
    }) {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if !input.tool_calls.is_empty() && input.kind != ChatEntryKind::Model {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if let Some(envelope) = input.proposed_diff.take() {
        if !matches!(input.kind, ChatEntryKind::Tool { .. })
            || !input.tainted
            || input.provenance.is_none()
            || envelope.is_empty()
            || envelope.len() > MAX_TURN_BYTES
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let ChatInputBody::Text(text) = &input.body else {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        };
        let encoded = serde_json::to_string(&ProposalTurn {
            text: text.clone(),
            envelope,
        })
        .map_err(|error| internal_not_committed("encode_chat_proposal", error.to_string()))?;
        return encode(input, PROPOSAL_MARKER, encoded, BodyFormat::Proposal);
    }
    if let ChatInputBody::Text(text) = &input.body {
        if input.kind == ChatEntryKind::Model
            && (input.interruption.is_some()
                || !input.tool_calls.is_empty()
                || text.starts_with('\u{FDD0}')
                || text.contains('\0'))
        {
            let mut ids = BTreeSet::new();
            if input.tool_calls.len() > MAX_TURN_CALLS
                || input.tool_calls.iter().any(|call| {
                    CommandKey::parse(call.id.as_str()).is_err() || !ids.insert(call.id.as_str())
                })
            {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            let encoded = serde_json::to_string(&ModelTurn {
                text: text.clone(),
                interruption: input.interruption,
                tool_calls: std::mem::take(&mut input.tool_calls),
            })
            .map_err(|error| internal_not_committed("encode_chat_model_turn", error.to_string()))?;
            return encode(input, MODEL_MARKER, encoded, BodyFormat::Model);
        }
        if text.contains('\0') {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    } else if !input.tool_calls.is_empty() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(BodyFormat::Plain)
}

fn encode(
    input: &mut AppendChat,
    marker: &str,
    json: String,
    format: BodyFormat,
) -> Result<BodyFormat, PortError> {
    if marker.len() + json.len() > MAX_TURN_BYTES {
        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
    }
    input.body = ChatInputBody::Text(format!("{marker}{json}"));
    Ok(format)
}

pub(super) fn proof_json(proof: Option<&ChatProvenance>) -> Result<Option<String>, PortError> {
    proof
        .map(|proof| {
            let value = serde_json::to_string(proof)
                .map_err(|error| internal_not_committed("encode_chat_proof", error.to_string()))?;
            if value.len() > ChatProvenance::MAX_BYTES {
                return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
            }
            Ok(value)
        })
        .transpose()
}

pub(super) fn authorize_recorded_sources(
    thread: &ChatThreadId,
    parent: ThreadEntrySeq,
    space: &SpaceId,
    auth: &EngineAuthContext,
    proof: &ChatProvenance,
) -> Result<(), PortError> {
    for source in &proof.origins {
        if let ProviderOrigin::Chat {
            space: source_space,
            thread: source_thread,
            entry,
            ..
        } = source
            && (source_space != space || source_thread != thread || *entry > parent)
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
    }
    for source_space in proof
        .origins
        .iter()
        .filter_map(ProviderOrigin::space_id)
        .chain(proof.projects.iter().map(|folder| &folder.space_id))
    {
        if !auth.spaces().contains_key(source_space) {
            return Err(DomainError::ResourceNotFound.into());
        }
        if source_space != space {
            auth.taint().mark_external_read();
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct PayloadRow {
    entry_seq: i64,
    parent_seq: Option<i64>,
    revision_id: String,
    kind: String,
    author_id: String,
    agent_run_id: Option<String>,
    tool_call_id: Option<String>,
    inline_text: Option<String>,
    payload_blake3: Option<Vec<u8>>,
    ext_space_tainted: i32,
    body_format: i32,
    provenance_json: Option<String>,
}

impl PayloadRow {
    fn seq(&self) -> Result<ThreadEntrySeq, PortError> {
        queue::seq_from_db(self.entry_seq)
    }

    fn digest(&self) -> Result<ContentDigest, PortError> {
        if let Some(bytes) = &self.payload_blake3 {
            return Ok(ContentDigest::from_bytes(
                bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| internal_not_committed("chat_body_digest", "digest length"))?,
            ));
        }
        let text = self
            .inline_text
            .as_ref()
            .ok_or(DomainError::ResourceNotFound)?;
        Ok(ContentDigest::from_bytes(
            *blake3::hash(text.as_bytes()).as_bytes(),
        ))
    }

    fn provenance(&self) -> Result<Option<ChatProvenance>, PortError> {
        decode_proof(self.provenance_json.as_deref())
    }

    fn group_author(
        &self,
        auth: &EngineAuthContext,
        thread: &ThreadHeadRow,
    ) -> Result<Option<PrincipalId>, PortError> {
        if thread.kind != ChatThreadKind::SpaceGroup
            || self.kind != "human"
            || self.author_id == auth.principal().as_str()
        {
            return Ok(None);
        }
        Ok(Some(PrincipalId::parse(&self.author_id)?))
    }

    fn is_redacted(&self) -> bool {
        self.kind == "redacted"
    }
}

// Keep direct fields at the top level for existing readers. Deserializing
// serde(flatten) buffers every origin and digest even for a plain legacy row.
#[derive(Serialize, Deserialize)]
struct StoredProvenance {
    origins: Vec<ProviderOrigin>,
    projects: Vec<notarium_core::model::FolderRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compacts_through: Option<ThreadEntrySeq>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folded: Option<ChatProvenance>,
}

fn decode_proof(raw: Option<&str>) -> Result<Option<ChatProvenance>, PortError> {
    raw.map(|raw| {
        let value: StoredProvenance = serde_json::from_str(raw)
            .map_err(|e| internal_not_committed("decode_chat_proof", e.to_string()))?;
        Ok(value.folded.unwrap_or(ChatProvenance {
            origins: value.origins,
            projects: value.projects,
            compacts_through: value.compacts_through,
        }))
    })
    .transpose()
}

/// The revision CAS makes the read cut valid through insertion. Requests without
/// this precondition keep their direct proof. Their reader can still fold it.
pub(super) async fn prepare_proof(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    request: &Mutation<AppendChat>,
    direct_json: Option<String>,
) -> Result<Option<String>, PortError> {
    let (Some(proof), Some(expected)) =
        (&request.input.provenance, &request.preconditions.revision)
    else {
        return Ok(direct_json);
    };
    if !proof
        .origins
        .iter()
        .any(|origin| matches!(origin, ProviderOrigin::Chat { .. }))
    {
        return Ok(direct_json);
    }
    let deadline = CommandDeadline::start(&ctx.budget, "prepare_chat_proof");
    let expected = expected.clone();
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let id = request.input.thread.clone();
    let parent = request.input.parent;
    let cut = store
        .with_read_tx_budget(Some(&ctx.budget), move |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                scope.check(&space.scope)?;
                let thread = load_thread_head_tx(tx, &scope.space_id, &id).await?;
                authorize_thread_mutation(&auth, &space.space, &thread, false)?;
                if thread.head_rev_id != expected {
                    // The writer owns CAS and replay, including concurrent duplicate appends.
                    return Ok(None);
                }
                let tainted = read_leaf_taint(tx, &scope.space_id, &id, parent).await?
                    || auth.taint().is_tainted();
                authorize_thread_mutation(&auth, &space.space, &thread, tainted)?;
                Ok(Some((thread, tainted)))
            })
        })
        .await?;
    let Some((thread, tainted)) = cut else {
        return Ok(direct_json);
    };
    #[cfg(feature = "test-support")]
    super::preparation_test::pause().await;
    let reader = PageReader::PrepareAppend(store, &ctx.budget, deadline);
    let Some(folded) =
        checkpoint::fold(reader, ctx.scope(), &thread, parent, tainted, proof).await?
    else {
        return Ok(direct_json);
    };
    let proof = proof.clone();
    serde_json::to_string(&StoredProvenance {
        origins: proof.origins,
        projects: proof.projects,
        compacts_through: proof.compacts_through,
        folded: Some(folded),
    })
    .map(Some)
    .map_err(|e| internal_not_committed("encode_folded_chat_proof", e.to_string()))
}

/// Direct proofs from earlier versions or a redaction are resolved at the read
/// cut. This only changes the in-memory row returned to the caller.
async fn fold_stored_proof(
    reader: PageReader<'_, '_>,
    scope: &HistoryScope,
    thread: &ThreadHeadRow,
    row: &mut PayloadRow,
) -> Result<(), PortError> {
    if let Some(parent) = row.parent_seq
        && let Some(proof) = row.provenance()?
        && let Some(folded) = checkpoint::fold(
            reader,
            scope,
            thread,
            queue::seq_from_db(parent)?,
            row.ext_space_tainted != 0,
            &proof,
        )
        .await?
    {
        row.provenance_json = proof_json(Some(&folded))?;
    }
    Ok(())
}

/// A provenance edge always points to an earlier entry in the same thread,
/// including edges to a sibling branch. Keep the direct proof so independent
/// entries can still be admitted after redaction.
pub(super) async fn invalidate_folded_proofs(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    redacted: i64,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "UPDATE chat_entries SET provenance_json=json_remove(provenance_json,'$.folded')
             WHERE space_id=$1 AND thread_id=$2 AND entry_seq>$3
             AND json_type(provenance_json,'$.folded') IS NOT NULL",
        )
        .bind(space.as_str())
        .bind(thread.as_str())
        .bind(redacted)
        .execute(&mut **conn)
        .await
        .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(
            "UPDATE chat_entries SET provenance_json=(provenance_json::jsonb - 'folded')::text
             WHERE space_id=$1 AND thread_id=$2 AND entry_seq>$3
             AND provenance_json::jsonb ? 'folded'",
        )
        .bind(space.as_str())
        .bind(thread.as_str())
        .bind(redacted)
        .execute(&mut **conn)
        .await
        .map(|_| ()),
    }
    .map_err(|error| internal_not_committed("invalidate_chat_proof", error.to_string()))
}

pub(super) async fn checkpoint_boundary(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    thread: &ChatThread,
    checkpoint: ThreadEntrySeq,
) -> Result<Option<ThreadEntrySeq>, PortError> {
    let budget = ctx.budget.clone();
    let ctx = ctx.clone();
    let thread = thread.clone();
    store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                ctx.check_current(&space.scope)?;
                let head = load_thread_head_tx(tx, &space.scope.space_id, &thread.id).await?;
                if head.head_rev_id != thread.revision {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                let row = load_payload(tx, &space.scope.space_id, &thread.id, checkpoint).await?;
                if row.kind != "compaction" {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                ctx.auth().authorize_chat_thread_read(
                    &space.space,
                    &thread.id,
                    head.kind,
                    &head.owner,
                    head.project_folder.as_ref(),
                    row.ext_space_tainted != 0,
                )?;
                Ok(row.provenance()?.and_then(|proof| proof.compacts_through))
            })
        })
        .await
}

fn transcript(
    auth: &EngineAuthContext,
    space: &Space,
    thread: &ThreadHeadRow,
    row: &PayloadRow,
    text: String,
) -> Result<CanonicalChatContent, PortError> {
    let mut content = CanonicalChatContent::from_canonical(
        space.clone(),
        thread.thread_id.clone(),
        row.seq()?,
        row.ext_space_tainted != 0,
        text,
        row.digest()?,
        thread.project_folder.clone(),
    );
    content = content.with_provenance(row.provenance()?);
    if let Some(author) = row.group_author(auth, thread)? {
        content = content.with_group_author(author);
    }
    Ok(content)
}

pub(crate) struct ChatSource {
    space: SpaceRecord,
    thread: ThreadHeadRow,
    row: PayloadRow,
}

/// Load the source and its authorization facts at a single cut. Legacy proof
/// traversal can then use short snapshots tied to that exact thread revision.
pub(crate) async fn chat_source_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    thread_id: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<ChatSource, PortError> {
    let thread = load_thread_head_tx(tx, &space.scope.space_id, thread_id).await?;
    auth.can_view_chat_thread(
        &space.space,
        thread_id,
        thread.kind,
        &thread.owner,
        thread.project_folder.as_ref(),
        false,
    )?;
    let row = load_payload(tx, &space.scope.space_id, thread_id, entry).await?;
    if row.is_redacted() {
        return Err(DomainError::ResourceNotFound.into());
    }
    auth.authorize_chat_thread_read(
        &space.space,
        thread_id,
        thread.kind,
        &thread.owner,
        thread.project_folder.as_ref(),
        row.ext_space_tainted != 0,
    )?;
    Ok(ChatSource {
        space: space.clone(),
        thread,
        row,
    })
}

impl ChatSource {
    pub(crate) async fn discover(
        self,
        store: &CanonicalStore,
        auth: &EngineAuthContext,
        budget: &CallBudget,
        deadline: CommandDeadline,
    ) -> Result<ProviderCurrentContent, PortError> {
        self.current(PageReader::Snapshots(store, budget, deadline), auth)
            .await
    }

    async fn current(
        mut self,
        reader: PageReader<'_, '_>,
        auth: &EngineAuthContext,
    ) -> Result<ProviderCurrentContent, PortError> {
        let Self { space, thread, row } = &mut self;
        fold_stored_proof(reader, &space.scope, thread, row).await?;
        let provenance = row.provenance()?;
        if row.kind != "human" && provenance.is_none() {
            return Err(DomainError::validation(ValidationReason::ClassEgressForbidden).into());
        }
        Ok(ProviderCurrentContent::Chat {
            space: space.space.clone(),
            thread: thread.thread_id.clone(),
            entry: row.seq()?,
            digest: row.digest()?,
            project: thread.project_folder.clone(),
            lifecycle: Lifecycle::Active,
            tainted: row.ext_space_tainted != 0,
            group_author: row.group_author(auth, thread)?,
            provenance,
        })
    }
}

pub(crate) async fn load_current_chat_for_egress_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    thread_id: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<ProviderCurrentContent, PortError> {
    let source = chat_source_tx(tx, auth, space, thread_id, entry).await?;
    source.current(PageReader::Pinned(tx), auth).await
}

pub(super) async fn hydrate_body(
    store: &CanonicalStore,
    scope: &HistoryScope,
    inline: Option<String>,
    digest: Option<Vec<u8>>,
    budget: &CallBudget,
    started: tokio::time::Instant,
) -> Result<String, PortError> {
    if let Some(inline) = inline {
        return Ok(inline);
    }
    let digest: [u8; 32] = digest
        .ok_or(DomainError::ResourceNotFound)?
        .try_into()
        .map_err(|_| internal_not_committed("chat_body_digest", "digest length"))?;
    let mut remaining = budget.clone();
    remaining.remaining = remaining.remaining.saturating_sub(started.elapsed());
    let deadline = crate::domain::common::CommandDeadline::start(&remaining, "hydrate_chat_body");
    let raw = deadline
        .prepare_read(&remaining, || {
            store.read_verified_blob_with_budget(
                scope,
                ContentDigest::from_bytes(digest),
                Some(&remaining),
            )
        })
        .await?;
    String::from_utf8(raw).map_err(|_| internal_not_committed("chat_body_utf8", "invalid UTF-8"))
}

fn decode_model(text: &str) -> Result<ModelTurn, PortError> {
    let payload = text.strip_prefix(MODEL_MARKER).ok_or_else(|| {
        internal_not_committed("chat_model_marker", "missing model envelope marker")
    })?;
    serde_json::from_str(payload)
        .map_err(|error| internal_not_committed("decode_chat_model", error.to_string()))
}

fn decode_proposal(text: &str) -> Result<ProposalTurn, PortError> {
    let payload = text.strip_prefix(PROPOSAL_MARKER).ok_or_else(|| {
        internal_not_committed("chat_proposal_marker", "missing proposal envelope marker")
    })?;
    serde_json::from_str(payload)
        .map_err(|error| internal_not_committed("decode_chat_proposal", error.to_string()))
}

/// Decode the durable body before exposing transcript or search text.
pub(super) fn decode_turn(format: i32, kind: &str, body: String) -> Result<ModelTurn, PortError> {
    let text = match (format, kind) {
        (0, _) => body,
        (1, "model") => return decode_model(&body),
        (2, "tool") => decode_proposal(&body)?.text,
        _ => {
            return Err(internal_not_committed(
                "chat_body_format",
                "wrong chat payload format",
            ));
        }
    };
    Ok(ModelTurn {
        text,
        tool_calls: Vec::new(),
        interruption: None,
    })
}

pub(super) async fn read_chat_contents(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatContentRead,
) -> Result<Vec<HydratedChatEntry>, PortError> {
    if request.entries.len() > 200 {
        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
    }
    let budget = ctx.budget.clone();
    let started = tokio::time::Instant::now();
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let deadline = CommandDeadline::start(&budget, "hydrate_chat_proof");
    let (space, thread, payloads) = store
        .with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let thread = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                auth.can_view_chat_thread(
                    &space.space,
                    &request.thread,
                    thread.kind,
                    &thread.owner,
                    thread.project_folder.as_ref(),
                    false,
                )?;
                let tainted =
                    read_leaf_taint(tx, &scope.space_id, &request.thread, request.leaf).await?;
                auth.authorize_chat_thread_read(
                    &space.space,
                    &request.thread,
                    thread.kind,
                    &thread.owner,
                    thread.project_folder.as_ref(),
                    tainted,
                )?;
                let payloads = load_branch_payloads(tx, &scope.space_id, &request).await?;
                Ok((space, thread, payloads))
            })
        })
        .await?;
    let mut results = Vec::with_capacity(payloads.len());
    for mut row in payloads {
        let reader = PageReader::Snapshots(store, &budget, deadline);
        fold_stored_proof(reader, &space.scope, &thread, &mut row).await?;
        let body = hydrate_body(
            store,
            &space.scope,
            row.inline_text.clone(),
            row.payload_blake3.clone(),
            &budget,
            started,
        )
        .await?;
        let ModelTurn {
            text,
            tool_calls,
            interruption,
        } = decode_turn(row.body_format, &row.kind, body)?;
        let content = transcript(ctx.auth(), &space.space, &thread, &row, text)?;
        results.push(HydratedChatEntry {
            seq: row.seq()?,
            content,
            interruption,
            tool_calls,
        });
    }
    deadline.remaining(&budget)?;
    Ok(results)
}

/// Exact read for human approval. This method returns an attestation for the
/// action that existed at the read cut. A writer must validate it at commit.
pub(super) async fn read_chat_proposal(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatProposalRead,
) -> Result<CanonicalChatProposal, PortError> {
    let auth = ctx.auth();
    auth.authorize_proposal_read()?;
    let budget = ctx.budget.clone();
    let started = tokio::time::Instant::now();
    let scope = ctx.scope().clone();
    let writer_auth = auth.clone();
    let (space, thread, tool, model) = store
        .with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let thread = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                if thread.kind != ChatThreadKind::Personal
                    || space.space.kind != SpaceKind::Personal
                    || space.owner != *writer_auth.principal()
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                writer_auth.authorize_chat_thread_read(
                    &space.space,
                    &request.thread,
                    thread.kind,
                    &thread.owner,
                    thread.project_folder.as_ref(),
                    true,
                )?;
                let tool =
                    load_payload(tx, &scope.space_id, &request.thread, request.entry).await?;
                if tool.kind != "tool"
                    || tool.body_format != BodyFormat::Proposal.db()
                    || tool.ext_space_tainted == 0
                    || tool.agent_run_id.is_none()
                    || tool.author_id != thread.owner.as_str()
                    || tool.provenance_json.is_none()
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let mut parent = tool.parent_seq;
                for _ in 0..MAX_TURN_CALLS {
                    let entry = parent.ok_or(DomainError::ResourceNotFound)?;
                    let previous = load_payload(
                        tx,
                        &scope.space_id,
                        &request.thread,
                        queue::seq_from_db(entry)?,
                    )
                    .await?;
                    if previous.author_id != tool.author_id
                        || previous.agent_run_id != tool.agent_run_id
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if previous.kind == "model" && previous.body_format == BodyFormat::Model.db() {
                        return Ok((space, thread, tool, previous));
                    }
                    if previous.kind != "tool" {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    parent = previous.parent_seq;
                }
                Err(DomainError::ResourceNotFound.into())
            })
        })
        .await?;

    let raw_model = hydrate_body(
        store,
        &space.scope,
        model.inline_text.clone(),
        model.payload_blake3.clone(),
        &budget,
        started,
    )
    .await?;
    let call_id = CommandKey::parse(
        tool.tool_call_id
            .as_deref()
            .ok_or(DomainError::ResourceNotFound)?,
    )?;
    let turn = decode_model(&raw_model)?;
    let tool_name = turn
        .tool_calls
        .into_iter()
        .find(|call| call.id.as_str() == call_id.as_str())
        .ok_or(DomainError::ResourceNotFound)?
        .name;
    let raw_tool = hydrate_body(
        store,
        &space.scope,
        tool.inline_text.clone(),
        tool.payload_blake3.clone(),
        &budget,
        started,
    )
    .await?;
    let ProposalTurn { text, envelope } = decode_proposal(&raw_tool)?;
    let content = transcript(ctx.auth(), &space.space, &thread, &tool, text)?;
    let witness = ChatProposalWitness::attest_canonical(
        space.scope.clone(),
        ctx.auth(),
        thread.thread_id,
        call_id,
        tool_name,
        proposal_entry(&model)?,
        proposal_entry(&tool)?,
    )?;
    Ok(CanonicalChatProposal::from_canonical(
        content, envelope, witness,
    ))
}

fn proposal_entry(row: &PayloadRow) -> Result<ChatProposalEntryWitness, PortError> {
    Ok(ChatProposalEntryWitness {
        seq: row.seq()?,
        revision: RevisionId::parse(&row.revision_id)?,
        digest: row.digest()?,
    })
}

/// Validate only the exact committed authority, without reopening the tainted
/// transcript, consulting a provider, or staging any content.
pub(crate) async fn verify_confirmed_chat_step_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    target: &HistoryScope,
    step: &ConfirmedChatStep,
    kind: &str,
    committing: bool,
) -> Result<(), PortError> {
    let witness = step.witness();
    target.check(&step.identity().scope)?;
    witness.authorize_writer(auth)?;
    if !matches!(
        (witness.tool_name(), kind),
        (
            "create_note" | "create_notes",
            "create_note" | "ensure_folder_path"
        ) | ("move_note", "move_note" | "ensure_folder_path")
            | ("edit_note", "edit_note")
            | ("rename_note", "rename_note")
            | ("delete_note", "trash_note")
            | ("link" | "link_many", "link")
            | (
                "remember_about_user" | "remember_about_project",
                "append_memory"
            )
    ) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }

    let source = witness.source();
    if committing
        && source.space_id != target.space_id
        && let BackendConn::Postgres(conn) = tx
    {
        // Same-Space writes already hold the canonical writer's row lock.
        // Source locking conflicts with redaction/archival but never waits
        // behind an unrelated batch that may itself need our target Space.
        let locked = sqlx::query_scalar::<_, i32>(
            "SELECT 1 FROM spaces WHERE space_id = $1 FOR SHARE NOWAIT",
        )
        .bind(source.space_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .and_then(|db| db.code())
                .as_deref()
                == Some("55P03")
            {
                return crate::codec::unavailable_retryable(
                    "chat_proposal_source_busy",
                    "proposal source is being changed",
                    std::time::Duration::from_millis(25),
                );
            }
            crate::runtime::pg_read_error("chat_proposal_source_lock", error)
        })?;
        if locked.is_none() {
            return Err(DomainError::ResourceNotFound.into());
        }
    }

    let space = load_space_record(tx, &source.space_id).await?;
    space.scope.check(source)?;
    let thread = load_thread_head_tx(tx, &source.space_id, witness.thread()).await?;
    if space.space.lifecycle != SpaceLifecycle::Active
        || space.space.kind != SpaceKind::Personal
        || &space.owner != witness.owner()
        || thread.kind != ChatThreadKind::Personal
        || &thread.owner != witness.owner()
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let tool = load_payload(tx, &source.space_id, witness.thread(), witness.tool().seq).await?;
    let model = load_payload(tx, &source.space_id, witness.thread(), witness.model().seq).await?;
    if tool.kind != "tool"
        || tool.body_format != BodyFormat::Proposal.db()
        || tool.tool_call_id.as_deref() != Some(witness.call_id().as_str())
        || tool.provenance_json.is_none()
        || tool.ext_space_tainted == 0
        || tool.author_id != witness.owner().as_str()
        || tool.agent_run_id.is_none()
        || model.kind != "model"
        || model.body_format != BodyFormat::Model.db()
        || model.author_id != tool.author_id
        || model.agent_run_id != tool.agent_run_id
        || tool.revision_id != witness.tool().revision.as_str()
        || model.revision_id != witness.model().revision.as_str()
        || tool.digest()? != witness.tool().digest
        || model.digest()? != witness.model().digest
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

const COLUMNS: &str = "entry_seq, parent_seq, revision_id,
    CASE WHEN checkpoint_stale <> 0 THEN 'redacted' ELSE kind END AS kind,
    author_id, agent_run_id, tool_call_id, inline_text, payload_blake3,
    CAST(ext_space_tainted AS INTEGER) AS ext_space_tainted, body_format, provenance_json";

async fn load_payload(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<PayloadRow, PortError> {
    let query = format!(
        "SELECT {COLUMNS} FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3"
    );
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(sqlx::AssertSqlSafe(query))
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(entry.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(sqlx::AssertSqlSafe(query))
                .bind(space.as_str())
                .bind(thread.as_str())
                .bind(entry.get() as i64)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_body_header", error))?
    .ok_or_else(|| DomainError::ResourceNotFound.into())
}

async fn load_branch_payloads(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    request: &ChatContentRead,
) -> Result<Vec<PayloadRow>, PortError> {
    let mut keys = BTreeSet::new();
    if request
        .entries
        .iter()
        .any(|seq| !keys.insert(seq.get() as i64))
    {
        return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!("WITH RECURSIVE path(entry_seq, parent_seq, depth) AS (
            SELECT entry_seq, parent_seq, 1 FROM chat_entries
            WHERE space_id = $1 AND thread_id = $2 AND entry_seq = $3
            UNION ALL
            SELECT e.entry_seq, e.parent_seq, p.depth + 1 FROM path p
            JOIN chat_entries e ON e.space_id = $1 AND e.thread_id = $2 AND e.entry_seq = p.parent_seq
            WHERE p.depth < 200
        )
        SELECT {COLUMNS} FROM chat_entries
        WHERE space_id = $1 AND thread_id = $2 AND entry_seq IN
            (SELECT entry_seq FROM path WHERE entry_seq IN ({{keys}}))");
    let rows: Vec<PayloadRow> = match tx {
        BackendConn::Sqlite(conn) => {
            let values = serde_json::to_string(&keys).map_err(|error| {
                internal_not_committed("encode_chat_sequences", error.to_string())
            })?;
            let query = query.replace("{keys}", "SELECT value FROM json_each($4)");
            sqlx::query_as(sqlx::AssertSqlSafe(query))
                .bind(space.as_str())
                .bind(request.thread.as_str())
                .bind(request.leaf.get() as i64)
                .bind(values)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            let values = Vec::from_iter(keys);
            let query = query.replace("{keys}", "SELECT unnest($4::BIGINT[])");
            sqlx::query_as(sqlx::AssertSqlSafe(query))
                .bind(space.as_str())
                .bind(request.thread.as_str())
                .bind(request.leaf.get() as i64)
                .bind(values)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|error| crate::runtime::pg_read_error("chat_branch_payloads", error))?;
    let mut by_seq: HashMap<i64, PayloadRow> =
        HashMap::from_iter(rows.into_iter().map(|row| (row.entry_seq, row)));
    let mut result = Vec::new();
    for seq in &request.entries {
        let row = by_seq
            .remove(&(seq.get() as i64))
            .ok_or(DomainError::ResourceNotFound)?;
        if !row.is_redacted() {
            result.push(row);
        }
    }
    Ok(result)
}

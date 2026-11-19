use std::collections::{BTreeSet, HashMap};

use notarium_core::{
    classes::{CanonicalChatContent, ProviderCurrentContent, ProviderOrigin},
    ports::{
        CallBudget, ChatProposalEntryWitness, ChatProposalWitness, ChatProvenance,
        ConfirmedChatStep, ProviderToolCall,
    },
};

use super::*;
use crate::runtime::SpaceRecord;

const MODEL_MARKER: &str = "\u{FDD0}notarium_model_turn_v1\n";
const PROPOSAL_MARKER: &str = "\u{FDD0}notarium_proposed_diff_v1\n";
pub(super) const MAX_TURN_BYTES: usize = AppendChat::MAX_STRUCTURED_BODY_BYTES;
const MAX_TURN_CALLS: usize = 64;

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
struct ModelTurn {
    text: String,
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
        ) {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
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
            && (!input.tool_calls.is_empty() || text.starts_with('\u{FDD0}') || text.contains('\0'))
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
        self.provenance_json
            .as_ref()
            .map(|raw| {
                serde_json::from_str(raw)
                    .map_err(|error| internal_not_committed("decode_chat_proof", error.to_string()))
            })
            .transpose()
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

pub(crate) async fn load_current_chat_for_egress_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    thread_id: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<ProviderCurrentContent, PortError> {
    let thread = load_thread_head_tx(tx, &space.scope.space_id, thread_id).await?;
    authorize_thread_read(
        auth,
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
    authorize_thread_read(
        auth,
        &space.space,
        thread_id,
        thread.kind,
        &thread.owner,
        thread.project_folder.as_ref(),
        row.ext_space_tainted != 0,
    )?;
    let provenance = row.provenance()?;
    if row.kind != "human" && provenance.is_none() {
        return Err(DomainError::validation(ValidationReason::ClassEgressForbidden).into());
    }
    Ok(ProviderCurrentContent::Chat {
        space: space.space.clone(),
        thread: thread_id.clone(),
        entry,
        digest: row.digest()?,
        project: thread.project_folder.clone(),
        lifecycle: Lifecycle::Active,
        tainted: row.ext_space_tainted != 0,
        group_author: row.group_author(auth, &thread)?,
        provenance,
    })
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
    let (space, thread, payloads) = store
        .with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let thread = load_thread_head_tx(tx, &scope.space_id, &request.thread).await?;
                authorize_thread_read(
                    &auth,
                    &space.space,
                    &request.thread,
                    thread.kind,
                    &thread.owner,
                    thread.project_folder.as_ref(),
                    false,
                )?;
                let tainted =
                    read_leaf_taint(tx, &scope.space_id, &request.thread, request.leaf).await?;
                authorize_thread_read(
                    &auth,
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
    for row in payloads {
        let body = hydrate_body(
            store,
            &space.scope,
            row.inline_text.clone(),
            row.payload_blake3.clone(),
            &budget,
            started,
        )
        .await?;
        let (text, tool_calls) = match row.body_format {
            0 => (body, Vec::new()),
            1 if row.kind == "model" => {
                let ModelTurn { text, tool_calls } = decode_model(&body)?;
                (text, tool_calls)
            }
            2 if row.kind == "tool" => (decode_proposal(&body)?.text, Vec::new()),
            _ => {
                return Err(internal_not_committed(
                    "chat_body_format",
                    "wrong chat payload format",
                ));
            }
        };
        let content = transcript(ctx.auth(), &space.space, &thread, &row, text)?;
        results.push(HydratedChatEntry {
            seq: row.seq()?,
            content,
            tool_calls,
        });
    }
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
                authorize_thread_read(
                    &writer_auth,
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

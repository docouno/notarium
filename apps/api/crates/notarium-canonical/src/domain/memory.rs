use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, RevisionId},
    model::HistoryScope,
    patch::CarrierEditOrigin,
    ports::{
        AppendMemory, Committed, CreateNote, MemoryAppendOutcome, MemoryAppendResult,
        MemoryWriteMode, Mutation, NoteRevision, Preconditions, ResolvedMemoryTarget, SpaceContext,
    },
    receipt::MutationReceiptToken,
    span::ByteSpan,
    value::YamlValue,
};
use notarium_syntax::{frontmatter, patch};
use serde::{Deserialize, Serialize};

use crate::{
    CanonicalStore, SpaceRecord,
    catalog::memory::{authorized_slot, initial_carrier},
    codec::{
        MAX_MSGPACK_DECODE_BYTES, decode_msgpack_bounded, encode_msgpack, internal_not_committed,
    },
    runtime::load_space_record,
    writer::{PreparedWriteIntent, replay::ReplayPolicy},
};

use super::{
    common::{
        CommandDeadline, NoteHeadRow, StoredCommittedNoteRevV1, derive_command_identity_spec,
        validate_mutation_identity,
    },
    notes::{
        analyze_and_prepare_carrier, build_carrier_replacement_intent, build_create_note_intent,
        try_replay_completed_receipt,
    },
};

const MAX_CONFLICT_RETRIES: usize = 3;

/// The first two fields preserve the legacy receipt layout. Absent metadata
/// from an old receipt means it appended to an existing note and carried no summary.
#[derive(Serialize, Deserialize)]
struct StoredMemoryAppend {
    value: NoteRevision,
    receipt: MutationReceiptToken,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    created: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    summary_updated: bool,
}

impl StoredMemoryAppend {
    fn committed(self, applied: bool) -> Committed<MemoryAppendResult> {
        let outcome = match (applied, self.created) {
            (false, _) => MemoryAppendOutcome::Skipped,
            (true, true) => MemoryAppendOutcome::Created,
            (true, false) => MemoryAppendOutcome::Appended,
        };
        Committed {
            value: MemoryAppendResult {
                revision: self.value,
                outcome,
                summary_updated: self.summary_updated,
            },
            receipt: self.receipt,
        }
    }
}

pub(super) async fn append(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<AppendMemory>,
) -> Result<Committed<MemoryAppendResult>, PortError> {
    let budget = ctx.budget.clone();
    let deadline = CommandDeadline::start(&budget, "append_memory");
    validate_mutation_identity(&ctx, &request.identity)?;
    let input = &request.input;
    let target = &input.target;
    let note = &target.note.note_id;
    let text = input.text.trim();
    if text.is_empty()
        || (input.mode == MemoryWriteMode::RequireAbsent
            && request.preconditions != Preconditions::default())
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let fingerprint = if input.mode == MemoryWriteMode::RequireExisting && input.summary.is_none() {
        format!("note={note}\0cat={}\0text={text}", target.category).into_bytes()
    } else {
        encode_msgpack(&(
            "memory-write-v1",
            note,
            &target.category,
            text,
            &input.summary,
            input.mode,
        ))?
    };
    let idempotency =
        derive_command_identity_spec(&request.identity, "append_memory", &fingerprint)
            .with_preconditions(&request.preconditions, "note", note.as_str())
            .with_canonical_effect(&ctx)
            .with_confirmed_chat_step(&ctx, "append_memory")
            .with_policy(ctx.auth(), ReplayPolicy::Memory(target.clone()));
    if let Some(replayed) = deadline
        .prepare(&budget, || {
            try_replay_completed_receipt::<StoredMemoryAppend>(
                store,
                ctx.scope(),
                &idempotency,
                Some(&budget),
            )
        })
        .await?
    {
        return Ok(replayed.committed(false));
    }
    let can_retry = input.mode == MemoryWriteMode::CreateIfMissing
        && request.preconditions == Preconditions::default();
    let mut conflicts = 0;
    loop {
        ctx.budget.remaining = deadline.remaining(&budget)?;
        let (space, parent, head) = read_slot(store, &ctx, target.clone()).await?;
        if let Err(error) = check_requested_state(head.as_ref(), input.mode, &request.preconditions)
        {
            // An identical command may have committed after the first lookup
            // and advanced the head to the revision that failed this predicate.
            if let Some(replayed) = deadline
                .prepare(&budget, || {
                    try_replay_completed_receipt::<StoredMemoryAppend>(
                        store,
                        ctx.scope(),
                        &idempotency,
                        Some(&budget),
                    )
                })
                .await?
            {
                return Ok(replayed.committed(false));
            }
            return Err(error);
        }
        let base = match &head {
            Some(head) => {
                let digest = head.content_digest.ok_or_else(|| {
                    internal_not_committed("memory_missing_digest", "AgentMemory note lacks digest")
                })?;
                let raw = deadline
                    .prepare(&budget, || store.read_verified_blob(&space.scope, digest))
                    .await?;
                String::from_utf8(raw).map_err(|_| {
                    internal_not_committed(
                        "memory_corrupt_utf8",
                        "AgentMemory carrier is not UTF-8",
                    )
                })?
            }
            None => initial_carrier(&target.category),
        };
        let carrier = prepare_carrier(base, &target.category, text, input.summary.as_deref())?;
        let slug = head.as_ref().map_or_else(
            || format!("memory-{}", target.category),
            |head| head.slug.clone(),
        );
        let info = analyze_and_prepare_carrier(
            &carrier,
            DocClass::AgentMemory,
            note,
            &slug,
            store.blob_codec(),
        )?;
        let ticket = deadline
            .prepare(&budget, || {
                store.stage_blob_for_batch(&space.scope, space.active_epoch, &info.prepared_blob)
            })
            .await?;

        let prepared_revision = head.as_ref().map(|head| head.head_rev_id.clone());
        let intent = match head {
            Some(head) => build_carrier_replacement_intent(
                store,
                &space.scope,
                space.active_epoch,
                Some(idempotency.clone()),
                "append_memory",
                ctx.auth().clone(),
                request.identity.clone(),
                request.preconditions.clone(),
                note.clone(),
                head.head_rev_id,
                None,
                info,
                ticket,
                None,
            ),
            None => {
                let folded = crate::codec::normalize_slug_key(&slug)?;
                build_create_note_intent(
                    &space.scope,
                    space.active_epoch,
                    Some(idempotency.clone()),
                    ctx.auth().clone(),
                    CreateNote {
                        note: note.clone(),
                        parent: Some(parent),
                        slug,
                        class: DocClass::AgentMemory,
                        carrier,
                        folder_page: false,
                    },
                    folded,
                    info,
                    ticket,
                )
            }
        };
        let applied = Arc::new(AtomicBool::new(false));
        let intent = bind_intent(
            intent,
            ctx.auth().clone(),
            target.clone(),
            prepared_revision,
            input.summary.is_some(),
            Arc::clone(&applied),
        );
        ctx.budget.remaining = deadline.remaining(&budget)?;
        match deadline
            .submit::<StoredMemoryAppend>(store, &ctx.budget, intent)
            .await
        {
            Ok(stored) => return Ok(stored.committed(applied.load(Ordering::Acquire))),
            Err(PortError::Domain(DomainError::RevisionConflict { .. }))
                if can_retry && conflicts < MAX_CONFLICT_RETRIES =>
            {
                conflicts += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn read_slot(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    target: ResolvedMemoryTarget,
) -> Result<(SpaceRecord, FolderId, Option<NoteHeadRow>), PortError> {
    let auth = ctx.auth().clone();
    let scope = ctx.scope().clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let (parent, head) = authorized_slot(tx, &auth, &space, &target).await?;
                Ok((space, parent, head))
            })
        })
        .await
}

fn check_requested_state(
    head: Option<&NoteHeadRow>,
    mode: MemoryWriteMode,
    preconditions: &Preconditions,
) -> Result<(), PortError> {
    if let Some(head) = head {
        if mode == MemoryWriteMode::RequireAbsent
            || preconditions
                .revision
                .as_ref()
                .is_some_and(|expected| expected != &head.head_rev_id)
        {
            return Err(conflict(head.head_rev_id.clone()));
        }
    } else if mode == MemoryWriteMode::RequireExisting || preconditions != &Preconditions::default()
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(())
}

fn conflict(current: RevisionId) -> PortError {
    DomainError::RevisionConflict {
        current,
        lineage: None,
    }
    .into()
}

fn prepare_carrier(
    mut carrier: String,
    category: &str,
    observation: &str,
    summary: Option<&str>,
) -> Result<String, PortError> {
    if let Some(summary) = summary {
        let plan = frontmatter::set_field(
            &carrier,
            DocClass::AgentMemory,
            "summary",
            YamlValue::String(summary.to_owned()),
        )?;
        carrier = patch::apply(&carrier, &plan)?;
    }
    let header = frontmatter::analyze(&carrier, DocClass::AgentMemory)?;
    let leading = if carrier.is_empty() || carrier.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let end = carrier.len();
    let plan = patch::plan(
        &carrier,
        header.carrier.body,
        vec![(
            CarrierEditOrigin::Body,
            ByteSpan::new(end, end)?,
            format!("{leading}- [{category}] {observation}\n"),
        )],
    )?;
    Ok(patch::apply(&carrier, &plan)?)
}

fn bind_intent(
    mut intent: PreparedWriteIntent,
    auth: EngineAuthContext,
    target: ResolvedMemoryTarget,
    prepared_revision: Option<RevisionId>,
    summary_updated: bool,
    applied: Arc<AtomicBool>,
) -> PreparedWriteIntent {
    let scope: HistoryScope = intent.scope.clone();
    let write_note = intent.execute;
    intent.execute = Box::new(move |tx, item| {
        Box::pin(async move {
            let space = load_space_record(tx, &scope.space_id).await?;
            space.scope.check(&scope)?;
            let (_, head) = authorized_slot(tx, &auth, &space, &target).await?;
            let actual = head.map(|head| head.head_rev_id);
            if actual != prepared_revision {
                return Err(actual.map_or_else(|| DomainError::ResourceNotFound.into(), conflict));
            }
            let mut artifacts = write_note(tx, item).await?;
            let stored: StoredCommittedNoteRevV1 =
                decode_msgpack_bounded(&artifacts.response_bytes, MAX_MSGPACK_DECODE_BYTES)?;
            let stored = StoredMemoryAppend {
                value: stored.value,
                receipt: stored.receipt,
                created: prepared_revision.is_none(),
                summary_updated,
            };
            let bytes = CanonicalStore::encode_command_outcome(&stored)?;
            artifacts.receipt_sanitized_blob = bytes.clone();
            artifacts.response_bytes = bytes;
            applied.store(true, Ordering::Release);
            Ok(artifacts)
        })
    });
    intent
}

#[cfg(test)]
mod tests {
    use notarium_core::ids::{HistoryIncarnation, NoteId, SpaceId, SpaceSeq};

    use super::*;

    #[test]
    fn b03_receipt_replays_without_new_metadata() {
        let legacy = StoredCommittedNoteRevV1 {
            value: NoteRevision {
                note: NoteId::from_bytes([1; 16]),
                revision: RevisionId::from_bytes([2; 16]),
            },
            receipt: MutationReceiptToken::new(
                HistoryScope {
                    space_id: SpaceId::from_bytes([3; 16]),
                    incarnation: HistoryIncarnation::from_bytes([4; 16]),
                },
                SpaceSeq::new(5).unwrap(),
            )
            .unwrap(),
        };
        let bytes = CanonicalStore::encode_command_outcome(&legacy).unwrap();
        let decoded: StoredMemoryAppend =
            decode_msgpack_bounded(&bytes, MAX_MSGPACK_DECODE_BYTES).unwrap();
        assert_eq!(
            CanonicalStore::encode_command_outcome(&decoded).unwrap(),
            bytes
        );
        let replayed = decoded.committed(false);
        assert_eq!(replayed.value.revision, legacy.value);
        assert_eq!(replayed.receipt, legacy.receipt);
        assert_eq!(replayed.value.outcome, MemoryAppendOutcome::Skipped);
        assert!(!replayed.value.summary_updated);
    }
}

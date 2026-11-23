mod v1_receipts;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    classes::{
        ClassEgressFence, ClassifiedDocument, ClassifiedMetadata, DocClass, authorize_field_key,
    },
    error::{Diagnostic, PortError, ValidationReason},
    ids::{
        BodyIdentity, ContentDigest, HeaderIdentity, LeaseEpoch, LineageEpoch, NoteId, RevisionId,
        SpaceId, SpaceSeq,
    },
    model::{FolderRef, Lifecycle, NoteRef, PathTarget, SnapshotCut},
    patch::{CarrierEditOrigin, CarrierPatchPlan, HeaderMutation},
    ports::{
        AcceptBatch, BatchItem, BatchResult, Committed, CreateNote, DeleteDisposition, DeleteNote,
        EditNote, ExternalObservation, ExternalObservationResult, FilenamePin, GetNote,
        InterceptedMutation, InterceptedOutcome, InterceptedPayload, InterceptionResult, Link,
        LinkBatch, LinkTarget, MoveNote, Mutation, NoteCard, NoteRevision, NoteSnapshot,
        ObservedContent, Preconditions, RenameNote, SpaceContext,
    },
    query::{FieldObservation, FieldValue},
    receipt::{CausalBasis, CommandIdentity, MutationReceiptToken},
    span::ByteSpan,
    value::YamlValue,
};
use notarium_syntax::frontmatter::FieldEdit;

use crate::{
    CanonicalStore,
    blobs::{
        BlobCodecTag, BlobOwnerKind, BlobReferenceClaim, PreparedBlobSource,
        activate_and_bind_blob_ref_tx, bind_existing_active_blob_ref_tx,
    },
    changes::{
        ChangedNoteSummaryV1, EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft,
    },
    codec::{
        NoteRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload, doc_class_to_db,
        encode_timestamp_parts, evaluate_fields_with_schema, internal_not_committed,
        lifecycle_to_db, new_prefixed_hex_id, new_revision_id, normalize_slug_key,
        normalize_title_key, now_utc_timestamp, unavailable_retryable,
    },
    domain::common::{
        CommandDeadline, FolderAncestryCache, NoteHeadRow, SpaceSchemaRevision,
        StoredCommittedLinkV1, StoredCommittedNoteRevV1, StoredCommittedSchemaRevV1,
        StoredExternalObsOutcomeV1, UpdateSpaceSchema, active_note_sibling_exists_tx,
        build_resource_facts_tx, check_collab_preconditions_tx, derive_command_identity_spec,
        extract_agent_run_from_auth, extract_note_preview, extract_note_title,
        insert_note_alias_tx, is_note_room_active_tx, load_current_space_schema_tx,
        load_folder_ancestry_tx, load_note_head_row_opt_tx, load_note_head_row_tx,
        note_rank_version_digest, schema_descriptor_bytes_and_fingerprint,
        upsert_agent_run_head_tx, validate_mutation_identity,
    },
    runtime::{
        insert_revision_row, is_note_purge_fenced_tx, load_space_record,
        read_immutable_revision_tx, validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

#[derive(Clone, Debug)]
pub(crate) struct PreparedCarrierInfo {
    pub raw_fields: Option<BTreeMap<String, YamlValue>>,
    pub diagnostics: Vec<Diagnostic>,
    pub title: String,
    pub title_fold: String,
    pub byte_size: u64,
    pub prepared_blob: PreparedBlobSource,
}

pub(crate) type EvaluatedFields = BTreeMap<String, FieldObservation<FieldValue>>;

/// Canonical carrier and CRDT snapshot prepared by the actor owning this room lease.
#[derive(Clone)]
pub struct RoomCommandSettlement {
    pub owner_id: String,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
    pub expected_base_rev: RevisionId,
    pub final_carrier: String,
    pub yrs_snapshot: Vec<u8>,
    pub compacted_through_update_seq: Option<u64>,
}

pub(super) struct PreparedRoomCommand {
    pub space: crate::SpaceRecord,
    pub head: NoteHeadRow,
    pub base_carrier: String,
    pub final_carrier: String,
    pub transition: crate::peers::RoomCarrierTransition,
}

pub(super) async fn prepare_room_command(
    store: &CanonicalStore,
    ctx: &mut SpaceContext,
    deadline: CommandDeadline,
    note: &NoteId,
    settlement: RoomCommandSettlement,
) -> Result<PreparedRoomCommand, PortError> {
    let transition = crate::peers::RoomCarrierTransition::for_room_command(
        settlement.owner_id,
        settlement.expected_lease,
        settlement.expected_lineage,
        settlement.yrs_snapshot,
        settlement.compacted_through_update_seq,
    );
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let (space, head) = deadline
        .prepare(&ctx.budget, || {
            transition.check_before_staging(
                store,
                &ctx.budget,
                ctx.scope(),
                note,
                ctx.auth(),
                Some(&settlement.expected_base_rev),
            )
        })
        .await?;
    if head.doc_class != DocClass::UserDoc {
        return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
    }
    let digest = head.content_digest.ok_or_else(|| {
        internal_not_committed(
            "room_missing_digest",
            "active room note lacks content_blake3",
        )
    })?;
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let bytes = deadline
        .prepare(&ctx.budget, || {
            store.read_verified_blob_with_budget(&space.scope, digest, Some(&ctx.budget))
        })
        .await?;
    let base_carrier = String::from_utf8(bytes).map_err(|_| {
        internal_not_committed(
            "room_corrupt_utf8",
            "active room carrier is not valid UTF-8",
        )
    })?;
    Ok(PreparedRoomCommand {
        space,
        head,
        base_carrier,
        final_carrier: settlement.final_carrier,
        transition,
    })
}

impl PreparedRoomCommand {
    pub async fn stage_carrier(
        &self,
        store: &CanonicalStore,
        budget: &notarium_core::ports::CallBudget,
        deadline: CommandDeadline,
    ) -> Result<(PreparedCarrierInfo, crate::blobs::StagedBlobTicket), PortError> {
        let header = enforce_room_frontmatter_unchanged_with_header(
            &self.base_carrier,
            &self.final_carrier,
            self.head.doc_class,
        )?;
        let info = analyze_and_prepare_carrier_opt_preparsed(
            &self.final_carrier,
            self.head.doc_class,
            &self.head.note_id,
            &self.head.slug,
            store.blob_codec(),
            header,
        )?;
        let ticket = deadline
            .prepare(budget, || {
                store.stage_blob_for_batch_prechecked(
                    &self.space.scope,
                    self.space.active_epoch,
                    &info.prepared_blob,
                )
            })
            .await?;
        Ok((info, ticket))
    }
}

impl CanonicalStore {
    pub fn derive_carrier_identities(revision: &RevisionId) -> (BodyIdentity, HeaderIdentity) {
        derive_body_header_identities(revision)
    }

    /// Commit the original edit and its complete room state in the same writer transaction.
    pub async fn commit_intercepted_edit_note(
        &self,
        mut ctx: SpaceContext,
        identity: CommandIdentity,
        preconditions: Preconditions,
        input: EditNote,
        settlement: RoomCommandSettlement,
    ) -> Result<Committed<NoteRevision>, PortError> {
        let deadline = CommandDeadline::start(&ctx.budget, "edit_room");
        let active_op = self.enter_write_op(&ctx.scope().space_id)?;
        super::common::validate_confirmable_mutation_identity(&ctx, &identity)?;
        let idemp = edit_note_identity(&ctx, &identity, &input, &preconditions);
        if let Some(replayed) = deadline
            .prepare(&ctx.budget, || {
                try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
                    self,
                    ctx.scope(),
                    &idemp,
                    Some(&ctx.budget),
                )
            })
            .await?
        {
            return Ok(replayed.into_committed());
        }
        let work = prepare_room_command(self, &mut ctx, deadline, &input.note, settlement).await?;
        let (info, ticket) = work.stage_carrier(self, &ctx.budget, deadline).await?;
        let intent = build_carrier_replacement_intent(
            self,
            &work.space.scope,
            work.space.active_epoch,
            Some(idemp),
            "edit_note",
            ctx.auth().clone(),
            identity,
            preconditions,
            input.note,
            work.head.head_rev_id,
            CarrierReplacement::Edit,
            info,
            ticket,
            Some(CarrierRoomWrite::Accepted(work.transition)),
        );
        let stored: StoredCommittedNoteRevV1 = self
            .submit_write_command_until(
                &ctx.budget,
                deadline.at,
                intent,
                None,
                None,
                Some(active_op),
            )
            .await?;
        Ok(stored.into_committed())
    }
}

pub(crate) fn revision_fields(bytes: &[u8]) -> Result<EvaluatedFields, PortError> {
    match RevisionMetadataEnvelope::decode(bytes)?.payload {
        RevisionMetadataPayload::Note(note) => Ok(note.evaluated_fields),
        _ => Err(internal_not_committed(
            "invalid_note_revision",
            "expected note fields",
        )),
    }
}

pub(crate) fn changed_note_fields(
    previous: &EvaluatedFields,
    current: &EvaluatedFields,
) -> EvaluatedFields {
    let mut changes = EvaluatedFields::new();
    for (key, value) in current {
        if previous.get(key).unwrap_or(&FieldObservation::Absent) != value {
            changes.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in previous {
        if *value != FieldObservation::Absent && !current.contains_key(key) {
            changes.insert(key.clone(), FieldObservation::Absent);
        }
    }
    changes
}

pub(crate) async fn changed_revision_fields_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    previous_rev: &RevisionId,
    current: &EvaluatedFields,
) -> Result<EvaluatedFields, PortError> {
    let bytes = load_revision_metadata_tx(tx, scope, previous_rev).await?;
    Ok(changed_note_fields(&revision_fields(&bytes)?, current))
}

async fn load_revision_metadata_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    revision: &RevisionId,
) -> Result<Vec<u8>, PortError> {
    load_revision_metadata_opt_tx(tx, scope, revision)
        .await?
        .ok_or_else(|| {
            internal_not_committed("read_revision_metadata", "missing previous revision")
        })
}

pub(super) async fn load_revision_metadata_opt_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    revision: &RevisionId,
) -> Result<Option<Vec<u8>>, PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(
                "SELECT metadata_msgpack FROM revisions WHERE space_id = ? AND rev_id = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(revision.as_str())
            .fetch_optional(&mut **conn)
            .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(
                "SELECT metadata_msgpack FROM revisions WHERE space_id = $1 AND rev_id = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(revision.as_str())
            .fetch_optional(&mut **conn)
            .await
        }
    }
    .map_err(|e| crate::runtime::pg_read_error("read_revision_metadata", e))
}

pub(crate) fn analyze_and_prepare_carrier(
    carrier: &str,
    class: DocClass,
    note_id: &NoteId,
    slug: &str,
    codec: BlobCodecTag,
) -> Result<PreparedCarrierInfo, PortError> {
    analyze_and_prepare_carrier_opt_preparsed(carrier, class, note_id, slug, codec, None)
}

pub(crate) fn analyze_and_prepare_carrier_opt_preparsed(
    carrier: &str,
    class: DocClass,
    _note_id: &NoteId,
    slug: &str,
    codec: BlobCodecTag,
    preparsed_hdr: Option<PreparsedHeaderTuple>,
) -> Result<PreparedCarrierInfo, PortError> {
    analyze_carrier_metadata(carrier, class, slug, preparsed_hdr, || {
        PreparedBlobSource::prepare(carrier.as_bytes(), codec)
    })
}

fn analyze_carrier_metadata(
    carrier: &str,
    class: DocClass,
    slug: &str,
    preparsed_hdr: Option<PreparsedHeaderTuple>,
    prepared: impl FnOnce() -> Result<PreparedBlobSource, PortError>,
) -> Result<PreparedCarrierInfo, PortError> {
    let (raw_fields, diagnostics, headings) = if class == DocClass::EncryptedNote {
        notarium_syntax::encrypted::validate(carrier)?;
        (None, Vec::new(), Vec::new())
    } else if let Some((fields, diag_opt, body_start)) = preparsed_hdr
        && let Ok(body_span) = ByteSpan::new(body_start, carrier.len())
    {
        let md = notarium_syntax::markdown::analyze(carrier, body_span)?;
        let diags = diag_opt
            .map(|reason| Diagnostic {
                reason,
                location: None,
            })
            .into_iter()
            .collect();
        (fields, diags, md.headings)
    } else {
        let header = notarium_syntax::frontmatter::analyze(carrier, class)?;
        let md = notarium_syntax::markdown::analyze(carrier, header.carrier.body)?;
        let diags = header
            .diagnostic
            .map(|reason| Diagnostic {
                reason,
                location: None,
            })
            .into_iter()
            .collect();
        (header.fields, diags, md.headings)
    };
    let title = extract_note_title(carrier, slug, class, raw_fields.as_ref(), &headings);
    let title_fold = if class == DocClass::EncryptedNote {
        normalize_title_key(slug)
    } else {
        normalize_title_key(&title)
    };
    let prepared_blob = prepared()?;
    Ok(PreparedCarrierInfo {
        raw_fields,
        diagnostics,
        title,
        title_fold,
        byte_size: carrier.len() as u64,
        prepared_blob,
    })
}

fn derive_body_header_identities(rev: &RevisionId) -> (BodyIdentity, HeaderIdentity) {
    let h_body = blake3::hash(format!("body:{}", rev.as_str()).as_bytes());
    let h_hdr = blake3::hash(format!("hdr:{}", rev.as_str()).as_bytes());
    let mut b_arr = [0u8; 16];
    let mut h_arr = [0u8; 16];
    b_arr.copy_from_slice(&h_body.as_bytes()[..16]);
    h_arr.copy_from_slice(&h_hdr.as_bytes()[..16]);
    (
        BodyIdentity::from_bytes(b_arr),
        HeaderIdentity::from_bytes(h_arr),
    )
}

fn build_collab_edit_payload(
    _note: &NoteId,
    before_carrier: &str,
    after_carrier: &str,
    plan: &CarrierPatchPlan,
    class: DocClass,
    base_rev: &RevisionId,
) -> Result<(notarium_core::patch::BodyPatchPlan, HeaderMutation), PortError> {
    let (body_id, hdr_id) = derive_body_header_identities(base_rev);
    let body_plan = notarium_syntax::patch::body_plan(before_carrier, plan, body_id)?;
    let has_header_edit = plan
        .edits
        .iter()
        .any(|e| e.origin == CarrierEditOrigin::Header);
    let header_mut = if !has_header_edit || class == DocClass::EncryptedNote {
        HeaderMutation::Preserve
    } else {
        collab_raw_header(before_carrier, after_carrier, class, hdr_id)?
    };
    Ok((body_plan, header_mut))
}

fn collab_raw_header(
    before: &str,
    after: &str,
    class: DocClass,
    identity: HeaderIdentity,
) -> Result<HeaderMutation, PortError> {
    Ok(
        match notarium_syntax::live::raw_header_plan_between(before, after, class, identity)? {
            Some(plan) => HeaderMutation::RawHeader(plan),
            None => HeaderMutation::Preserve,
        },
    )
}

fn create_note_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
    input: &CreateNote,
    root: &notarium_core::ids::FolderId,
    digest: ContentDigest,
) -> crate::writer::CommandIdentitySpec {
    let parent = input
        .parent
        .as_ref()
        .filter(|id| *id != root)
        .map_or("", |id| id.as_str());
    let mut hash = blake3::Hasher::new();
    for part in [
        input.note.as_str(),
        parent,
        &input.slug,
        doc_class_to_db(input.class),
    ] {
        hash.update(part.as_bytes());
        hash.update(&[0]);
    }
    hash.update(digest.as_bytes());
    if input.folder_page {
        hash.update(b"folder-page");
    }
    derive_command_identity_spec(ctx, identity, "create_note", hash.finalize().as_bytes())
        .with_confirmed_chat_step(ctx, "create_note")
        .for_create(ctx.auth(), &input.note, input.parent.as_ref(), input.class)
}

fn edit_note_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
    input: &EditNote,
    preconditions: &Preconditions,
) -> crate::writer::CommandIdentitySpec {
    let mut hash = blake3::Hasher::new();
    hash.update(input.note.as_str().as_bytes());
    hash_carrier_plan(&mut hash, &input.plan);
    hash_preconditions(&mut hash, preconditions);
    derive_command_identity_spec(ctx, identity, "edit_note", hash.finalize().as_bytes())
        .with_confirmed_chat_step(ctx, "edit_note")
        .for_note(ctx.auth(), &input.note)
}

fn hash_carrier_plan(hash: &mut blake3::Hasher, plan: &CarrierPatchPlan) {
    hash.update(plan.base_content_hash.as_bytes());
    hash.update(&(plan.body_range.start() as u64).to_be_bytes());
    hash.update(&(plan.body_range.end() as u64).to_be_bytes());
    hash.update(&(plan.edits.len() as u64).to_be_bytes());
    for edit in &plan.edits {
        hash.update(&[match edit.origin {
            CarrierEditOrigin::Header => 0,
            CarrierEditOrigin::Body => 1,
        }]);
        for offset in [
            edit.bytes.0.start(),
            edit.bytes.0.end(),
            edit.utf16.0.start(),
            edit.utf16.0.end(),
            edit.replacement_utf16_len,
            edit.replacement.len(),
        ] {
            hash.update(&(offset as u64).to_be_bytes());
        }
        hash.update(edit.replacement.as_bytes());
    }
}

fn hash_preconditions(hash: &mut blake3::Hasher, preconditions: &Preconditions) {
    hash.update(
        preconditions
            .revision
            .as_ref()
            .map_or("", RevisionId::as_str)
            .as_bytes(),
    );
    for epoch in [
        preconditions.lease.map(|v| v.get()),
        preconditions.lineage.map(|v| v.get()),
    ] {
        hash.update(&epoch.unwrap_or(u64::MAX).to_be_bytes());
    }
}

async fn authorize_create_placement(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    parent: Option<notarium_core::ids::FolderId>,
    class: DocClass,
) -> Result<crate::SpaceRecord, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    if let crate::runtime::SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql {
        store.ensure_open()?;
        let wal = store.inner.wal_coord.get().ok_or_else(|| {
            internal_not_committed("sqlite_wal_coord_missing", "missing WAL coordinator")
        })?;
        return fast_read_pool
            .with_read_conn(wal, Some(&ctx.budget), move |conn| {
                let space = crate::sqlite_fast::load_space_record_rusqlite(conn, &scope.space_id)?;
                space.scope.check(&scope)?;
                let (facts, _) = crate::sqlite_fast::build_resource_facts_rusqlite(
                    conn,
                    &space.space,
                    parent.as_ref().unwrap_or(&space.root_folder_id),
                    class,
                    None,
                    true,
                )?;
                auth.authorize_direct_write(&facts, &facts)?;
                Ok(space)
            })
            .await;
    }
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                let (facts, _) = build_resource_facts_tx(
                    tx,
                    &space.space,
                    parent.as_ref().unwrap_or(&space.root_folder_id),
                    class,
                    None,
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;
                Ok(space)
            })
        })
        .await
}

pub(crate) async fn create_note_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<CreateNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    let budget = ctx.budget.clone();
    let deadline = super::common::CommandDeadline::start(&budget, "create_note");
    let active_op_guard = store.enter_write_op(&ctx.scope().space_id)?;
    super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;
    if let Some(step) = ctx.confirmed_chat_step()
        && (request.input.class != DocClass::UserDoc
            || step
                .destination()
                .is_none_or(|destination| destination.move_source.is_some()))
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let slug_fold = super::folder_cover::validate_create(&request.input)?;
    if request.input.class == DocClass::Skill {
        ctx.auth().authorize_ability_mutation()?;
    }

    let info = analyze_and_prepare_carrier(
        &request.input.carrier,
        request.input.class,
        &request.input.note,
        &request.input.slug,
        store.blob_codec(),
    )?;

    ctx.budget.remaining = deadline.remaining(&budget)?;
    let space_rec = deadline
        .wait(&budget, || {
            authorize_create_placement(
                store,
                &ctx,
                request.input.parent.clone(),
                request.input.class,
            )
        })
        .await??;

    let ticket = deadline
        .wait(&budget, || {
            store.stage_blob_for_batch_prechecked(
                &space_rec.scope,
                space_rec.active_epoch,
                &info.prepared_blob,
            )
        })
        .await??;

    let created = v1_receipts::CreatedNote::from_input(
        &request.input,
        &space_rec.root_folder_id,
        info.prepared_blob.digest,
    );
    let idemp = create_note_identity(
        &ctx,
        &request.identity,
        &request.input,
        &space_rec.root_folder_id,
        info.prepared_blob.digest,
    );
    let (intent, fast_plan) = if store.is_sqlite_local()
        && !request.input.folder_page
        && !idemp.requires_standard_writer()
    {
        let (intent, plan) = crate::sqlite_fast::build_create_note_fast_intent(
            &space_rec.scope,
            space_rec.active_epoch,
            Some(idemp.clone()),
            ctx.auth().clone(),
            request.input,
            slug_fold,
            info,
            ticket,
        )?;
        (intent, Some(plan))
    } else {
        (
            build_create_note_intent(
                &space_rec.scope,
                space_rec.active_epoch,
                Some(idemp.clone()),
                ctx.auth().clone(),
                request.input,
                slug_fold,
                info,
                ticket,
            ),
            None,
        )
    };
    ctx.budget.remaining = deadline.remaining(&budget)?;
    match store
        .submit_write_command_until::<StoredCommittedNoteRevV1>(
            &ctx.budget,
            deadline.at,
            intent,
            fast_plan,
            None,
            Some(active_op_guard),
        )
        .await
    {
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
            if !idemp.has_confirmed_chat_step() =>
        {
            ctx.budget.remaining = deadline.remaining(&budget)?;
            let legacy = v1_receipts::LegacyNoteCommand::Create(created);
            let result = deadline
                .wait(&budget, || {
                    legacy.replay(store, &ctx, &request.identity, &idemp)
                })
                .await?;
            deadline.remaining(&budget)?;
            result
        }
        other => other.map(StoredCommittedNoteRevV1::into_committed),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_create_note_intent(
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    input: CreateNote,
    slug_fold: String,
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let staged_bytes = ticket.compressed_size;
    let source_note = input.note.clone();
    let confirmed = idemp
        .as_ref()
        .and_then(|id| id.confirmed_chat_step())
        .filter(|step| step.witness().effect_kind().is_create())
        .cloned();

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![source_note],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let parent_id = input
                    .parent
                    .clone()
                    .unwrap_or_else(|| item_ctx.root_folder_id.clone());
                if let Some(step) = &confirmed {
                    super::folder_paths::check_confirmed_note_destination_tx(
                        tx,
                        &live_space,
                        &auth,
                        step,
                        &parent_id,
                    )
                    .await?;
                }

                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &parent_id,
                    input.class,
                    None,
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;
                if input.folder_page {
                    let class = super::folders::folder_mutation_class(&auth, &scope_cl.space_id)?;
                    let (folder_facts, _) = build_resource_facts_tx(
                        tx,
                        &live_space.space,
                        &parent_id,
                        class,
                        None,
                        true,
                    )
                    .await?;
                    auth.authorize_direct_write(&folder_facts, &folder_facts)?;
                }

                if let Some(current) = super::common::authorized_collision_revision_tx(
                    tx,
                    &live_space.space,
                    &auth,
                    &input.note,
                )
                .await?
                {
                    return Err(DomainError::RevisionConflict {
                        current,
                        lineage: None,
                    }
                    .into());
                }

                if active_note_sibling_exists_tx(
                    tx,
                    &scope_cl.space_id,
                    &parent_id,
                    &slug_fold,
                    None,
                )
                .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope_cl.space_id.clone(),
                            parent: input.parent.clone(),
                            component: input.slug.clone(),
                        },
                    }
                    .into());
                }

                let total_seqs = if input.folder_page { 2 } else { 1 };
                let (_first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let vis_i64 = visibility_seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: input.note.as_str().to_owned(),
                        owner_rev_id: rev_id.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;

                let class_str = doc_class_to_db(input.class);
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO note_heads (
                                space_id, note_id, parent_folder_id, slug, slug_fold,
                                title, title_fold, doc_class, ability_id, head_rev_id,
                                content_blake3, byte_size, lifecycle_state, visibility_mask,
                                settlement_successor_id, created_seq, updated_seq,
                                created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active', 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(input.note.as_str())
                        .bind(parent_id.as_str())
                        .bind(&input.slug)
                        .bind(&slug_fold)
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(class_str)
                        .bind(rev_id.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_create_note_head", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO note_heads (
                                space_id, note_id, parent_folder_id, slug, slug_fold,
                                title, title_fold, doc_class, ability_id, head_rev_id,
                                content_blake3, byte_size, lifecycle_state, visibility_mask,
                                settlement_successor_id, created_seq, updated_seq,
                                created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, 'active', 0, NULL, $12, $13, $14, $15, $14, $15, $16)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(input.note.as_str())
                        .bind(parent_id.as_str())
                        .bind(&input.slug)
                        .bind(&slug_fold)
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(class_str)
                        .bind(rev_id.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_create_note_head", err.to_string())
                        })?;
                    }
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = if input.class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else {
                    evaluate_fields_with_schema(
                        info.raw_fields.as_ref(),
                        info.diagnostics.first(),
                        current_schema.as_ref().map(|s| &s.fields),
                    )
                };

                let run_opt = extract_agent_run_from_auth(&auth);
                let cover_event = if input.folder_page {
                    let cover_seq = item_ctx.alloc_next_seq()?;
                    super::folder_cover::assign(
                        tx,
                        &scope_cl,
                        &parent_id,
                        Some(&input.note),
                        cover_seq,
                        visibility_seq,
                        auth.principal(),
                        run_opt.as_ref(),
                        now_ts,
                    )
                    .await?
                } else {
                    None
                };
                let changed_fields = changed_note_fields(&EvaluatedFields::new(), &eval_fields);
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: input.folder_page,
                        note_id: input.note.clone(),
                        parent_folder_id: parent_id,
                        is_root_child: anc.is_root_child,
                        slug: input.slug,
                        slug_fold,
                        title: info.title,
                        doc_class: input.class,
                        ability_id: None,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: 0,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &rev_id,
                    "note",
                    input.note.as_str(),
                    seq,
                    visibility_seq,
                    None,
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, visibility_seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "create_note",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: input.note.clone(),
                            revision: rev_id.clone(),
                            rank_version: note_rank_version_digest(&rev_id, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: input.class,
                            changed_fields,
                        }],
                    },
                    vec![input.note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: input.note.clone(),
                        revision: rev_id.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let mut events = Vec::with_capacity(if cover_event.is_some() { 2 } else { 1 });
                events.push(BatchEventDraft {
                    space_seq: seq,
                    entity_type: "note".to_owned(),
                    entity_id: input.note.as_str().to_owned(),
                    op_kind: "create".to_owned(),
                    rev_id,
                    lifecycle: Lifecycle::Active,
                    doc_class: Some(input.class),
                });
                if let Some(event) = cover_event {
                    events.push(event);
                }

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "create_note".to_owned(),
                    events,
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![input.note],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

pub(crate) async fn edit_note_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<EditNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    use crate::sqlite_fast::EditBaseRead;

    let budget = ctx.budget.clone();
    let deadline = super::common::CommandDeadline::start(&budget, "edit_note");
    let active_op_guard = store.enter_write_op(&ctx.scope().space_id)?;
    super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    let idemp = edit_note_identity(
        &ctx,
        &request.identity,
        &request.input,
        &request.preconditions,
    );

    ctx.budget.remaining = deadline.remaining(&budget)?;
    let phase1 = if store.is_sqlite_local() && !idemp.requires_standard_writer() {
        deadline
            .prepare_read(&budget, || {
                crate::sqlite_fast::edit_note_phase1_sqlite_local(
                    store,
                    &ctx,
                    deadline,
                    &request.input.note,
                    &request.preconditions,
                    request.input.plan.base_content_hash,
                    &idemp,
                )
            })
            .await
    } else {
        let scope_p1 = ctx.scope().clone();
        let auth_p1 = ctx.auth().clone();
        let nid_p1 = request.input.note.clone();
        let prec_p1 = request.preconditions.clone();
        let expected_hash_p1 = request.input.plan.base_content_hash;
        let idemp_p1 = idemp.clone();
        let store_p1 = store.clone();

        store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    let srec = load_space_record(tx, &scope_p1.space_id).await?;
                    srec.scope.check(&scope_p1)?;

                    // Check idempotency receipt BEFORE reading live head so replayed edits work even if head moved on!
                    store_p1
                        .inner
                        .check_writer_epoch(&srec.scope.space_id, srec.active_epoch)?;
                    if let Some(existing) =
                        crate::writer::lookup_command_receipt_tx(tx, &scope_p1, &idemp_p1).await?
                    {
                        if existing.command_hash != idemp_p1.command_hash {
                            return Err(DomainError::IdempotencyKeyReused.into());
                        }
                        if existing.status == "completed" {
                            let decoded: StoredCommittedNoteRevV1 =
                                rmp_serde::from_slice(&existing.response_blob).map_err(|err| {
                                    internal_not_committed(
                                        "decode_replayed_receipt",
                                        err.to_string(),
                                    )
                                })?;
                            return Ok(crate::sqlite_fast::EditPhase1Read::Replayed(decoded));
                        }
                    }

                    if is_note_purge_fenced_tx(tx, &scope_p1.space_id, nid_p1.as_str()).await? {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let head = load_note_head_row_tx(tx, &scope_p1.space_id, &nid_p1).await?;
                    if head.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let (facts, _) = build_resource_facts_tx(
                        tx,
                        &srec.space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        true,
                    )
                    .await?;
                    auth_p1.authorize_direct_write(&facts, &facts)?;
                    if let Some(expected_rev) = &prec_p1.revision
                        && *expected_rev != head.head_rev_id
                    {
                        return Err(DomainError::RevisionConflict {
                            current: head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }
                    check_collab_preconditions_tx(tx, &scope_p1.space_id, &nid_p1, &prec_p1)
                        .await?;

                    let base_digest = head.content_digest.ok_or_else(|| {
                        internal_not_committed(
                            "active_note_missing_digest",
                            "active note lacks content_blake3",
                        )
                    })?;
                    if base_digest != expected_hash_p1 {
                        return Err(
                            DomainError::validation(ValidationReason::SourceMismatch).into()
                        );
                    }

                    let fast_local_read = store_p1
                        .try_prepare_local_blob_read_in_tx(tx, &srec.scope.space_id, base_digest)
                        .await?;

                    Ok(crate::sqlite_fast::EditPhase1Read::Proceed {
                        space_rec: srec,
                        base_head: head,
                        base_anc: None,
                        base_digest,
                        base_read: fast_local_read
                            .map_or(EditBaseRead::Lookup, EditBaseRead::Guarded),
                        phase1_receipt_checked_gen: None,
                    })
                })
            })
            .await
    };

    ctx.budget.remaining = deadline.remaining(&budget)?;
    let phase1 = match phase1 {
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
            if !idemp.has_confirmed_chat_step() =>
        {
            let legacy =
                v1_receipts::LegacyNoteCommand::Edit(&request.input, &request.preconditions);
            let result = deadline
                .wait(&budget, || {
                    legacy.replay(store, &ctx, &request.identity, &idemp)
                })
                .await?;
            deadline.remaining(&budget)?;
            return result;
        }
        other => other?,
    };

    let (space_rec, base_head, base_anc, base_digest, base_read, phase1_receipt_checked_gen) =
        match phase1 {
            crate::sqlite_fast::EditPhase1Read::Replayed(replayed) => {
                return Ok(replayed.into_committed());
            }
            crate::sqlite_fast::EditPhase1Read::Proceed {
                space_rec,
                base_head,
                base_anc,
                base_digest,
                base_read,
                phase1_receipt_checked_gen,
            } => (
                space_rec,
                base_head,
                base_anc,
                base_digest,
                base_read,
                phase1_receipt_checked_gen,
            ),
        };

    let raw_bytes = match base_read {
        EditBaseRead::Verified(bytes) => bytes,
        EditBaseRead::Guarded(plan) if base_head.byte_size <= 64 * 1024 => plan.read_verified()?,
        EditBaseRead::Guarded(plan) => {
            deadline
                .prepare(&budget, || plan.read_verified_async())
                .await?
        }
        EditBaseRead::Lookup => {
            deadline
                .prepare(&budget, || {
                    store.read_verified_blob_with_budget(
                        &space_rec.scope,
                        base_digest,
                        Some(&ctx.budget),
                    )
                })
                .await?
        }
    };
    deadline.remaining(&budget)?;
    let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
        internal_not_committed(
            "corrupt_note_utf8",
            "canonical note carrier is not valid UTF-8",
        )
    })?;

    let new_carrier = notarium_syntax::patch::apply(&base_carrier, &request.input.plan)?;
    let preparsed_hdr = if base_head.doc_class != DocClass::EncryptedNote {
        enforce_protected_frontmatter_unchanged_with_header(
            &base_carrier,
            &new_carrier,
            base_head.doc_class,
        )?
    } else {
        None
    };

    let mut reservation_opt = None;
    if let Some(interceptor) = store.inner.collab_interceptor.get()
        && base_head.doc_class == DocClass::UserDoc
    {
        if let Some(res) = interceptor.try_closed_room_reservation(
            ctx.scope(),
            &request.input.note,
            &request.identity,
        ) {
            reservation_opt = Some(CarrierRoomWrite::Reserved(res));
        } else {
            let (body_plan, header_mut) = build_collab_edit_payload(
                &request.input.note,
                &base_carrier,
                &new_carrier,
                &request.input.plan,
                base_head.doc_class,
                &base_head.head_rev_id,
            )?;
            ctx.budget.remaining = deadline.remaining(&budget)?;
            let mut dispatched = false;
            let response = deadline
                .wait(&budget, || async {
                    dispatched = true;
                    interceptor
                        .intercept(InterceptedMutation {
                            context: ctx.clone(),
                            identity: request.identity.clone(),
                            preconditions: request.preconditions.clone(),
                            payload: InterceptedPayload::EditNote {
                                note: request.input.note.clone(),
                                plan: request.input.plan.clone(),
                                body: body_plan,
                                header: header_mut,
                            },
                        })
                        .await
                })
                .await;
            let unknown = || {
                crate::codec::unknown_commit_outcome(
                    "edit_room_outcome_unknown",
                    "the room may have applied the note edit",
                )
            };
            match response.map_err(|err| if dispatched { unknown() } else { err })?? {
                InterceptionResult::Applied(outcome) => match *outcome {
                    InterceptedOutcome::NoteRevision(committed)
                        if committed.value.note == request.input.note
                            && committed.receipt.scope() == ctx.scope() =>
                    {
                        return Ok(committed);
                    }
                    _ => return Err(missing_applied_outcome()),
                },
                InterceptionResult::Conflict(err) => {
                    // A concurrent attempt can commit after phase one and before the room
                    // checks this request's original body identity.
                    if matches!(err, DomainError::RevisionConflict { .. })
                        && let Some(replayed) = replay_command::<StoredCommittedNoteRevV1>(
                            store, &ctx, deadline, &idemp,
                        )
                        .await?
                    {
                        return Ok(replayed.into_committed());
                    }
                    return Err(err.into());
                }
                InterceptionResult::ClosedRoomReservation(res) => {
                    reservation_opt = Some(CarrierRoomWrite::Reserved(res));
                }
            }
        }
    }

    let info = analyze_and_prepare_carrier_opt_preparsed(
        &new_carrier,
        base_head.doc_class,
        &request.input.note,
        &base_head.slug,
        store.blob_codec(),
        preparsed_hdr,
    )?;
    let ticket = deadline
        .wait(&budget, || {
            store.stage_blob_for_batch_prechecked(
                &space_rec.scope,
                space_rec.active_epoch,
                &info.prepared_blob,
            )
        })
        .await??;

    if store.is_sqlite_local()
        && !idemp.requires_standard_writer()
        && !matches!(reservation_opt, Some(CarrierRoomWrite::Accepted(_)))
    {
        let closed_reservation = match reservation_opt {
            Some(CarrierRoomWrite::Reserved(res)) => Some(res),
            _ => None,
        };
        let phase1_cached = base_anc.map(|anc| (base_head.clone(), anc));
        let (intent, fast_plan) = crate::sqlite_fast::build_carrier_replacement_fast_intent(
            store,
            &space_rec.scope,
            space_rec.active_epoch,
            Some(idemp),
            "edit_note",
            ctx.auth().clone(),
            request.identity,
            request.preconditions,
            request.input.note,
            base_head.head_rev_id,
            None,
            info,
            ticket,
            closed_reservation,
            phase1_receipt_checked_gen,
            phase1_cached,
        )?;
        ctx.budget.remaining = deadline.remaining(&budget)?;
        let stored: StoredCommittedNoteRevV1 = store
            .submit_write_command_until(
                &ctx.budget,
                deadline.at,
                intent,
                Some(fast_plan),
                None,
                Some(active_op_guard),
            )
            .await?;
        return Ok(stored.into_committed());
    }

    let intent = build_carrier_replacement_intent(
        store,
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        "edit_note",
        ctx.auth().clone(),
        request.identity,
        request.preconditions,
        request.input.note,
        base_head.head_rev_id,
        CarrierReplacement::Edit,
        info,
        ticket,
        reservation_opt,
    );

    ctx.budget.remaining = deadline.remaining(&budget)?;
    let stored: StoredCommittedNoteRevV1 = store
        .submit_write_command_until(
            &ctx.budget,
            deadline.at,
            intent,
            None,
            None,
            Some(active_op_guard),
        )
        .await?;
    Ok(stored.into_committed())
}

pub(crate) enum CarrierRoomWrite {
    Reserved(notarium_core::ports::ClosedRoomReservation),
    Accepted(crate::peers::RoomCarrierTransition),
}

// Room receipts preserve the grant that admitted the mutation alongside its normal
// typed outcome. Purge can erase this detail and retain the ordinary sanitized reply.
pub(super) fn room_receipt_detail<T: serde::Serialize>(
    grant: Option<&notarium_core::ids::GrantId>,
    outcome: &T,
) -> Result<Option<Vec<u8>>, PortError> {
    #[derive(serde::Serialize)]
    struct GrantedOutcome<'a, T> {
        #[serde(flatten)]
        outcome: &'a T,
        originating_grant: &'a notarium_core::ids::GrantId,
    }
    grant
        .map(|originating_grant| {
            CanonicalStore::encode_command_outcome(&GrantedOutcome {
                outcome,
                originating_grant,
            })
        })
        .transpose()
}

enum CarrierRoomCommit {
    Direct { has_closed_session: bool },
    Accepted(crate::peers::RoomCarrierTransition),
}

async fn prepare_carrier_room_tx(
    tx: &mut BackendConn<'_>,
    item_ctx: &mut crate::writer::ItemExecCtx,
    fences: &crate::RoomFenceTable,
    room: Option<CarrierRoomWrite>,
    identity: &CommandIdentity,
    note: &NoteId,
) -> Result<CarrierRoomCommit, PortError> {
    let scope = &item_ctx.scope;
    let state = match room {
        Some(CarrierRoomWrite::Accepted(transition)) => {
            return Ok(CarrierRoomCommit::Accepted(transition));
        }
        Some(CarrierRoomWrite::Reserved(reservation)) => {
            let guard = fences
                .consume_reservation(scope, note, reservation, identity)
                .await?;
            item_ctx.retain_until_batch_commit(guard);
            crate::domain::common::durable_note_room_state_tx(tx, &item_ctx.scope.space_id, note)
                .await?
        }
        None => {
            crate::domain::common::check_note_room_direct_write_tx(tx, fences, scope, note).await?
        }
    };
    Ok(CarrierRoomCommit::Direct {
        has_closed_session: state.require_writable()?,
    })
}

impl CarrierRoomCommit {
    #[allow(clippy::too_many_arguments)]
    async fn commit(
        self,
        tx: &mut BackendConn<'_>,
        item_ctx: &mut crate::writer::ItemExecCtx,
        store: &CanonicalStore,
        note: &NoteId,
        base: &RevisionId,
        revision: &RevisionId,
        seq: SpaceSeq,
    ) -> Result<(), PortError> {
        match self {
            Self::Accepted(transition) => {
                transition
                    .commit_revision(tx, item_ctx, store, note, base, revision, seq)
                    .await?;
            }
            Self::Direct {
                has_closed_session: true,
            } => {
                crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
                    tx,
                    &item_ctx.scope.space_id,
                    note,
                    revision,
                    seq,
                )
                .await?;
            }
            Self::Direct {
                has_closed_session: false,
            } => (),
        }
        Ok(())
    }
}

pub(crate) enum CarrierReplacement {
    Edit,
    Rename(String, String),
    RestartMemory,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_carrier_replacement_intent(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    command_kind: &'static str,
    auth: notarium_core::auth::EngineAuthContext,
    identity: CommandIdentity,
    preconditions: Preconditions,
    note_id: NoteId,
    expected_base_rev: RevisionId,
    operation: CarrierReplacement,
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
    reservation_opt: Option<CarrierRoomWrite>,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let staged_bytes = ticket.compressed_size;
    let room_store = store.clone();

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![note_id.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note_id).await?;
                let restarting = matches!(operation, CarrierReplacement::RestartMemory);
                let expected_lifecycle = if restarting {
                    Lifecycle::Trashed
                } else {
                    Lifecycle::Active
                };
                if head.lifecycle != expected_lifecycle
                    || (restarting && head.doc_class != DocClass::AgentMemory)
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &item_ctx.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;

                let room = prepare_carrier_room_tx(
                    tx,
                    item_ctx,
                    &room_store.inner.room_fences,
                    reservation_opt,
                    &identity,
                    &note_id,
                )
                .await?;
                if head.head_rev_id != expected_base_rev {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &note_id, &preconditions)
                    .await?;

                let (final_slug, final_slug_fold) = match &operation {
                    CarrierReplacement::Rename(slug, folded) => {
                        super::folder_cover::validate_slug_change(
                            &head.slug_fold,
                            folded,
                            slug,
                            anc.cover_note.as_ref() == Some(&note_id),
                        )?;
                        (slug.clone(), folded.clone())
                    }
                    _ => (head.slug.clone(), head.slug_fold.clone()),
                };
                if (restarting || final_slug_fold != head.slug_fold)
                    && active_note_sibling_exists_tx(
                        tx,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                        &final_slug_fold,
                        Some(&note_id),
                    )
                    .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope_cl.space_id.clone(),
                            parent: (head.parent_folder_id != item_ctx.root_folder_id)
                                .then_some(head.parent_folder_id.clone()),
                            component: final_slug,
                        },
                    }
                    .into());
                }

                if let Some(ab_id) = &head.ability_id
                    && final_slug_fold != head.slug_fold
                {
                    update_ability_package_slug_tx(
                        tx,
                        &scope_cl.space_id,
                        ab_id,
                        &final_slug_fold,
                        &final_slug,
                        (head.parent_folder_id != item_ctx.root_folder_id)
                            .then_some(head.parent_folder_id.clone()),
                        anc.project.as_ref(),
                    )
                    .await?;
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: note_id.as_str().to_owned(),
                        owner_rev_id: new_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;
                let room_grant =
                    matches!(&room, CarrierRoomCommit::Accepted(_)).then(|| auth.grant().clone());
                room.commit(
                    tx,
                    item_ctx,
                    &room_store,
                    &note_id,
                    &head.head_rev_id,
                    &new_rev,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET lifecycle_state = 'active', slug = ?, slug_fold = ?, title = ?, title_fold = ?,
                                 head_rev_id = ?, content_blake3 = ?, byte_size = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(&final_slug)
                        .bind(&final_slug_fold)
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_update_note_head", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET lifecycle_state = 'active', slug = $1, slug_fold = $2, title = $3, title_fold = $4,
                                 head_rev_id = $5, content_blake3 = $6, byte_size = $7,
                                 updated_seq = $8, updated_at_sec = $9, updated_at_nsec = $10, last_actor_id = $11
                             WHERE space_id = $12 AND note_id = $13",
                        )
                        .bind(&final_slug)
                        .bind(&final_slug_fold)
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_update_note_head", err.to_string())
                        })?;
                    }
                }

                if final_slug_fold != head.slug_fold || info.title_fold != head.title_fold {
                    insert_note_alias_tx(
                        tx,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                        &head.slug_fold,
                        &head.title_fold,
                        &note_id,
                        seq,
                    )
                    .await?;
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = if head.doc_class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else {
                    evaluate_fields_with_schema(
                        info.raw_fields.as_ref(),
                        info.diagnostics.first(),
                        current_schema.as_ref().map(|s| &s.fields),
                    )
                };

                let run_opt = extract_agent_run_from_auth(&auth);
                let changed_fields =
                    changed_revision_fields_tx(tx, &scope_cl, &head.head_rev_id, &eval_fields)
                        .await?;
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: anc.cover_note.as_ref() == Some(&note_id),
                        note_id: note_id.clone(),
                        parent_folder_id: head.parent_folder_id,
                        is_root_child: anc.is_root_child,
                        slug: final_slug,
                        slug_fold: final_slug_fold,
                        title: info.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    note_id.as_str(),
                    seq,
                    seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let op_kind = match operation {
                    CarrierReplacement::Rename(..) => "rename",
                    CarrierReplacement::Edit => "edit",
                    CarrierReplacement::RestartMemory => "restore",
                };

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    command_kind,
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: note_id.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        }],
                    },
                    vec![note_id.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: note_id.clone(),
                        revision: new_rev.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: command_kind.to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: note_id.as_str().to_owned(),
                        op_kind: op_kind.to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: room_receipt_detail(room_grant.as_ref(), &stored_resp)?,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![note_id],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

pub(crate) async fn delete_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<DeleteNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    if ctx.confirmed_chat_step().is_some() && request.input.disposition != DeleteDisposition::Trash
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if request.input.disposition == DeleteDisposition::Purge {
        return crate::domain::purge::purge_note_impl(store, ctx, request).await;
    }
    delete_impl(
        store,
        ctx,
        Mutation {
            identity: request.identity,
            preconditions: request.preconditions,
            input: DeleteTarget::Note(request.input),
        },
    )
    .await
}

pub(super) async fn trash_ability_package_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<notarium_core::ports::TrashAbilityPackage>,
) -> Result<Committed<NoteRevision>, PortError> {
    ctx.auth().authorize_ability_mutation()?;
    delete_impl(
        store,
        ctx,
        Mutation {
            identity: request.identity,
            preconditions: request.preconditions,
            input: DeleteTarget::Ability(request.input),
        },
    )
    .await
}

enum DeleteTarget {
    Note(DeleteNote),
    Ability(notarium_core::ports::TrashAbilityPackage),
}

impl DeleteTarget {
    fn note(&self) -> &NoteId {
        match self {
            Self::Note(request) => &request.note,
            Self::Ability(request) => &request.entrypoint,
        }
    }

    fn disposition(&self) -> DeleteDisposition {
        match self {
            Self::Note(request) => request.disposition,
            Self::Ability(_) => DeleteDisposition::Trash,
        }
    }
}

async fn delete_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<DeleteTarget>,
) -> Result<Committed<NoteRevision>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "delete_note");

    if matches!(
        &request.input,
        DeleteTarget::Note(note) if note.disposition == DeleteDisposition::Trash
    ) {
        super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    } else {
        validate_mutation_identity(&ctx, &request.identity)?;
    }
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let disp_tag = match request.input.disposition() {
        DeleteDisposition::Trash => "trash_note",
        DeleteDisposition::Restore => "restore_note",
        DeleteDisposition::Purge => unreachable!(),
    };
    let note = request.input.note();
    let fp = match &request.input {
        DeleteTarget::Note(_) => format!("{disp_tag}={note}"),
        DeleteTarget::Ability(guard) => format!(
            "trash_ability={note}:{}:{}",
            guard.ability, guard.package_revision
        ),
    };
    let idemp = derive_command_identity_spec(&ctx, &request.identity, disp_tag, fp.as_bytes())
        .with_preconditions(&request.preconditions, "note", note.as_str())
        .with_confirmed_chat_step(&ctx, disp_tag)
        .for_note(ctx.auth(), note);

    let intent = build_trash_or_restore_intent(
        store,
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        request.input,
    );

    let stored: StoredCommittedNoteRevV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

/// A relocation or lifecycle revision keeps the carrier bytes and collaborative lineage.
async fn advance_collab_metadata_revision_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    previous: &RevisionId,
    next: &RevisionId,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "UPDATE collab_sessions SET carrier_rev_id = ?, updated_seq = ?
             WHERE space_id = ? AND note_id = ? AND carrier_rev_id = ?",
        )
        .bind(next.as_str())
        .bind(seq.get() as i64)
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .bind(previous.as_str())
        .execute(&mut **conn)
        .await
        .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(
            "UPDATE collab_sessions SET carrier_rev_id = $1, updated_seq = $2
             WHERE space_id = $3 AND note_id = $4 AND carrier_rev_id = $5",
        )
        .bind(next.as_str())
        .bind(seq.get() as i64)
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .bind(previous.as_str())
        .execute(&mut **conn)
        .await
        .map(|_| ()),
    }
    .map_err(|err| internal_not_committed("advance_collab_metadata_revision", err.to_string()))
}

fn build_trash_or_restore_intent(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    input: DeleteTarget,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let note_id = input.note().clone();

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![note_id.clone()],
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note_id).await?;
                if head.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let require_active_folders = input.disposition() == DeleteDisposition::Restore;
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    require_active_folders,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;
                if let DeleteTarget::Ability(request) = &input {
                    if head.doc_class != DocClass::Skill
                        || head.ability_id.as_ref() != Some(&request.ability)
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    super::packages::check_package_trash_tx(tx, &scope_cl, request).await?;
                }

                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &note_id, &preconditions)
                    .await?;

                let (target_lc, op_kind, cmd_kind) = match input.disposition() {
                    DeleteDisposition::Trash => {
                        if head.lifecycle != Lifecycle::Active {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidState).into()
                            );
                        }
                        if is_note_room_active_tx(tx, &room_fences, &scope_cl, &note_id).await? {
                            return Err(unavailable_retryable(
                                "trash_blocked_by_active_room",
                                "cannot trash note while live collaborative room is active",
                                std::time::Duration::from_millis(50),
                            ));
                        }
                        (Lifecycle::Trashed, "trash", "trash_note")
                    }
                    DeleteDisposition::Restore => {
                        if head.lifecycle != Lifecycle::Trashed {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidState).into()
                            );
                        }
                        if active_note_sibling_exists_tx(
                            tx,
                            &scope_cl.space_id,
                            &head.parent_folder_id,
                            &head.slug_fold,
                            Some(&note_id),
                        )
                        .await?
                        {
                            let report_parent = (head.parent_folder_id != item_ctx.root_folder_id)
                                .then_some(head.parent_folder_id.clone());
                            return Err(DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: report_parent,
                                    component: head.slug.clone(),
                                },
                            }
                            .into());
                        }
                        if let Some(ability) = &head.ability_id
                            && super::packages::active_ability_slug_conflict_tx(
                                tx,
                                &scope_cl.space_id,
                                &head.slug_fold,
                                ability,
                                anc.project.as_ref(),
                            )
                            .await?
                        {
                            return Err(DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: (head.parent_folder_id != item_ctx.root_folder_id)
                                        .then_some(head.parent_folder_id.clone()),
                                    component: head.slug.clone(),
                                },
                            }
                            .into());
                        }
                        (Lifecycle::Active, "restore", "restore_note")
                    }
                    DeleteDisposition::Purge => unreachable!(),
                };

                let digest = head.content_digest.ok_or_else(|| {
                    internal_not_committed("note_missing_digest", "non-purged note lacks digest")
                })?;

                if is_note_purge_fenced_tx(tx, &scope_cl.space_id, note_id.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let bytes = load_revision_metadata_tx(tx, &scope_cl, &head.head_rev_id).await?;
                let prev = match RevisionMetadataEnvelope::decode(&bytes)?.payload {
                    RevisionMetadataPayload::Note(meta) if meta.note_id == note_id => meta,
                    _ => {
                        return Err(internal_not_committed(
                            "invalid_note_head",
                            "current revision does not identify the note",
                        ));
                    }
                };

                let was_bound = anc.cover_note.as_ref() == Some(&note_id);
                let folder_page = was_bound || prev.folder_page;
                let cover_target = if was_bound || (folder_page && target_lc == Lifecycle::Active) {
                    let target = (target_lc == Lifecycle::Active).then_some(&note_id);
                    (anc.cover_note.as_ref() != target).then_some(target)
                } else {
                    None
                };
                let total_seqs = if cover_target.is_some() { 2 } else { 1 };
                let (_first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let vis_i64 = visibility_seq.get() as i64;
                let lc_str = lifecycle_to_db(target_lc);

                bind_existing_active_blob_ref_tx(
                    tx,
                    &scope_cl.space_id,
                    BlobOwnerKind::NoteRevision,
                    note_id.as_str(),
                    new_rev.as_str(),
                    "carrier",
                    digest,
                    seq,
                )
                .await?;

                advance_collab_metadata_revision_tx(
                    tx,
                    &scope_cl.space_id,
                    &note_id,
                    &head.head_rev_id,
                    &new_rev,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET lifecycle_state = ?, head_rev_id = ?, updated_seq = ?,
                                 updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(lc_str)
                        .bind(new_rev.as_str())
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_trash_restore_note", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET lifecycle_state = $1, head_rev_id = $2, updated_seq = $3,
                                 updated_at_sec = $4, updated_at_nsec = $5, last_actor_id = $6
                             WHERE space_id = $7 AND note_id = $8",
                        )
                        .bind(lc_str)
                        .bind(new_rev.as_str())
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_trash_restore_note", err.to_string())
                        })?;
                    }
                }

                if let Some(ab_id) = &head.ability_id {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE ability_packages
                                 SET lifecycle_state = ?, updated_seq = ?
                                 WHERE space_id = ? AND ability_id = ?",
                            )
                            .bind(lc_str)
                            .bind(vis_i64)
                            .bind(scope_cl.space_id.as_str())
                            .bind(ab_id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_sync_ability_lc", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE ability_packages
                                 SET lifecycle_state = $1, updated_seq = $2
                                 WHERE space_id = $3 AND ability_id = $4",
                            )
                            .bind(lc_str)
                            .bind(vis_i64)
                            .bind(scope_cl.space_id.as_str())
                            .bind(ab_id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_sync_ability_lc", err.to_string())
                            })?;
                        }
                    }
                }

                let run_opt = extract_agent_run_from_auth(&auth);
                let cover_event = if let Some(cover) = cover_target {
                    let cover_seq = item_ctx.alloc_next_seq()?;
                    super::folder_cover::assign(
                        tx,
                        &scope_cl,
                        &head.parent_folder_id,
                        cover,
                        cover_seq,
                        visibility_seq,
                        auth.principal(),
                        run_opt.as_ref(),
                        now_ts,
                    )
                    .await?
                } else {
                    None
                };
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page,
                        note_id: note_id.clone(),
                        parent_folder_id: head.parent_folder_id,
                        is_root_child: anc.is_root_child,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: head.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: target_lc,
                        visibility_mask: head.visibility_mask,
                        byte_size: head.byte_size,
                        content_digest: Some(digest),
                        schema_revision: prev.schema_revision,
                        raw_fields: prev.raw_fields,
                        evaluated_fields: prev.evaluated_fields,
                        diagnostics: prev.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    note_id.as_str(),
                    seq,
                    visibility_seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, visibility_seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    cmd_kind,
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: note_id.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: target_lc,
                            doc_class: head.doc_class,
                            changed_fields: BTreeMap::new(),
                        }],
                    },
                    vec![note_id.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: note_id.clone(),
                        revision: new_rev.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let mut events = Vec::with_capacity(if cover_event.is_some() { 2 } else { 1 });
                events.push(BatchEventDraft {
                    space_seq: seq,
                    entity_type: "note".to_owned(),
                    entity_id: note_id.as_str().to_owned(),
                    op_kind: op_kind.to_owned(),
                    rev_id: new_rev,
                    lifecycle: target_lc,
                    doc_class: Some(head.doc_class),
                });
                if let Some(event) = cover_event {
                    events.push(event);
                }

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: cmd_kind.to_owned(),
                    events,
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![note_id],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

fn move_note_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
    input: &MoveNote,
    preconditions: &Preconditions,
) -> crate::writer::CommandIdentitySpec {
    let fp = format!(
        "note={}\0parent={}\0slug={}",
        input.note.as_str(),
        input
            .parent
            .as_ref()
            .map(|p| p.as_str())
            .unwrap_or("<root>"),
        input.slug
    );
    derive_command_identity_spec(ctx, identity, "move_note", fp.as_bytes())
        .with_preconditions(preconditions, "note", input.note.as_str())
        .with_confirmed_chat_step(ctx, "move_note")
        .for_move(ctx.auth(), &input.note, input.parent.as_ref())
}

async fn check_move_pin(
    interceptor: &dyn notarium_core::ports::LiveCollabInterceptor,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<(), PortError> {
    if let FilenamePin::Pinned { .. } = interceptor.filename_pin(ctx.clone(), note.clone()).await? {
        return Err(unavailable_retryable(
            "move_note_blocked_by_filename_pin",
            "cannot move note while live room holds a filename pin",
            std::time::Duration::from_millis(50),
        ));
    }
    Ok(())
}

pub(crate) async fn move_note_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<MoveNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "move_note");
    super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    if let Some(step) = ctx.confirmed_chat_step() {
        let source = step
            .destination()
            .and_then(|destination| destination.move_source.as_ref());
        if !source.is_some_and(|(note, revision)| {
            note == &request.input.note && request.preconditions.revision.as_ref() == Some(revision)
        }) {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
    }
    let new_slug_fold = normalize_slug_key(&request.input.slug)?;

    let idemp = move_note_identity(
        &ctx,
        &request.identity,
        &request.input,
        &request.preconditions,
    );

    let (space_rec, pin) = if let Some(interceptor) = store.inner.collab_interceptor.get() {
        if let Some(replayed) = deadline
            .prepare(&ctx.budget, || {
                try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
                    store,
                    ctx.scope(),
                    &idemp,
                    Some(&ctx.budget),
                )
            })
            .await?
        {
            return Ok(replayed.into_committed());
        }
        let (space, _) = deadline
            .prepare(&ctx.budget, || {
                read_active_note_for_mutation(
                    store,
                    &ctx,
                    &request.input.note,
                    &request.preconditions,
                    NoteMutationAccess::Move(request.input.parent.clone()),
                )
            })
            .await?;
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        let pin = deadline
            .prepare(&ctx.budget, || {
                prepare_unpinned_move(store, interceptor.as_ref(), &ctx, &request.input.note)
            })
            .await?;
        (space, pin)
    } else {
        let space = deadline
            .prepare(&ctx.budget, || {
                store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
            })
            .await?;
        space.scope.check(ctx.scope())?;
        (space, MovePin::Checked)
    };

    let intent = build_move_note_intent(
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        MetadataChange::Move(request.input),
        new_slug_fold,
        Ok(pin),
    );

    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let stored: StoredCommittedNoteRevV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

// A move can follow the creation or restoration of the same note in this batch.
enum MovePin {
    Checked,
    NoActiveSource(Arc<super::RoomFenceTable>),
    UnpinnedAt {
        fences: Arc<super::RoomFenceTable>,
        observed_active_lease: Option<LeaseEpoch>,
    },
    PinnedAt {
        fences: Arc<super::RoomFenceTable>,
        filename: String,
        lease: LeaseEpoch,
    },
}

async fn prepare_unpinned_move(
    store: &CanonicalStore,
    interceptor: &dyn notarium_core::ports::LiveCollabInterceptor,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<MovePin, PortError> {
    let fences = store.inner.room_fences.clone();
    let observed_active_lease = fences.observed_active_lease(ctx.scope(), note).await;
    check_move_pin(interceptor, ctx, note).await?;
    Ok(MovePin::UnpinnedAt {
        fences,
        observed_active_lease,
    })
}

async fn lock_move_pin_tx(
    tx: &mut BackendConn<'_>,
    scope: &notarium_core::model::HistoryScope,
    head: &NoteHeadRow,
    pin: MovePin,
) -> Result<Option<tokio::sync::OwnedMutexGuard<notarium_core::ports::RoomFenceState>>, PortError> {
    let (fences, expected_lease, expected_slug) = match pin {
        MovePin::Checked => return Ok(None),
        MovePin::NoActiveSource(fences) => {
            if is_note_room_active_tx(tx, &fences, scope, &head.note_id).await? {
                return Err(move_pin_changed());
            }
            return Ok(None);
        }
        MovePin::UnpinnedAt {
            fences,
            observed_active_lease,
        } => (fences, observed_active_lease, None),
        MovePin::PinnedAt {
            fences,
            filename,
            lease,
        } => (fences, Some(lease), Some(filename)),
    };
    // Retain the per-note fence through the mutation. Reading the durable lease
    // inside the Space writer transaction covers takeover by another process.
    let guard = fences.lock_for_write(scope, &head.note_id)?;
    let active_lease = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar::<_, i64>(
                "SELECT lease_epoch FROM collab_sessions
             WHERE space_id = ? AND note_id = ? AND room_state = 'active'",
            )
            .bind(scope.space_id.as_str())
            .bind(head.note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar::<_, i64>(
                "SELECT lease_epoch FROM collab_sessions
             WHERE space_id = $1 AND note_id = $2 AND room_state = 'active'",
            )
            .bind(scope.space_id.as_str())
            .bind(head.note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
        }
    }
    .map_err(|error| internal_not_committed("move_room_pin_lease", error.to_string()))?;
    if active_lease.is_some_and(|lease| {
        expected_lease.is_none_or(|exp| u64::try_from(lease).ok() != Some(exp.get()))
            || expected_slug.is_some_and(|filename| filename != head.slug)
    }) {
        return Err(move_pin_changed());
    }
    Ok(Some(guard))
}

fn move_pin_changed() -> PortError {
    unavailable_retryable(
        "move_note_pin_changed",
        "retry the move after checking the newly active room",
        std::time::Duration::from_millis(50),
    )
}

async fn prepare_batch_move_pin(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    input: &MoveNote,
) -> Result<MovePin, PortError> {
    let Some(interceptor) = store.inner.collab_interceptor.get() else {
        return Ok(MovePin::Checked);
    };
    match read_active_note_for_mutation(
        store,
        ctx,
        &input.note,
        &Preconditions::default(),
        NoteMutationAccess::Move(input.parent.clone()),
    )
    .await
    {
        Ok(_) => prepare_unpinned_move(store, interceptor.as_ref(), ctx, &input.note).await,
        Err(PortError::Domain(DomainError::ResourceNotFound)) => {
            Ok(MovePin::NoActiveSource(store.inner.room_fences.clone()))
        }
        Err(error) => Err(error),
    }
}

enum MetadataChange {
    Move(MoveNote),
    Rename(RenameNote),
}

#[allow(clippy::too_many_arguments)]
fn build_move_note_intent(
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    change: MetadataChange,
    new_slug_fold: String,
    pin: Result<MovePin, PortError>,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let confirmed = if matches!(&change, MetadataChange::Move(_)) {
        idemp
            .as_ref()
            .and_then(|id| id.confirmed_chat_step().cloned())
    } else {
        None
    };
    let note_id = match &change {
        MetadataChange::Move(mv) => &mv.note,
        MetadataChange::Rename(rename) => &rename.note,
    }
    .clone();

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![note_id.clone()],
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note_id).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let input = match change {
                    MetadataChange::Move(mv) => mv,
                    MetadataChange::Rename(rename) => MoveNote {
                        note: rename.note,
                        parent: (head.parent_folder_id != item_ctx.root_folder_id)
                            .then(|| head.parent_folder_id.clone()),
                        slug: rename.slug,
                    },
                };
                let dest_parent = input
                    .parent
                    .clone()
                    .unwrap_or_else(|| item_ctx.root_folder_id.clone());

                let after_anc =
                    authorize_note_placement_tx(tx, &live_space, &auth, &head, &dest_parent)
                        .await?;

                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if let Some(step) = &confirmed {
                    super::folder_paths::check_confirmed_note_destination_tx(
                        tx,
                        &live_space,
                        &auth,
                        step,
                        &dest_parent,
                    )
                    .await?;
                }
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &note_id, &preconditions)
                    .await?;

                let _pin_guard = lock_move_pin_tx(tx, &scope_cl, &head, pin?).await?;

                let folder_page = if head.slug_fold == super::folder_cover::SLUG {
                    crate::runtime::load_folder_head_row(
                        tx,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                    )
                    .await?
                    .cover_note_id
                    .as_ref()
                        == Some(&note_id)
                } else {
                    false
                };
                super::folder_cover::validate_slug_change(
                    &head.slug_fold,
                    &new_slug_fold,
                    &input.slug,
                    folder_page,
                )?;

                if (dest_parent != head.parent_folder_id || new_slug_fold != head.slug_fold)
                    && active_note_sibling_exists_tx(
                        tx,
                        &scope_cl.space_id,
                        &dest_parent,
                        &new_slug_fold,
                        Some(&note_id),
                    )
                    .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope_cl.space_id.clone(),
                            parent: input.parent.clone(),
                            component: input.slug.clone(),
                        },
                    }
                    .into());
                }

                if let Some(ab_id) = &head.ability_id
                    && (new_slug_fold != head.slug_fold || dest_parent != head.parent_folder_id)
                {
                    update_ability_package_slug_tx(
                        tx,
                        &scope_cl.space_id,
                        ab_id,
                        &new_slug_fold,
                        &input.slug,
                        input.parent.clone(),
                        after_anc.project.as_ref(),
                    )
                    .await?;
                }

                let digest = head.content_digest.ok_or_else(|| {
                    internal_not_committed("note_missing_digest", "active note lacks digest")
                })?;
                let prev_rev = read_immutable_revision_tx(
                    tx,
                    &scope_cl,
                    "note",
                    note_id.as_str(),
                    head.updated_seq,
                )
                .await?;
                let (prev_raw_fields, prev_eval_fields, prev_diags, prev_schema_rev) =
                    match prev_rev.map(|r| r.metadata.payload) {
                        Some(RevisionMetadataPayload::Note(nm)) => (
                            nm.raw_fields,
                            nm.evaluated_fields,
                            nm.diagnostics,
                            nm.schema_revision,
                        ),
                        _ => (None, BTreeMap::new(), Vec::new(), None),
                    };

                let final_title = if head.doc_class == DocClass::EncryptedNote {
                    input.slug.clone()
                } else {
                    head.title.clone()
                };
                let final_title_fold = normalize_title_key(&final_title);

                let move_cover = folder_page && dest_parent != head.parent_folder_id;
                let dest_cover_changes =
                    move_cover && after_anc.cover_note.as_ref() != Some(&note_id);
                let total_seqs = 1 + u64::from(move_cover) + u64::from(dest_cover_changes);
                let (_first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let vis_i64 = visibility_seq.get() as i64;

                bind_existing_active_blob_ref_tx(
                    tx,
                    &scope_cl.space_id,
                    BlobOwnerKind::NoteRevision,
                    note_id.as_str(),
                    new_rev.as_str(),
                    "carrier",
                    digest,
                    seq,
                )
                .await?;

                advance_collab_metadata_revision_tx(
                    tx,
                    &scope_cl.space_id,
                    &note_id,
                    &head.head_rev_id,
                    &new_rev,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET parent_folder_id = ?, slug = ?, slug_fold = ?,
                                 title = ?, title_fold = ?, head_rev_id = ?,
                                 updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(dest_parent.as_str())
                        .bind(&input.slug)
                        .bind(&new_slug_fold)
                        .bind(&final_title)
                        .bind(&final_title_fold)
                        .bind(new_rev.as_str())
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_move_note", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET parent_folder_id = $1, slug = $2, slug_fold = $3,
                                 title = $4, title_fold = $5, head_rev_id = $6,
                                 updated_seq = $7, updated_at_sec = $8, updated_at_nsec = $9, last_actor_id = $10
                             WHERE space_id = $11 AND note_id = $12",
                        )
                        .bind(dest_parent.as_str())
                        .bind(&input.slug)
                        .bind(&new_slug_fold)
                        .bind(&final_title)
                        .bind(&final_title_fold)
                        .bind(new_rev.as_str())
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_move_note", err.to_string()))?;
                    }
                }

                if dest_parent != head.parent_folder_id || new_slug_fold != head.slug_fold {
                    insert_note_alias_tx(
                        tx,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                        &head.slug_fold,
                        &head.title_fold,
                        &note_id,
                        seq,
                    )
                    .await?;
                }

                let run_opt = extract_agent_run_from_auth(&auth);
                let mut cover_events = Vec::new();
                if move_cover {
                    let src_seq = item_ctx.alloc_next_seq()?;
                    if let Some(event) = super::folder_cover::assign(
                        tx,
                        &scope_cl,
                        &head.parent_folder_id,
                        None,
                        src_seq,
                        visibility_seq,
                        auth.principal(),
                        run_opt.as_ref(),
                        now_ts,
                    )
                    .await?
                    {
                        cover_events.push(event);
                    }
                    if dest_cover_changes {
                        let dst_seq = item_ctx.alloc_next_seq()?;
                        if let Some(event) = super::folder_cover::assign(
                            tx,
                            &scope_cl,
                            &dest_parent,
                            Some(&note_id),
                            dst_seq,
                            visibility_seq,
                            auth.principal(),
                            run_opt.as_ref(),
                            now_ts,
                        )
                        .await?
                        {
                            cover_events.push(event);
                        }
                    }
                }
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page,
                        note_id: note_id.clone(),
                        parent_folder_id: dest_parent,
                        is_root_child: after_anc.is_root_child,
                        slug: input.slug,
                        slug_fold: new_slug_fold,
                        title: final_title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: head.byte_size,
                        content_digest: Some(digest),
                        schema_revision: prev_schema_rev,
                        raw_fields: prev_raw_fields,
                        evaluated_fields: prev_eval_fields,
                        diagnostics: prev_diags,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    note_id.as_str(),
                    seq,
                    visibility_seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, visibility_seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "move_note",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: note_id.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields: BTreeMap::new(),
                        }],
                    },
                    vec![note_id.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: note_id.clone(),
                        revision: new_rev.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let mut events = Vec::with_capacity(1 + cover_events.len());
                events.push(BatchEventDraft {
                    space_seq: seq,
                    entity_type: "note".to_owned(),
                    entity_id: note_id.as_str().to_owned(),
                    op_kind: "move".to_owned(),
                    rev_id: new_rev,
                    lifecycle: Lifecycle::Active,
                    doc_class: Some(head.doc_class),
                });
                events.extend(cover_events);

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "move_note".to_owned(),
                    events,
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![note_id],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

pub(crate) async fn rename_note_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<RenameNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "rename_note");
    super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    let new_slug_fold = normalize_slug_key(&request.input.slug)?;

    let fp = format!(
        "note={}\0slug={}\0title={}",
        request.input.note.as_str(),
        request.input.slug,
        request.input.title.as_deref().unwrap_or("<none>")
    );
    let idemp = derive_command_identity_spec(&ctx, &request.identity, "rename_note", fp.as_bytes())
        .with_preconditions(&request.preconditions, "note", request.input.note.as_str())
        .with_rename_title(request.input.title.as_deref())
        .with_confirmed_chat_step(&ctx, "rename_note")
        .for_note(ctx.auth(), &request.input.note);

    if let Some(replayed) = deadline
        .wait(&ctx.budget, || {
            try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await??
    {
        return Ok(replayed.into_committed());
    }

    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let (mut space_rec, mut base_head) = deadline
        .wait(&ctx.budget, || {
            read_active_note_for_mutation(
                store,
                &ctx,
                &request.input.note,
                &request.preconditions,
                NoteMutationAccess::Current,
            )
        })
        .await??;

    let was_fenced = store
        .inner
        .room_fences
        .is_room_fenced(&space_rec.scope.space_id, &request.input.note);
    let move_pin = if let Some(interceptor) = store.inner.collab_interceptor.get() {
        let fences = store.inner.room_fences.clone();
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        let (observed_active_lease, pin) = deadline
            .wait(&ctx.budget, || async {
                let lease = fences
                    .observed_active_lease(ctx.scope(), &request.input.note)
                    .await;
                let pin = interceptor
                    .filename_pin(ctx.clone(), request.input.note.clone())
                    .await?;
                Ok::<_, PortError>((lease, pin))
            })
            .await??;
        match pin {
            FilenamePin::Unpinned => MovePin::UnpinnedAt {
                fences,
                observed_active_lease,
            },
            FilenamePin::Pinned {
                note,
                filename,
                lease,
            } if note == request.input.note && filename == request.input.slug => {
                MovePin::PinnedAt {
                    fences,
                    filename,
                    lease,
                }
            }
            FilenamePin::Pinned { .. } => {
                return Err(unavailable_retryable(
                    "rename_note_blocked_by_filename_pin",
                    "cannot rename note slug while live room holds filename pin",
                    std::time::Duration::from_millis(50),
                ));
            }
        }
    } else {
        MovePin::Checked
    };

    if let Some(explicit_title) = &request.input.title {
        let trimmed = explicit_title.trim();
        if trimmed.is_empty() || trimmed.contains('\r') || trimmed.contains('\n') {
            return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
        }
        if matches!(move_pin, MovePin::PinnedAt { .. }) {
            return Err(unavailable_retryable(
                "rename_note_blocked_by_filename_pin",
                "cannot rewrite note title while live room holds filename pin",
                std::time::Duration::from_millis(50),
            ));
        }
        if was_fenced
            || store
                .inner
                .room_fences
                .fenced_recovery_revision(
                    &space_rec.scope.space_id,
                    &request.input.note,
                    &base_head.head_rev_id,
                )
                .is_some()
        {
            ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
            let refreshed = deadline
                .wait(&ctx.budget, || {
                    read_active_note_for_mutation(
                        store,
                        &ctx,
                        &request.input.note,
                        &request.preconditions,
                        NoteMutationAccess::Current,
                    )
                })
                .await??;
            space_rec = refreshed.0;
            base_head = refreshed.1;
        }
        if base_head.doc_class == DocClass::EncryptedNote && trimmed != request.input.slug {
            return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
        }
        if base_head.doc_class != DocClass::EncryptedNote {
            let base_digest = base_head.content_digest.ok_or_else(|| {
                internal_not_committed("active_note_missing_digest", "active note lacks digest")
            })?;
            let raw_bytes = deadline
                .wait(&ctx.budget, || {
                    store.read_verified_blob(&space_rec.scope, base_digest)
                })
                .await??;
            let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
                internal_not_committed("corrupt_note_utf8", "carrier not valid UTF-8")
            })?;
            let updated_carrier =
                apply_title_surgery_to_carrier(&base_carrier, base_head.doc_class, trimmed)?;
            let info = analyze_and_prepare_carrier(
                &updated_carrier,
                base_head.doc_class,
                &request.input.note,
                &request.input.slug,
                store.blob_codec(),
            )?;
            let ticket = deadline
                .wait(&ctx.budget, || {
                    store.stage_blob_for_batch(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        &info.prepared_blob,
                    )
                })
                .await??;
            let intent = build_carrier_replacement_intent(
                store,
                &space_rec.scope,
                space_rec.active_epoch,
                Some(idemp),
                "rename_note",
                ctx.auth().clone(),
                request.identity,
                request.preconditions,
                request.input.note,
                base_head.head_rev_id,
                CarrierReplacement::Rename(request.input.slug, new_slug_fold),
                info,
                ticket,
                None,
            );
            let stored: StoredCommittedNoteRevV1 = store
                .submit_write_command_until(&ctx.budget, deadline.at, intent, None, None, None)
                .await?;
            return Ok(stored.into_committed());
        }
    }

    // Pure slug rename without carrier body rewrite!
    let intent = build_move_note_intent(
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        MetadataChange::Rename(request.input),
        new_slug_fold,
        Ok(move_pin),
    );
    let stored: StoredCommittedNoteRevV1 = store
        .submit_write_command_until(&ctx.budget, deadline.at, intent, None, None, None)
        .await?;
    Ok(stored.into_committed())
}

fn apply_title_surgery_to_carrier(
    carrier: &str,
    class: DocClass,
    new_title: &str,
) -> Result<String, PortError> {
    let hdr = notarium_syntax::frontmatter::analyze(carrier, class)?;
    let body = hdr.carrier.body;
    let markdown = notarium_syntax::markdown::analyze(carrier, body)?;
    let mut edits = Vec::new();
    let title = hdr.fields.as_ref().and_then(|fields| fields.get("title"));
    let heading = if let Some(title) = title {
        let plan = notarium_syntax::frontmatter::patch_frontmatter(
            carrier,
            class,
            &[FieldEdit::Set {
                key: "title".to_owned(),
                value: YamlValue::String(new_title.to_owned()),
            }],
        )?;
        edits.extend(
            plan.edits
                .into_iter()
                .map(|edit| (edit.origin, edit.bytes.0, edit.replacement)),
        );
        markdown
            .leading_h1(carrier, body)
            .filter(|heading| match title {
                YamlValue::String(title) if !title.trim().is_empty() => {
                    heading.title.trim() == title.trim()
                }
                _ => true,
            })
    } else {
        markdown.headings.iter().find(|heading| heading.level == 1)
    };
    if let Some(heading) = heading.filter(|heading| heading.title.trim() != new_title) {
        let start = heading.heading_span.start();
        let text = heading
            .heading_span
            .slice(carrier)?
            .trim_end_matches(['\r', '\n']);
        let span = ByteSpan::new(start, start + text.len())?;
        edits.push((CarrierEditOrigin::Body, span, format!("# {new_title}")));
    } else if title.is_none() && heading.is_none() {
        let at = body.start();
        let eol = hdr.carrier.eol;
        let padding = if hdr.carrier.header.is_some() && !carrier[..at].ends_with('\n') {
            eol
        } else {
            ""
        };
        let after = if body.is_empty() { "" } else { eol };
        edits.push((
            CarrierEditOrigin::Body,
            ByteSpan::new(at, at)?,
            format!("{padding}# {new_title}{eol}{after}"),
        ));
    }
    let plan = notarium_syntax::patch::plan(carrier, body, edits)?;
    notarium_syntax::patch::apply(carrier, &plan).map_err(PortError::from)
}

#[cfg(test)]
#[test]
fn rename_synchronizes_only_the_heading_used_as_title() {
    let matching = "---\r\ntitle: Guide\r\n---\r\n# Guide\r\nParagraph\r\n";
    let distinct = matching.replace("# Guide", "# First chapter");
    let delayed = matching.replace("# Guide", "Introductory paragraph\r\n\r\n# Guide");
    for (source, expected) in [
        (matching.to_owned(), matching.replace("Guide", "Updated")),
        (distinct.clone(), distinct.replacen("Guide", "Updated", 1)),
        (delayed.clone(), delayed.replacen("Guide", "Updated", 1)),
    ] {
        assert_eq!(
            apply_title_surgery_to_carrier(&source, DocClass::UserDoc, "Updated").unwrap(),
            expected
        );
    }
}

// Retain only carrier versions named by a remaining edit. Each savepoint decides
// whether that version and class are the current head after preceding outcomes.
#[derive(Default)]
struct BatchEditSources {
    bytes: HashMap<(NoteId, ContentDigest), RequestedCarrier>,
    classes: HashMap<NoteId, BTreeSet<DocClass>>,
}

#[derive(Default)]
struct RequestedCarrier {
    remaining: usize,
    carrier: Option<Arc<str>>,
}

impl BatchEditSources {
    fn take_base(&mut self, note: &NoteId, digest: ContentDigest) -> Option<Arc<str>> {
        use std::collections::hash_map::Entry;
        let Entry::Occupied(mut entry) = self.bytes.entry((note.clone(), digest)) else {
            return None;
        };
        entry.get_mut().remaining -= 1;
        if entry.get().remaining == 0 {
            entry.remove().carrier
        } else {
            entry.get().carrier.clone()
        }
    }

    fn remember(&mut self, note: &NoteId, digest: ContentDigest, carrier: &str) {
        if let Some(slot) = self.bytes.get_mut(&(note.clone(), digest)) {
            slot.carrier.get_or_insert_with(|| Arc::from(carrier));
        }
    }
}

struct PreparedBatchEdit {
    variants: BTreeMap<DocClass, Result<PreparedCarrierInfo, PortError>>,
    ticket: Option<crate::blobs::StagedBlobTicket>,
}

// Only find candidate receipts here. The writer checks the current authority, hash, and
// status before returning a stored outcome at the item's position in the batch.
async fn batch_receipt_hashes(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    keys: Vec<String>,
) -> Result<HashMap<String, Vec<u8>>, PortError> {
    if keys.is_empty() {
        return Ok(Default::default());
    }
    let scope = ctx.scope().clone();
    let actor = ctx.auth().principal().clone();
    store.with_read_tx_budget(Some(&ctx.budget), |tx| Box::pin(async move {
        let rows: Vec<(String, Vec<u8>)> = match tx {
            BackendConn::Sqlite(conn) => sqlx::query_as(
                "SELECT idempotency_key,command_hash FROM command_receipts WHERE space_id=? AND history_incarnation=? AND actor_id=?
                 AND idempotency_key IN (SELECT value FROM json_each(?))",
            ).bind(scope.space_id.as_str()).bind(scope.incarnation.as_bytes().as_slice()).bind(actor.as_str())
             .bind(serde_json::to_string(&keys).map_err(|e| internal_not_committed("encode_batch_receipt_keys", e.to_string()))?).fetch_all(&mut **conn).await,
            BackendConn::Postgres(conn) => sqlx::query_as(
                "SELECT idempotency_key,command_hash FROM command_receipts WHERE space_id=$1 AND history_incarnation=$2 AND actor_id=$3
                 AND idempotency_key=ANY($4)",
            ).bind(scope.space_id.as_str()).bind(scope.incarnation.as_bytes().as_slice()).bind(actor.as_str())
             .bind(&keys).fetch_all(&mut **conn).await,
        }.map_err(|err| crate::runtime::pg_read_error("lookup_batch_receipt_keys", err))?;
        Ok(rows.into_iter().collect())
    })).await
}

fn validate_batch_item(ctx: &SpaceContext, item: &Mutation<BatchItem>) -> Result<(), PortError> {
    let confirmable = matches!(
        &item.input,
        BatchItem::Create(_)
            | BatchItem::Edit(_)
            | BatchItem::Move(_)
            | BatchItem::Delete(DeleteNote {
                disposition: DeleteDisposition::Trash,
                ..
            })
    );
    if confirmable {
        super::common::validate_confirmable_mutation_identity(ctx, &item.identity)?;
    } else {
        validate_mutation_identity(ctx, &item.identity)?;
    }
    if matches!(item.input, BatchItem::Create(_)) {
        super::common::require_empty_preconditions(&item.preconditions)?;
    }
    Ok(())
}

pub(crate) async fn accept_batch_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: AcceptBatch,
) -> Result<BatchResult<NoteRevision>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "accept_batch");
    let budget = ctx.budget.clone();
    let space_rec = deadline
        .wait(&budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&budget))
        })
        .await??;
    deadline.remaining(&budget)?;
    space_rec.scope.check(ctx.scope())?;

    if request.items.is_empty() {
        return Ok(BatchResult {
            items: Vec::new(),
            committed_high_watermark: space_rec.last_seq,
        });
    }

    let intents = deadline
        .wait(&budget, || {
            prepare_batch_intents(store, &mut ctx, &space_rec, request, &deadline)
        })
        .await??;
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let (raw_outcomes, committed_high_watermark) = store
        .submit_write_batch::<StoredCommittedNoteRevV1>(
            &ctx.budget,
            &space_rec.scope.space_id,
            intents,
        )
        .await
        .map_err(|error| batch_error(error, false))?;

    batch_results(
        raw_outcomes,
        committed_high_watermark,
        StoredCommittedNoteRevV1::into_committed,
    )
}

async fn prepare_batch_intents(
    store: &CanonicalStore,
    ctx: &mut SpaceContext,
    space_rec: &crate::SpaceRecord,
    request: AcceptBatch,
    deadline: &super::common::CommandDeadline,
) -> Result<Vec<PreparedWriteIntent>, PortError> {
    let keys = request
        .items
        .iter()
        .filter(|item| {
            matches!(item.input, BatchItem::Create(_) | BatchItem::Edit(_))
                || (store.inner.collab_interceptor.get().is_some()
                    && matches!(item.input, BatchItem::Move(_)))
        })
        .filter(|item| validate_batch_item(ctx, item).is_ok())
        .map(|item| item.identity.key.as_str().to_owned())
        .collect();
    let receipts = batch_receipt_hashes(store, ctx, keys).await?;
    let mut sources = BatchEditSources::default();
    let mut edited_notes = BTreeSet::new();
    for item in &request.items {
        match &item.input {
            BatchItem::Edit(edit) if !receipts.contains_key(item.identity.key.as_str()) => {
                sources
                    .bytes
                    .entry((edit.note.clone(), edit.plan.base_content_hash))
                    .or_default()
                    .remaining += 1;
                edited_notes.insert(edit.note.clone());
            }
            _ => {}
        }
    }
    for nid in edited_notes {
        let scope = space_rec.scope.clone();
        let note = nid.clone();
        let auth = ctx.auth().clone();
        let space = space_rec.space.clone();
        let head = store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    if is_note_purge_fenced_tx(tx, &scope.space_id, note.as_str()).await? {
                        return Ok(None);
                    }
                    let Some(head) = load_note_head_row_opt_tx(tx, &scope.space_id, &note).await?
                    else {
                        return Ok(None);
                    };
                    if head.lifecycle == Lifecycle::Purged {
                        return Ok(None);
                    }
                    let (facts, _) = match build_resource_facts_tx(
                        tx,
                        &space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        true,
                    )
                    .await
                    {
                        Ok(facts) => facts,
                        Err(PortError::Domain(_)) => return Ok(None),
                        Err(error) => return Err(error),
                    };
                    if auth.authorize_direct_write(&facts, &facts).is_err() {
                        return Ok(None);
                    }
                    Ok(Some(head))
                })
            })
            .await?;
        if let Some(head) = head {
            sources
                .classes
                .entry(nid.clone())
                .or_default()
                .insert(head.doc_class);
            // A preceding restore can reactivate a trashed head without changing its carrier.
            if let Some(digest) = head.content_digest
                && let Some(slot) = sources.bytes.get_mut(&(nid, digest))
            {
                let bytes = store.read_verified_blob(&space_rec.scope, digest).await?;
                slot.carrier = Some(
                    String::from_utf8(bytes)
                        .map_err(|e| internal_not_committed("batch_edit_base_utf8", e.to_string()))?
                        .into(),
                );
            }
        }
    }

    let mut intents = Vec::with_capacity(request.items.len());
    let mut placements = BTreeMap::new();
    for item_mut in request.items {
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        if let Err(err) = validate_batch_item(ctx, &item_mut) {
            intents.push(build_failing_item_intent(
                &space_rec.scope,
                space_rec.active_epoch,
                err,
            ));
            continue;
        }
        let idemp = match &item_mut.input {
            BatchItem::Create(cr) => Some(create_note_identity(
                ctx,
                &item_mut.identity,
                cr,
                &space_rec.root_folder_id,
                notarium_syntax::content_digest(&cr.carrier),
            )),
            BatchItem::Edit(ed) => Some(edit_note_identity(
                ctx,
                &item_mut.identity,
                ed,
                &item_mut.preconditions,
            )),
            BatchItem::Move(mv) => Some(move_note_identity(
                ctx,
                &item_mut.identity,
                mv,
                &item_mut.preconditions,
            )),
            _ => None,
        };
        if let (Some(spec), Some(stored_hash)) =
            (&idemp, receipts.get(item_mut.identity.key.as_str()))
        {
            // The writer checks the current move fingerprint. Only carrier
            // commands need historical evidence to recognize old hashes.
            let checked = if matches!(item_mut.input, BatchItem::Move(_))
                || spec.has_confirmed_chat_step()
                || spec.command_hash.as_bytes().as_slice() == stored_hash
            {
                Ok(spec.clone())
            } else {
                let command = match &item_mut.input {
                    BatchItem::Create(cr) => v1_receipts::LegacyNoteCommand::Create(
                        v1_receipts::CreatedNote::from_input(
                            cr,
                            &space_rec.root_folder_id,
                            notarium_syntax::content_digest(&cr.carrier),
                        ),
                    ),
                    BatchItem::Edit(ed) => {
                        v1_receipts::LegacyNoteCommand::Edit(ed, &item_mut.preconditions)
                    }
                    _ => unreachable!("only carrier items have a receipt candidate"),
                };
                command
                    .verified_identity(store, ctx, &item_mut.identity, spec)
                    .await
            };
            let replay = match checked {
                Ok(authenticated) => {
                    let mut replay = build_failing_item_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        DomainError::ResourceNotFound.into(),
                    );
                    replay.idempotency = Some(authenticated);
                    replay
                }
                Err(err) => {
                    build_failing_item_intent(&space_rec.scope, space_rec.active_epoch, err)
                }
            };
            intents.push(replay);
            continue;
        }
        match item_mut.input {
            BatchItem::Create(cr) => {
                if let Some(step) = ctx.confirmed_chat_step()
                    && (cr.class != DocClass::UserDoc
                        || step
                            .destination()
                            .is_none_or(|destination| destination.move_source.is_some()))
                {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                let res: Result<PreparedWriteIntent, PortError> = async {
                    let slug_fold = super::folder_cover::validate_create(&cr)?;
                    if cr.class == DocClass::Skill {
                        ctx.auth().authorize_ability_mutation()?;
                    }
                    let placement = (cr.parent.clone(), cr.class);
                    let admitted = match placements.entry(placement) {
                        std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::btree_map::Entry::Vacant(entry) => entry.insert(
                            authorize_create_placement(store, ctx, cr.parent.clone(), cr.class)
                                .await
                                .map(|_| ()),
                        ),
                    };
                    admitted.clone()?;
                    let info = analyze_and_prepare_carrier(
                        &cr.carrier,
                        cr.class,
                        &cr.note,
                        &cr.slug,
                        store.blob_codec(),
                    )?;
                    let ticket = store
                        .stage_blob_for_batch(
                            &space_rec.scope,
                            space_rec.active_epoch,
                            &info.prepared_blob,
                        )
                        .await?;
                    sources
                        .classes
                        .entry(cr.note.clone())
                        .or_default()
                        .insert(cr.class);
                    sources.remember(&cr.note, info.prepared_blob.digest, &cr.carrier);
                    Ok(build_create_note_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        idemp.clone(),
                        ctx.auth().clone(),
                        cr,
                        slug_fold,
                        info,
                        ticket,
                    ))
                }
                .await;
                match res {
                    Ok(intent) => intents.push(intent),
                    Err(err) => {
                        let mut failed = build_failing_item_intent(
                            &space_rec.scope,
                            space_rec.active_epoch,
                            err,
                        );
                        failed.idempotency = idemp;
                        intents.push(failed);
                    }
                }
            }
            BatchItem::Edit(ed) => {
                let prepared: Result<PreparedBatchEdit, PortError> = async {
                    let base = sources
                        .take_base(&ed.note, ed.plan.base_content_hash)
                        .ok_or_else(|| DomainError::validation(ValidationReason::SourceMismatch))?;
                    let next = notarium_syntax::patch::apply(&base, &ed.plan)?;
                    let blob = PreparedBlobSource::prepare(next.as_bytes(), store.blob_codec())?;
                    let mut variants = BTreeMap::new();
                    for &class in sources.classes.get(&ed.note).into_iter().flatten() {
                        let variant = (|| {
                            let header = if class == DocClass::EncryptedNote {
                                None
                            } else {
                                enforce_protected_frontmatter_unchanged_with_header(
                                    &base, &next, class,
                                )?
                            };
                            // An empty fallback marks a title derived from the slug. The
                            // savepoint fills it from the actual head after any move.
                            analyze_carrier_metadata(&next, class, "", header, || Ok(blob.clone()))
                        })();
                        variants.insert(class, variant);
                    }
                    let ticket = if variants.values().any(Result::is_ok) {
                        let ticket = store
                            .stage_blob_for_batch(&space_rec.scope, space_rec.active_epoch, &blob)
                            .await?;
                        sources.remember(&ed.note, blob.digest, &next);
                        Some(ticket)
                    } else {
                        None
                    };
                    Ok(PreparedBatchEdit { variants, ticket })
                }
                .await;
                intents.push(build_batch_edit_intent(
                    store,
                    &space_rec.scope,
                    space_rec.active_epoch,
                    idemp,
                    ctx.auth().clone(),
                    item_mut.preconditions,
                    ed.note,
                    ed.plan.base_content_hash,
                    prepared,
                ));
            }
            BatchItem::Delete(del) => {
                if del.disposition == DeleteDisposition::Purge {
                    intents.push(build_failing_item_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        DomainError::validation(ValidationReason::InvalidState).into(),
                    ));
                    continue;
                }
                let disp_tag = match del.disposition {
                    DeleteDisposition::Trash => "trash_note",
                    DeleteDisposition::Restore => "restore_note",
                    DeleteDisposition::Purge => unreachable!(),
                };
                let fp = format!("{disp_tag}={}", del.note.as_str());
                let idemp =
                    derive_command_identity_spec(ctx, &item_mut.identity, disp_tag, fp.as_bytes())
                        .with_preconditions(&item_mut.preconditions, "note", del.note.as_str())
                        .with_confirmed_chat_step(ctx, disp_tag)
                        .for_note(ctx.auth(), &del.note);
                intents.push(build_trash_or_restore_intent(
                    store,
                    &space_rec.scope,
                    space_rec.active_epoch,
                    Some(idemp),
                    ctx.auth().clone(),
                    item_mut.preconditions,
                    DeleteTarget::Note(del),
                ));
            }
            BatchItem::Move(mv) => {
                if let Some(step) = ctx.confirmed_chat_step() {
                    let source = step
                        .destination()
                        .and_then(|destination| destination.move_source.as_ref());
                    if !source.is_some_and(|(note, revision)| {
                        note == &mv.note
                            && item_mut.preconditions.revision.as_ref() == Some(revision)
                    }) {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                }
                match normalize_slug_key(&mv.slug) {
                    Ok(sf) => {
                        let pin = deadline
                            .wait(&ctx.budget, || prepare_batch_move_pin(store, ctx, &mv))
                            .await?;
                        intents.push(build_move_note_intent(
                            &space_rec.scope,
                            space_rec.active_epoch,
                            idemp,
                            ctx.auth().clone(),
                            item_mut.preconditions,
                            MetadataChange::Move(mv),
                            sf,
                            pin,
                        ));
                    }
                    Err(err) => intents.push(build_failing_item_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        err.into(),
                    )),
                }
            }
        }
    }

    Ok(intents)
}

#[allow(clippy::too_many_arguments)]
fn build_batch_edit_intent(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    note_id: NoteId,
    expected_base_digest: ContentDigest,
    prepared: Result<PreparedBatchEdit, PortError>,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let staged_bytes = prepared
        .as_ref()
        .ok()
        .and_then(|edit| edit.ticket.as_ref())
        .map_or(0, |ticket| ticket.compressed_size);

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![note_id.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note_id).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;

                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &note_id, &preconditions)
                    .await?;
                if is_note_room_active_tx(tx, &room_fences, &scope_cl, &note_id).await? {
                    return Err(unavailable_retryable(
                        "batch_edit_blocked_by_active_or_fenced_room",
                        "cannot overwrite note carrier directly while collaborative room is active or fenced",
                        std::time::Duration::from_millis(50),
                    ));
                }

                if head.content_digest != Some(expected_base_digest) {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                let PreparedBatchEdit {
                    mut variants,
                    ticket,
                } = prepared?;
                let mut info = variants.remove(&head.doc_class).ok_or_else(|| {
                    DomainError::RevisionConflict {
                        current: head.head_rev_id.clone(),
                        lineage: None,
                    }
                })??;
                let ticket = ticket.ok_or_else(|| {
                    internal_not_committed(
                        "missing_batch_edit_ticket",
                        "valid carrier variant lacks CAS ticket",
                    )
                })?;
                if info.title.is_empty() {
                    info.title.clone_from(&head.slug);
                    info.title_fold = normalize_title_key(&head.slug);
                }

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: note_id.as_str().to_owned(),
                        owner_rev_id: new_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;
                crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
                    tx,
                    &scope_cl.space_id,
                    &note_id,
                    &new_rev,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = ?, title_fold = ?, head_rev_id = ?, content_blake3 = ?,
                                 byte_size = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                 last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_batch_edit", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = $1, title_fold = $2, head_rev_id = $3, content_blake3 = $4,
                                 byte_size = $5, updated_seq = $6, updated_at_sec = $7, updated_at_nsec = $8,
                                 last_actor_id = $9
                             WHERE space_id = $10 AND note_id = $11",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_batch_edit", err.to_string()))?;
                    }
                }

                if info.title_fold != head.title_fold {
                    insert_note_alias_tx(
                        tx,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                        &head.slug_fold,
                        &head.title_fold,
                        &note_id,
                        seq,
                    )
                    .await?;
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = if head.doc_class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else {
                    evaluate_fields_with_schema(
                        info.raw_fields.as_ref(),
                        info.diagnostics.first(),
                        current_schema.as_ref().map(|s| &s.fields),
                    )
                };

                let run_opt = extract_agent_run_from_auth(&auth);
                let changed_fields =
                    changed_revision_fields_tx(tx, &scope_cl, &head.head_rev_id, &eval_fields)
                        .await?;
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: anc.cover_note.as_ref() == Some(&note_id),
                        note_id: note_id.clone(),
                        parent_folder_id: head.parent_folder_id,
                        is_root_child: anc.is_root_child,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: info.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    note_id.as_str(),
                    seq,
                    seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "edit_note",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: note_id.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        }],
                    },
                    vec![note_id.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: note_id.clone(),
                        revision: new_rev.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "edit_note".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: note_id.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![note_id],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

fn build_failing_item_intent(
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    err: PortError,
) -> PreparedWriteIntent {
    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: None,
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |_tx, _item_ctx| Box::pin(async move { Err(err) })),
    }
}

fn validate_and_format_link_line(link: &Link) -> Result<String, PortError> {
    let rel = link.relation.trim();
    if rel.is_empty() || rel.contains(['\r', '\n', '\0', ':', '[', ']', '|', '\\']) {
        return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
    }
    authorize_field_key(rel)?;

    let target_token = match &link.target {
        LinkTarget::Note(nid) => nid.as_str().to_owned(),
        LinkTarget::Folder(fid) => fid.as_str().to_owned(),
        LinkTarget::AuthoredName(name) => {
            let trimmed = name.trim();
            if trimmed.is_empty()
                || trimmed.contains('\r')
                || trimmed.contains('\n')
                || trimmed.contains('\0')
                || trimmed.contains(['[', ']', '|'])
            {
                return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
            }
            trimmed.to_owned()
        }
    };
    let label = match link.target_title.as_deref() {
        Some(title) => {
            let title = title.trim();
            if !matches!(link.target, LinkTarget::Note(_))
                || title.is_empty()
                || title.contains(['\r', '\n', '\0', '[', ']', '|'])
            {
                return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
            }
            format!("|{title}")
        }
        None => String::new(),
    };
    Ok(format!("- {rel}: [[{target_token}{label}]]\n"))
}

fn link_identity(
    ctx: &SpaceContext,
    item: &Mutation<Link>,
    line: &str,
) -> crate::writer::CommandIdentitySpec {
    let kind = match item.input.target {
        LinkTarget::Note(_) => "note",
        LinkTarget::Folder(_) => "folder",
        LinkTarget::AuthoredName(_) => "authored",
    };
    let mut hash = blake3::Hasher::new();
    for part in [item.input.source.as_str(), kind, line] {
        hash.update(part.as_bytes());
        hash.update(&[0]);
    }
    hash_preconditions(&mut hash, &item.preconditions);
    derive_command_identity_spec(ctx, &item.identity, "link", hash.finalize().as_bytes())
        .with_confirmed_chat_step(ctx, "link")
        .for_link(ctx.auth(), &item.input.source, &item.input.target)
}

pub(crate) async fn link_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<Link>,
) -> Result<Committed<Link>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "link");
    super::common::validate_confirmable_mutation_identity(&ctx, &request.identity)?;
    let link_line = validate_and_format_link_line(&request.input)?;

    let idemp = link_identity(&ctx, &request, &link_line);
    let replay = deadline
        .prepare(&ctx.budget, || {
            try_replay_completed_receipt::<StoredCommittedLinkV1>(
                store,
                ctx.scope(),
                &idemp,
                Some(&ctx.budget),
            )
        })
        .await;
    let replay = match replay {
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
            if !idemp.has_confirmed_chat_step() =>
        {
            let original = deadline
                .prepare(&ctx.budget, || {
                    v1_receipts::link_identity(store, &ctx, &request, &link_line, idemp.clone())
                })
                .await?;
            let previous = deadline
                .prepare(&ctx.budget, || {
                    try_replay_completed_receipt::<StoredCommittedLinkV1>(
                        store,
                        ctx.scope(),
                        &original,
                        Some(&ctx.budget),
                    )
                })
                .await?
                .ok_or(DomainError::IdempotencyKeyReused)?;
            return Ok(previous.into_committed());
        }
        other => other?,
    };
    if let Some(replayed) = replay {
        return Ok(replayed.into_committed());
    }

    let intent = deadline
        .prepare(&ctx.budget, || {
            prepare_link_intent(store, &ctx, request, &link_line, idemp, None)
        })
        .await?;
    let stored: StoredCommittedLinkV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

async fn authorize_link_target_tx(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    source_class: DocClass,
    target: &LinkTarget,
) -> Result<(), PortError> {
    match target {
        LinkTarget::Note(target_nid) => {
            if is_note_purge_fenced_tx(tx, &space.scope.space_id, target_nid.as_str()).await? {
                return Err(DomainError::ResourceNotFound.into());
            }
            let target_head = load_note_head_row_tx(tx, &space.scope.space_id, target_nid).await?;
            if target_head.lifecycle != Lifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            let (tfacts, _) = build_resource_facts_tx(
                tx,
                &space.space,
                &target_head.parent_folder_id,
                target_head.doc_class,
                target_head.ability_id,
                true,
            )
            .await?;
            auth.authorize_read(&tfacts)?;
        }
        LinkTarget::Folder(target_fid) => {
            let fanc = load_folder_ancestry_tx(tx, &space.scope.space_id, target_fid, true).await?;
            let tfacts = notarium_core::auth::ResourceFacts {
                space: space.space.clone(),
                class: source_class,
                project: fanc.project,
                ancestor_folders: fanc.ancestors,
                folder_write_locked: fanc.write_locked,
                ability_package: None,
            };
            auth.authorize_read(&tfacts)?;
        }
        LinkTarget::AuthoredName(_) => {}
    }

    Ok(())
}

async fn prepare_link_intent(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    request: Mutation<Link>,
    link_line: &str,
    idemp: crate::writer::CommandIdentitySpec,
    expected_epoch: Option<notarium_core::ids::LeaseEpoch>,
) -> Result<PreparedWriteIntent, PortError> {
    let (space_rec, base_head) = read_active_note_for_mutation(
        store,
        ctx,
        &request.input.source,
        &request.preconditions,
        NoteMutationAccess::Link(request.input.target.clone()),
    )
    .await?;
    if expected_epoch.is_some_and(|epoch| epoch != space_rec.active_epoch) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if base_head.doc_class == DocClass::EncryptedNote {
        return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
    }

    let base_digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed("link_source_missing_digest", "source note lacks digest")
    })?;
    let raw_bytes = store
        .read_verified_blob(&space_rec.scope, base_digest)
        .await?;
    let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
        internal_not_committed("link_source_utf8", "source carrier not valid UTF-8")
    })?;

    let new_carrier = append_link_line_to_carrier(
        &base_carrier,
        base_head.doc_class,
        &request.input.source,
        link_line,
    )?;
    let info = analyze_and_prepare_carrier(
        &new_carrier,
        base_head.doc_class,
        &request.input.source,
        &base_head.slug,
        store.blob_codec(),
    )?;
    let ticket = store
        .stage_blob_for_batch(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

    Ok(build_link_item_intent(
        store,
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        request.input,
        base_digest,
        info,
        ticket,
    ))
}

// Preserve the underlying diagnostic and error category. A failed item cannot speak
// for a neighbor which committed, replayed, or has an unknown commit outcome.
fn batch_error(error: PortError, has_other_outcome: bool) -> PortError {
    use notarium_core::error::{CommitEffect, OperationalFailure, RetryAdvice};
    if !has_other_outcome && !has_commit_outcome::<()>(&Err(error.clone())) {
        return error;
    }
    let change = |failure: OperationalFailure| {
        OperationalFailure::new(
            failure.diagnostic_ref(),
            CommitEffect::Unknown,
            RetryAdvice::RetrySameCommand,
            true,
        )
        .expect("batch items carry stable command identities")
    };
    match error {
        PortError::Unavailable(failure) => PortError::Unavailable(change(failure)),
        PortError::Internal(failure) => PortError::Internal(change(failure)),
        PortError::Cancelled(failure) => PortError::Cancelled(change(failure)),
        PortError::DeadlineExceeded(failure) => PortError::DeadlineExceeded(change(failure)),
        PortError::Domain(error) => {
            crate::codec::unknown_commit_outcome("batch_interrupted", error.code())
        }
    }
}

fn has_commit_outcome<T>(item: &Result<T, PortError>) -> bool {
    use notarium_core::error::CommitEffect;
    match item {
        Ok(_) => true,
        Err(PortError::Domain(_)) => false,
        Err(
            PortError::Unavailable(f)
            | PortError::Internal(f)
            | PortError::Cancelled(f)
            | PortError::DeadlineExceeded(f),
        ) => f.effect() == CommitEffect::Unknown,
    }
}

fn batch_results<S, T>(
    raw: Vec<Result<S, PortError>>,
    committed_high_watermark: SpaceSeq,
    convert: impl Fn(S) -> Committed<T>,
) -> Result<BatchResult<T>, PortError> {
    let may_have_committed = raw.iter().any(has_commit_outcome);
    let mut items = Vec::with_capacity(raw.len());
    for result in raw {
        items.push(match result {
            Ok(row) => Ok(convert(row)),
            Err(PortError::Domain(domain)) => Err(domain),
            Err(error) => return Err(batch_error(error, may_have_committed)),
        });
    }
    Ok(BatchResult {
        items,
        committed_high_watermark,
    })
}

pub(crate) async fn link_many_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: LinkBatch,
) -> Result<BatchResult<Link>, PortError> {
    let budget = ctx.budget.clone();
    let deadline = super::common::CommandDeadline::start(&budget, "link_many");
    let space = deadline
        .wait(&budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&budget))
        })
        .await??;
    space.scope.check(ctx.scope())?;
    let keys = request
        .items
        .iter()
        .map(|item| item.identity.key.as_str().to_owned())
        .collect();
    let receipts = deadline
        .wait(&budget, || batch_receipt_hashes(store, &ctx, keys))
        .await??;
    deadline.remaining(&budget)?;
    let mut pending = request.items.into_iter().peekable();
    let mut outcomes = Vec::with_capacity(pending.len());
    let mut high_watermark = space.last_seq;
    while pending.peek().is_some() {
        let mut sources = HashSet::new();
        let mut intents = Vec::new();
        while let Some(next) = pending.peek() {
            // Appending a link has an implicit base. Only a repeated source needs
            // the preceding savepoint's durable result before it can stage its bytes.
            if !sources.insert(next.input.source.clone()) {
                break;
            }
            let item = pending.next().expect("peeked");
            let result = deadline
                .wait(&budget, || {
                    prepare_link_batch_item(store, &ctx, &space, item, &receipts)
                })
                .await
                .map_err(|error| batch_error(error, outcomes.iter().any(has_commit_outcome)))?;
            intents.push(match result {
                Ok(intent) => intent,
                Err(error) => build_failing_item_intent(&space.scope, space.active_epoch, error),
            });
        }
        ctx.budget.remaining = deadline
            .remaining(&budget)
            .map_err(|error| batch_error(error, outcomes.iter().any(has_commit_outcome)))?;
        let group = store
            .submit_write_batch::<StoredCommittedLinkV1>(
                &ctx.budget,
                &space.scope.space_id,
                intents,
            )
            .await;
        match group {
            Ok((items, cut)) => {
                high_watermark = cut;
                outcomes.extend(items);
            }
            Err(error) => return Err(batch_error(error, outcomes.iter().any(has_commit_outcome))),
        }
    }
    batch_results(
        outcomes,
        high_watermark,
        StoredCommittedLinkV1::into_committed,
    )
}

async fn prepare_link_batch_item(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    space: &crate::runtime::SpaceRecord,
    item: Mutation<Link>,
    receipts: &HashMap<String, Vec<u8>>,
) -> Result<PreparedWriteIntent, PortError> {
    super::common::validate_confirmable_mutation_identity(ctx, &item.identity)?;
    let line = validate_and_format_link_line(&item.input)?;
    let spec = link_identity(ctx, &item, &line);
    if let Some(hash) = receipts.get(item.identity.key.as_str()) {
        let spec =
            if hash == spec.command_hash.as_bytes().as_slice() || spec.has_confirmed_chat_step() {
                spec
            } else {
                v1_receipts::link_identity(store, ctx, &item, &line, spec).await?
            };
        let mut replay = build_failing_item_intent(
            &space.scope,
            space.active_epoch,
            DomainError::ResourceNotFound.into(),
        );
        replay.idempotency = Some(spec);
        return Ok(replay);
    }
    Ok(
        match prepare_link_intent(
            store,
            ctx,
            item,
            &line,
            spec.clone(),
            Some(space.active_epoch),
        )
        .await
        {
            Ok(intent) => intent,
            Err(error) => {
                let mut failed = build_failing_item_intent(&space.scope, space.active_epoch, error);
                failed.idempotency = Some(spec);
                failed
            }
        },
    )
}

fn append_link_line_to_carrier(
    carrier: &str,
    class: DocClass,
    source: &NoteId,
    link_line: &str,
) -> Result<String, PortError> {
    let hdr = notarium_syntax::frontmatter::analyze(carrier, class)?;
    let (prefix, target) = link_line
        .trim_end_matches('\n')
        .strip_suffix("]]")
        .and_then(|line| line.split_once("[["))
        .ok_or_else(|| internal_not_committed("invalid_link_line", "missing link target"))?;
    let target = target.split_once('|').map_or(target, |(target, _)| target);
    if carrier.contains(&format!("{prefix}[[{target}"))
        && let notarium_syntax::extract::ExtractedDocDelta::Plain(parsed) =
            notarium_syntax::extract::extract(carrier, class, source, "", None)?
        && parsed.links.iter().any(|link| {
            let before = carrier[..link.span.start()].rsplit('\n').next();
            let after = carrier[link.span.end()..].split('\n').next();
            link.raw == target
                && before == Some(prefix)
                && after.is_some_and(|line| line.trim().is_empty())
        })
    {
        return Ok(carrier.to_owned());
    }
    let needs_nl = !carrier.is_empty() && !carrier.ends_with('\n');
    let insertion = if needs_nl {
        format!("\n{link_line}")
    } else {
        link_line.to_owned()
    };
    let end = carrier.len();
    let plan = notarium_syntax::patch::plan(
        carrier,
        hdr.carrier.body,
        vec![(CarrierEditOrigin::Body, ByteSpan::new(end, end)?, insertion)],
    )?;
    let updated = notarium_syntax::patch::apply(carrier, &plan)?;
    let expected_start = end + usize::from(needs_nl) + prefix.len();
    let visible = matches!(
        notarium_syntax::extract::extract(&updated, class, source, "", None)?,
        notarium_syntax::extract::ExtractedDocDelta::Plain(parsed)
            if parsed.links.iter().any(|link| link.span.start() == expected_start && link.raw == target)
    );
    if !visible {
        // The carrier can end inside an authored fence or HTML block.
        return Err(DomainError::validation(ValidationReason::InvalidQuery).into());
    }
    Ok(updated)
}

#[allow(clippy::too_many_arguments)]
fn build_link_item_intent(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    link: Link,
    expected_base_digest: ContentDigest,
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let staged_bytes = ticket.compressed_size;
    let source_id = link.source.clone();

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![source_id.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &source_id).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;

                authorize_link_target_tx(tx, &live_space, &auth, head.doc_class, &link.target)
                    .await?;
                if head.doc_class == DocClass::EncryptedNote {
                    return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
                }
                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if head.content_digest != Some(expected_base_digest) {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &source_id, &preconditions)
                    .await?;
                if is_note_room_active_tx(tx, &room_fences, &scope_cl, &source_id).await? {
                    return Err(unavailable_retryable(
                        "link_blocked_by_active_or_fenced_room",
                        "cannot rewrite note carrier for link while collaborative room is active or fenced",
                        std::time::Duration::from_millis(50),
                    ));
                }

                let mut owner_notes = vec![source_id.clone()];
                if let LinkTarget::Note(target) = &link.target
                    && *target != source_id
                {
                    owner_notes.push(target.clone());
                }
                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: source_id.as_str().to_owned(),
                        owner_rev_id: new_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;
                crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
                    tx,
                    &scope_cl.space_id,
                    &source_id,
                    &new_rev,
                    seq,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = ?, title_fold = ?, head_rev_id = ?, content_blake3 = ?,
                                 byte_size = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                 last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(source_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_link_note", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = $1, title_fold = $2, head_rev_id = $3, content_blake3 = $4,
                                 byte_size = $5, updated_seq = $6, updated_at_sec = $7, updated_at_nsec = $8,
                                 last_actor_id = $9
                             WHERE space_id = $10 AND note_id = $11",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(source_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_link_note", err.to_string()))?;
                    }
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = evaluate_fields_with_schema(
                    info.raw_fields.as_ref(),
                    info.diagnostics.first(),
                    current_schema.as_ref().map(|s| &s.fields),
                );
                let run_opt = extract_agent_run_from_auth(&auth);
                let changed_fields =
                    changed_revision_fields_tx(tx, &scope_cl, &head.head_rev_id, &eval_fields)
                        .await?;
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: anc.cover_note.as_ref() == Some(&source_id),
                        note_id: source_id.clone(),
                        parent_folder_id: head.parent_folder_id,
                        is_root_child: anc.is_root_child,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: info.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    source_id.as_str(),
                    seq,
                    seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "link",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: source_id.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        }],
                    },
                    owner_notes.clone(),
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredCommittedLinkV1::from_link(&link, receipt.clone());
                let detail_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let sanitized_resp = StoredCommittedLinkV1 {
                    source: link.source,
                    target: match &link.target {
                        LinkTarget::AuthoredName(_) => {
                            crate::domain::common::StoredLinkTargetV1::AuthoredName(String::new())
                        }
                        other => crate::domain::common::StoredLinkTargetV1::from(other),
                    },
                    relation: link.relation,
                    target_title: None,
                    receipt,
                };
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&sanitized_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "link".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: source_id.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: Some(detail_bytes.clone()),
                    receipt_sanitized_blob: sanitized_bytes,
                    receipt_owner_note_ids: owner_notes,
                    response_bytes: detail_bytes,
                })
            })
        }),
    }
}

fn check_observed_digest(carrier: &str, declared: ContentDigest) -> Result<(), PortError> {
    if notarium_syntax::content_digest(carrier) != declared {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }
    Ok(())
}

fn observation_plan_fingerprint(plan: &CarrierPatchPlan) -> ContentDigest {
    let mut hash = blake3::Hasher::new_derive_key("notarium external observation plan v1");
    hash_carrier_plan(&mut hash, plan);
    ContentDigest::from_bytes(*hash.finalize().as_bytes())
}

async fn verify_observation_replay(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    deadline: &super::common::CommandDeadline,
    observation: &ExternalObservation,
    replayed: &StoredExternalObsOutcomeV1,
    idemp: &crate::writer::CommandIdentitySpec,
) -> Result<(), PortError> {
    match &observation.content {
        ObservedContent::Carrier(carrier) => {
            check_observed_digest(carrier, observation.observed_digest)
        }
        ObservedContent::Planned(plan) => {
            if let StoredExternalObsOutcomeV1::Committed {
                verified_plan: Some(verified),
                ..
            } = replayed
                && *verified == observation_plan_fingerprint(plan)
            {
                return Ok(());
            }
            // The receipt binds this note and base. Verification is internal to the
            // write and never grants the caller access to the historical carrier.
            let scope = ctx.scope().clone();
            let note = observation.note.clone();
            let revision = observation.base_revision.clone();
            let authority = idemp.clone();
            ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
            let digest = store
                .with_read_tx_budget(Some(&ctx.budget), |tx| {
                    Box::pin(async move {
                        authority.authorize_replay(tx, &scope).await?;
                        if is_note_purge_fenced_tx(tx, &scope.space_id, note.as_str()).await? {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let bytes = load_revision_metadata_opt_tx(tx, &scope, &revision)
                            .await?
                            .ok_or(DomainError::ResourceNotFound)?;
                        match RevisionMetadataEnvelope::decode(&bytes)?.payload {
                            RevisionMetadataPayload::Note(previous)
                                if previous.note_id == note
                                    && previous.lifecycle != Lifecycle::Purged =>
                            {
                                previous
                                    .content_digest
                                    .ok_or(DomainError::ResourceNotFound.into())
                            }
                            _ => Err(DomainError::ResourceNotFound.into()),
                        }
                    })
                })
                .await?;
            if digest != plan.base_content_hash {
                return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
            }
            let bytes = store.read_verified_blob(ctx.scope(), digest).await?;
            // Re-check current authority, erasure, history and identity after CAS I/O.
            ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
            if try_replay_completed_receipt::<StoredExternalObsOutcomeV1>(
                store,
                ctx.scope(),
                idemp,
                Some(&ctx.budget),
            )
            .await?
            .is_none()
            {
                return Err(DomainError::ResourceNotFound.into());
            }
            let base = std::str::from_utf8(&bytes).map_err(|_| {
                internal_not_committed("obs_corrupt_utf8", "carrier not valid UTF-8")
            })?;
            let carrier = notarium_syntax::patch::apply(base, plan)?;
            check_observed_digest(&carrier, observation.observed_digest)
        }
    }
}

async fn current_observation_head(
    store: &CanonicalStore,
    ctx: &mut SpaceContext,
    request: &Mutation<ExternalObservation>,
    deadline: &super::common::CommandDeadline,
) -> Result<(crate::SpaceRecord, super::common::NoteHeadRow), PortError> {
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let result = deadline
        .wait(&ctx.budget, || {
            read_active_note_for_mutation(
                store,
                ctx,
                &request.input.note,
                &request.preconditions,
                NoteMutationAccess::Current,
            )
        })
        .await?;
    deadline.remaining(&ctx.budget)?;
    result
}

fn external_observation_identity(
    ctx: &SpaceContext,
    request: &Mutation<ExternalObservation>,
) -> crate::writer::CommandIdentitySpec {
    let mut fp = blake3::Hasher::new();
    fp.update(request.input.note.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.observed_digest.as_bytes());
    fp.update(&[0]);
    fp.update(request.input.base_revision.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.disk_identity.as_bytes());
    derive_command_identity_spec(
        ctx,
        &request.identity,
        "accept_external_observation",
        fp.finalize().as_bytes(),
    )
    .with_preconditions(&request.preconditions, "note", request.input.note.as_str())
    .with_known_base(&request.input.base_revision)
    .for_note(ctx.auth(), &request.input.note)
}

fn external_observation_result(outcome: StoredExternalObsOutcomeV1) -> ExternalObservationResult {
    match outcome {
        StoredExternalObsOutcomeV1::Committed { result, .. } => {
            ExternalObservationResult::Committed(result.into_committed())
        }
        StoredExternalObsOutcomeV1::NoChange { revision } => {
            ExternalObservationResult::NoChange { revision }
        }
        StoredExternalObsOutcomeV1::Conflict { current } => {
            ExternalObservationResult::Conflict { current }
        }
    }
}

async fn replay_external_observation(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    deadline: CommandDeadline,
    observation: &ExternalObservation,
    idemp: &crate::writer::CommandIdentitySpec,
) -> Result<Option<ExternalObservationResult>, PortError> {
    let Some(replayed) =
        replay_command::<StoredExternalObsOutcomeV1>(store, ctx, deadline, idemp).await?
    else {
        return Ok(None);
    };
    deadline
        .prepare(&ctx.budget, || {
            Box::pin(verify_observation_replay(
                store,
                ctx.clone(),
                &deadline,
                observation,
                &replayed,
                idemp,
            ))
        })
        .await?;
    Ok(Some(external_observation_result(replayed)))
}

async fn replay_observation_or_conflict(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    deadline: CommandDeadline,
    observation: &ExternalObservation,
    idemp: &crate::writer::CommandIdentitySpec,
    current: RevisionId,
) -> Result<ExternalObservationResult, PortError> {
    Ok(
        replay_external_observation(store, ctx, deadline, observation, idemp)
            .await?
            .unwrap_or(ExternalObservationResult::Conflict { current }),
    )
}

impl CanonicalStore {
    /// Record the verified filesystem observation alongside its merged live carrier and snapshot.
    pub async fn commit_intercepted_external_observation(
        &self,
        mut ctx: SpaceContext,
        identity: CommandIdentity,
        preconditions: Preconditions,
        input: ExternalObservation,
        settlement: RoomCommandSettlement,
    ) -> Result<ExternalObservationResult, PortError> {
        let deadline = CommandDeadline::start(&ctx.budget, "observation_room");
        let active_op = self.enter_write_op(&ctx.scope().space_id)?;
        let request = Mutation {
            identity,
            preconditions,
            input,
        };
        validate_mutation_identity(&ctx, &request.identity)?;
        let idemp = external_observation_identity(&ctx, &request);
        if let Some(replayed) =
            replay_external_observation(self, &ctx, deadline, &request.input, &idemp).await?
        {
            return Ok(replayed);
        }
        let work =
            match prepare_room_command(self, &mut ctx, deadline, &request.input.note, settlement)
                .await
            {
                Ok(work) => work,
                Err(error) => return observation_error(error),
            };
        if work.head.head_rev_id != request.input.base_revision {
            return Ok(ExternalObservationResult::Conflict {
                current: work.head.head_rev_id,
            });
        }
        let (observed_bytes, verified_plan) = match &request.input.content {
            ObservedContent::Carrier(carrier) => {
                check_observed_digest(carrier, request.input.observed_digest)?;
                (carrier.len() as u64, None)
            }
            ObservedContent::Planned(plan) => {
                let carrier = notarium_syntax::patch::apply(&work.base_carrier, plan)?;
                check_observed_digest(&carrier, request.input.observed_digest)?;
                (
                    carrier.len() as u64,
                    Some(observation_plan_fingerprint(plan)),
                )
            }
        };
        let (info, ticket) = work.stage_carrier(self, &ctx.budget, deadline).await?;
        let intent = build_observation_intent(
            self,
            &ctx,
            &work.space,
            request,
            idemp,
            info,
            ticket,
            observed_bytes,
            verified_plan,
            Some(CarrierRoomWrite::Accepted(work.transition)),
        );
        match self
            .submit_write_command_until::<StoredExternalObsOutcomeV1>(
                &ctx.budget,
                deadline.at,
                intent,
                None,
                None,
                Some(active_op),
            )
            .await
        {
            Ok(outcome) => Ok(external_observation_result(outcome)),
            Err(error) => observation_error(error),
        }
    }
}

pub(crate) async fn accept_external_observation_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<ExternalObservation>,
) -> Result<ExternalObservationResult, PortError> {
    let deadline =
        super::common::CommandDeadline::start(&ctx.budget, "accept_external_observation");
    let budget = ctx.budget.clone();
    validate_mutation_identity(&ctx, &request.identity)?;
    let idemp = external_observation_identity(&ctx, &request);

    if let Some(replayed) =
        replay_external_observation(store, &ctx, deadline, &request.input, &idemp).await?
    {
        return Ok(replayed);
    }

    let current = current_observation_head(store, &mut ctx, &request, &deadline).await;
    let (space_rec, base_head) = match current {
        Ok(head) => head,
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. })) => {
            return replay_observation_or_conflict(
                store,
                &ctx,
                deadline,
                &request.input,
                &idemp,
                current,
            )
            .await;
        }
        Err(error) => return observation_error(error),
    };

    if base_head.head_rev_id != request.input.base_revision {
        return replay_observation_or_conflict(
            store,
            &ctx,
            deadline,
            &request.input,
            &idemp,
            base_head.head_rev_id,
        )
        .await;
    }
    let same_digest = base_head.content_digest == Some(request.input.observed_digest);
    if let ObservedContent::Carrier(carrier) = &request.input.content {
        check_observed_digest(carrier, request.input.observed_digest)?;
        if same_digest {
            deadline.remaining(&budget)?;
            return Ok(ExternalObservationResult::NoChange {
                revision: base_head.head_rev_id,
            });
        }
    }

    let base_digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed("obs_missing_digest", "active note lacks content_blake3")
    })?;
    let raw_bytes = deadline
        .wait(&budget, || {
            store.read_verified_blob(&space_rec.scope, base_digest)
        })
        .await??;
    let base_carrier = String::from_utf8(raw_bytes)
        .map_err(|_| internal_not_committed("obs_corrupt_utf8", "carrier not valid UTF-8"))?;

    let (new_carrier, verified_plan) = match &request.input.content {
        ObservedContent::Carrier(carrier) => (carrier.clone(), None),
        ObservedContent::Planned(plan) => {
            let carrier = notarium_syntax::patch::apply(&base_carrier, plan)?;
            check_observed_digest(&carrier, request.input.observed_digest)?;
            if same_digest {
                #[cfg(feature = "test-support")]
                {
                    let pause = store
                        .writer_faults()?
                        .planned_observation_pause_once
                        .lock()
                        .expect("planned observation test pause")
                        .take();
                    if let Some(pause) = pause {
                        deadline
                            .wait(&budget, || async {
                                let _ = pause.entered.send(());
                                let _ = pause.release.await;
                            })
                            .await?;
                    }
                }
                let current =
                    match current_observation_head(store, &mut ctx, &request, &deadline).await {
                        Ok((_, head)) => head.head_rev_id,
                        Err(PortError::Domain(DomainError::RevisionConflict {
                            current, ..
                        })) => current,
                        Err(error) => return observation_error(error),
                    };
                if current == base_head.head_rev_id {
                    return Ok(ExternalObservationResult::NoChange { revision: current });
                }
                return replay_observation_or_conflict(
                    store,
                    &ctx,
                    deadline,
                    &request.input,
                    &idemp,
                    current,
                )
                .await;
            }
            (carrier, Some(observation_plan_fingerprint(plan)))
        }
    };
    let preparsed_hdr = if base_head.doc_class != DocClass::EncryptedNote {
        enforce_protected_frontmatter_unchanged_with_header(
            &base_carrier,
            &new_carrier,
            base_head.doc_class,
        )?
    } else {
        None
    };

    let mut reservation_opt = None;
    if let Some(interceptor) = store.inner.collab_interceptor.get()
        && base_head.doc_class == DocClass::UserDoc
    {
        if let Some(res) = interceptor.try_closed_room_reservation(
            ctx.scope(),
            &request.input.note,
            &request.identity,
        ) {
            reservation_opt = Some(CarrierRoomWrite::Reserved(res));
        } else {
            let (body_plan, header_mut) = match &request.input.content {
                ObservedContent::Planned(plan) => build_collab_edit_payload(
                    &request.input.note,
                    &base_carrier,
                    &new_carrier,
                    plan,
                    base_head.doc_class,
                    &base_head.head_rev_id,
                )?,
                ObservedContent::Carrier(_) => {
                    let old_body =
                        notarium_syntax::frontmatter::analyze(&base_carrier, base_head.doc_class)?
                            .carrier
                            .body;
                    let new_body =
                        notarium_syntax::frontmatter::analyze(&new_carrier, base_head.doc_class)?
                            .carrier
                            .body;
                    let plan = notarium_syntax::patch::plan(
                        &base_carrier,
                        old_body,
                        vec![(
                            CarrierEditOrigin::Body,
                            old_body,
                            new_body.slice(&new_carrier)?.to_owned(),
                        )],
                    )?;
                    let (body_id, header_id) =
                        derive_body_header_identities(&base_head.head_rev_id);
                    (
                        notarium_syntax::patch::body_plan(&base_carrier, &plan, body_id)?,
                        collab_raw_header(
                            &base_carrier,
                            &new_carrier,
                            base_head.doc_class,
                            header_id,
                        )?,
                    )
                }
            };
            ctx.budget.remaining = deadline.remaining(&budget)?;
            let unknown = || {
                crate::codec::unknown_commit_outcome(
                    "observation_room_outcome_unknown",
                    "the room may have applied the external observation",
                )
            };
            // A ready reply can distinguish a confirmed non-write from a lost room response.
            let reply = tokio::select! {
                biased;
                result = interceptor.intercept(InterceptedMutation {
                    context: ctx.clone(),
                    identity: request.identity.clone(),
                    preconditions: request.preconditions.clone(),
                    payload: InterceptedPayload::ExternalObservation {
                        observation: request.input.clone(), body: body_plan, header: header_mut,
                    },
                }) => result?,
                () = budget.cancellation.cancelled() => return Err(unknown()),
                () = tokio::time::sleep_until(deadline.at) => return Err(unknown()),
            };
            match reply {
                InterceptionResult::Applied(outcome) => match *outcome {
                    InterceptedOutcome::ExternalObservation(outcome) => match &outcome {
                        ExternalObservationResult::Committed(committed)
                            if committed.value.note == request.input.note
                                && committed.receipt.scope() == ctx.scope() =>
                        {
                            return Ok(outcome);
                        }
                        ExternalObservationResult::Committed(_) => {
                            return Err(missing_applied_outcome());
                        }
                        _ => return Ok(outcome),
                    },
                    _ => return Err(missing_applied_outcome()),
                },
                InterceptionResult::Conflict(DomainError::RevisionConflict { .. }) => {
                    if let Some(replayed) =
                        replay_external_observation(store, &ctx, deadline, &request.input, &idemp)
                            .await?
                    {
                        return Ok(replayed);
                    }
                    let current = match current_observation_head(
                        store, &mut ctx, &request, &deadline,
                    )
                    .await
                    {
                        Ok((_, head)) => head.head_rev_id,
                        Err(PortError::Domain(DomainError::RevisionConflict {
                            current, ..
                        })) => current,
                        Err(error) => return observation_error(error),
                    };
                    return replay_observation_or_conflict(
                        store,
                        &ctx,
                        deadline,
                        &request.input,
                        &idemp,
                        current,
                    )
                    .await;
                }
                InterceptionResult::Conflict(other) => return observation_error(other.into()),
                InterceptionResult::ClosedRoomReservation(res) => {
                    reservation_opt = Some(CarrierRoomWrite::Reserved(res));
                }
            }
        }
    }

    let info = analyze_and_prepare_carrier_opt_preparsed(
        &new_carrier,
        base_head.doc_class,
        &request.input.note,
        &base_head.slug,
        store.blob_codec(),
        preparsed_hdr,
    )?;
    let ticket = deadline
        .wait(&budget, || {
            store.stage_blob_for_batch(
                &space_rec.scope,
                space_rec.active_epoch,
                &info.prepared_blob,
            )
        })
        .await??;

    let intent = build_observation_intent(
        store,
        &ctx,
        &space_rec,
        request,
        idemp,
        info,
        ticket,
        new_carrier.len() as u64,
        verified_plan,
        reservation_opt,
    );
    ctx.budget.remaining = deadline.remaining(&budget)?;
    match deadline
        .submit::<StoredExternalObsOutcomeV1>(store, &ctx.budget, intent)
        .await
    {
        Ok(outcome) => Ok(external_observation_result(outcome)),
        Err(error) => observation_error(error),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_observation_intent(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    space_rec: &crate::SpaceRecord,
    request: Mutation<ExternalObservation>,
    idemp: crate::writer::CommandIdentitySpec,
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
    observed_bytes: u64,
    verified_plan: Option<ContentDigest>,
    reservation_opt: Option<CarrierRoomWrite>,
) -> PreparedWriteIntent {
    let scope_cl = space_rec.scope.clone();
    let staged_bytes = ticket.compressed_size;
    let auth = ctx.auth().clone();
    let Mutation {
        identity,
        preconditions,
        input: obs_input,
    } = request;
    let room_store = store.clone();

    PreparedWriteIntent {
        scope: scope_cl.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: vec![obs_input.note.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &obs_input.note).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;

                let room = prepare_carrier_room_tx(
                    tx,
                    item_ctx,
                    &room_store.inner.room_fences,
                    reservation_opt,
                    &identity,
                    &obs_input.note,
                )
                .await?;
                if head.head_rev_id != obs_input.base_revision {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(
                    tx,
                    &scope_cl.space_id,
                    &obs_input.note,
                    &preconditions,
                )
                .await?;

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: obs_input.note.as_str().to_owned(),
                        owner_rev_id: new_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;

                let room_grant =
                    matches!(&room, CarrierRoomCommit::Accepted(_)).then(|| auth.grant().clone());
                room.commit(
                    tx,
                    item_ctx,
                    &room_store,
                    &obs_input.note,
                    &head.head_rev_id,
                    &new_rev,
                    seq,
                )
                .await?;
                let rel_path = if anc.folder_path.is_empty() {
                    format!("{}.md", head.slug)
                } else {
                    format!("{}/{}.md", anc.folder_path, head.slug)
                };

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = ?, title_fold = ?, head_rev_id = ?, content_blake3 = ?,
                                 byte_size = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                 last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(obs_input.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_obs_head", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO materialized_observations (
                                space_id, note_id, rel_path, inode, mtime_ns, byte_size,
                                blake3_hash, disk_identity, observed_revision, applied_seq
                             ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
                             ON CONFLICT (space_id, note_id, rel_path) DO UPDATE SET
                                byte_size = excluded.byte_size,
                                blake3_hash = excluded.blake3_hash,
                                disk_identity = excluded.disk_identity,
                                observed_revision = excluded.observed_revision,
                                applied_seq = excluded.applied_seq",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(obs_input.note.as_str())
                        .bind(&rel_path)
                        .bind(observed_bytes as i64)
                        .bind(obs_input.observed_digest.as_bytes().as_slice())
                        .bind(obs_input.disk_identity.as_bytes().as_slice())
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_obs_upsert", err.to_string())
                        })?;

                        sqlx::query(
                            "INSERT OR IGNORE INTO payload_owners (
                                space_id, payload_kind, payload_id, note_id
                             ) VALUES (?, 'materialized_observation', ?, ?)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(&rel_path)
                        .bind(obs_input.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_obs_owner", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = $1, title_fold = $2, head_rev_id = $3, content_blake3 = $4,
                                 byte_size = $5, updated_seq = $6, updated_at_sec = $7, updated_at_nsec = $8,
                                 last_actor_id = $9
                             WHERE space_id = $10 AND note_id = $11",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(obs_input.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_obs_head", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO materialized_observations (
                                space_id, note_id, rel_path, inode, mtime_ns, byte_size,
                                blake3_hash, disk_identity, observed_revision, applied_seq
                             ) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, $8)
                             ON CONFLICT (space_id, note_id, rel_path) DO UPDATE SET
                                byte_size = EXCLUDED.byte_size,
                                blake3_hash = EXCLUDED.blake3_hash,
                                disk_identity = EXCLUDED.disk_identity,
                                observed_revision = EXCLUDED.observed_revision,
                                applied_seq = EXCLUDED.applied_seq",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(obs_input.note.as_str())
                        .bind(&rel_path)
                        .bind(observed_bytes as i64)
                        .bind(obs_input.observed_digest.as_bytes().as_slice())
                        .bind(obs_input.disk_identity.as_bytes().as_slice())
                        .bind(new_rev.as_str())
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_obs_upsert", err.to_string()))?;

                        sqlx::query(
                            "INSERT INTO payload_owners (
                                space_id, payload_kind, payload_id, note_id
                             ) VALUES ($1, 'materialized_observation', $2, $3)
                             ON CONFLICT DO NOTHING",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(&rel_path)
                        .bind(obs_input.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_obs_owner", err.to_string()))?;
                    }
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = if head.doc_class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else {
                    evaluate_fields_with_schema(
                        info.raw_fields.as_ref(),
                        info.diagnostics.first(),
                        current_schema.as_ref().map(|s| &s.fields),
                    )
                };
                let run_opt = extract_agent_run_from_auth(&auth);
                let changed_fields =
                    changed_revision_fields_tx(tx, &scope_cl, &head.head_rev_id, &eval_fields)
                        .await?;
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: anc.cover_note.as_ref() == Some(&obs_input.note),
                        note_id: obs_input.note.clone(),
                        parent_folder_id: head.parent_folder_id,
                        is_root_child: anc.is_root_child,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: info.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    obs_input.note.as_str(),
                    seq,
                    seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "accept_external_observation",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: obs_input.note.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        }],
                    },
                    vec![obs_input.note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let mut stored_resp = StoredExternalObsOutcomeV1::Committed {
                    result: StoredCommittedNoteRevV1 {
                        value: NoteRevision {
                            note: obs_input.note.clone(),
                            revision: new_rev.clone(),
                        },
                        receipt,
                    },
                    verified_plan,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;
                let detail = room_receipt_detail(room_grant.as_ref(), &stored_resp)?
                    .or_else(|| verified_plan.map(|_| resp_bytes.clone()));
                let sanitized = if let StoredExternalObsOutcomeV1::Committed {
                    verified_plan: plan @ Some(_),
                    ..
                } = &mut stored_resp
                {
                    *plan = None;
                    CanonicalStore::encode_command_outcome(&stored_resp)?
                } else {
                    resp_bytes.clone()
                };

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "accept_external_observation".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: obs_input.note.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: detail,
                    receipt_sanitized_blob: sanitized,
                    receipt_owner_note_ids: vec![obs_input.note],
                    response_bytes: resp_bytes,
                })
            })
        }),
    }
}

/// Convert a revision conflict from an authorized canonical read or write.
fn observation_error(error: PortError) -> Result<ExternalObservationResult, PortError> {
    match error {
        PortError::Domain(DomainError::RevisionConflict { current, .. }) => {
            Ok(ExternalObservationResult::Conflict { current })
        }
        other => Err(other),
    }
}

async fn authorize_schema_placement_tx(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    note: &NoteId,
    destination: &notarium_core::ids::FolderId,
) -> Result<
    (
        Option<crate::domain::common::NoteHeadRow>,
        crate::domain::common::FolderAncestryFacts,
        bool,
    ),
    PortError,
> {
    crate::writer::replay::authorize_schema_space(auth, &space.space)?;
    let (after, anc) =
        build_resource_facts_tx(tx, &space.space, destination, DocClass::UserDoc, None, true)
            .await?;
    let head = load_note_head_row_opt_tx(tx, &space.space.id, note).await?;
    let is_cover = if let Some(head) = &head {
        let (before, source) = build_resource_facts_tx(
            tx,
            &space.space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id.clone(),
            true,
        )
        .await?;
        auth.authorize_direct_write(&before, &after)?;
        source.cover_note.as_ref() == Some(note)
    } else {
        auth.authorize_direct_write(&after, &after)?;
        false
    };
    Ok((head, anc, is_cover))
}

pub(crate) async fn update_space_schema_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<UpdateSpaceSchema>,
) -> Result<Committed<SpaceSchemaRevision>, PortError> {
    let deadline =
        crate::domain::common::CommandDeadline::start(&ctx.budget, "update_space_schema");
    validate_mutation_identity(&ctx, &request.identity)?;
    let slug_fold = normalize_slug_key(&request.input.slug)?;
    for field_key in request.input.schema.keys() {
        authorize_field_key(field_key)?;
    }

    let (descriptor_msgpack, descriptor_fp) =
        schema_descriptor_bytes_and_fingerprint(&request.input.schema)?;
    let info = analyze_and_prepare_carrier(
        &request.input.carrier,
        DocClass::UserDoc,
        &request.input.schema_note,
        &request.input.slug,
        store.blob_codec(),
    )?;

    let admission = ctx.clone();
    let schema_note = request.input.schema_note.clone();
    let destination = request.input.parent.clone();
    let read_placement = || {
        store.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &admission.scope().space_id).await?;
                srec.scope.check(admission.scope())?;
                authorize_schema_placement_tx(
                    tx,
                    &srec,
                    admission.auth(),
                    &schema_note,
                    destination.as_ref().unwrap_or(&srec.root_folder_id),
                )
                .await?;
                Ok(srec)
            })
        })
    };
    let space_rec = deadline.prepare(&ctx.budget, read_placement).await?;

    let ticket = deadline
        .prepare(&ctx.budget, || {
            store.stage_blob_for_batch(
                &space_rec.scope,
                space_rec.active_epoch,
                &info.prepared_blob,
            )
        })
        .await?;
    let staged_bytes = ticket.compressed_size;

    let mut fp_hasher = blake3::Hasher::new();
    fp_hasher.update(request.input.schema_note.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(descriptor_fp.as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(info.prepared_blob.digest.as_bytes());
    let idemp = derive_command_identity_spec(
        &ctx,
        &request.identity,
        "update_space_schema",
        fp_hasher.finalize().as_bytes(),
    )
    .with_preconditions(
        &request.preconditions,
        "note",
        request.input.schema_note.as_str(),
    )
    .with_schema_placement(
        request
            .input
            .parent
            .as_ref()
            .unwrap_or(&space_rec.root_folder_id),
        &request.input.slug,
        request.input.expected_schema_revision.as_ref(),
    )
    .with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::Schema(vec![
            crate::writer::replay::ReplayResource::Create(
                request.input.schema_note.clone(),
                request.input.parent.clone(),
                DocClass::UserDoc,
            ),
        ]),
    );

    let scope_cl = space_rec.scope.clone();
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input;

    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let schema_identity = request.identity;
    let intent = PreparedWriteIntent {
        scope: scope_cl.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: vec![input.schema_note.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let parent_id = input
                    .parent
                    .clone()
                    .unwrap_or_else(|| item_ctx.root_folder_id.clone());
                let (existing_note, anc, folder_page) = authorize_schema_placement_tx(
                    tx,
                    &live_space,
                    &auth,
                    &input.schema_note,
                    &parent_id,
                )
                .await?;

                if let Some(head) = &existing_note {
                    super::folder_cover::validate_slug_change(
                        &head.slug_fold,
                        &slug_fold,
                        &input.slug,
                        folder_page,
                    )?;
                    if folder_page && head.parent_folder_id != parent_id {
                        return Err(DomainError::validation(
                            ValidationReason::InvalidPathComponent,
                        )
                        .into());
                    }
                } else {
                    super::folder_cover::validate_new_slug(&input.slug, false)?;
                }

                if existing_note.is_none() && preconditions.revision.is_some() {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (mut guard, reservation) = room_fences
                    .try_lock_closed_for_rollback(&scope_cl, &input.schema_note, &schema_identity)
                    .await?
                    .ok_or_else(|| {
                        unavailable_retryable(
                            "collab_room_not_closed",
                            "schema note has an active collaborative room",
                            std::time::Duration::from_millis(50),
                        )
                    })?;
                guard.consume(reservation, &schema_identity)?;
                item_ctx.retain_until_batch_commit(guard);
                let has_closed_room = crate::domain::common::durable_note_room_state_tx(
                    tx,
                    &scope_cl.space_id,
                    &input.schema_note,
                )
                .await?
                .require_writable()?;
                check_collab_preconditions_tx(
                    tx,
                    &scope_cl.space_id,
                    &input.schema_note,
                    &preconditions,
                )
                .await?;
                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                match (&current_schema, &input.expected_schema_revision) {
                    (Some(cur), exp_opt) if exp_opt.as_ref() != Some(&cur.schema_revision) => {
                        return Err(DomainError::RevisionConflict {
                            current: cur.schema_revision.clone(),
                            lineage: None,
                        }
                        .into());
                    }
                    (None, Some(unexpected)) => {
                        return Err(DomainError::RevisionConflict {
                            current: unexpected.clone(),
                            lineage: None,
                        }
                        .into());
                    }
                    _ => {}
                }

                if let Some(ex) = &existing_note {
                    if ex.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if ex.doc_class != DocClass::UserDoc {
                        return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
                    }
                    if let Some(prec_rev) = &preconditions.revision
                        && *prec_rev != ex.head_rev_id
                    {
                        return Err(DomainError::RevisionConflict {
                            current: ex.head_rev_id.clone(),
                            lineage: None,
                        }
                        .into());
                    }
                } else if active_note_sibling_exists_tx(
                    tx,
                    &scope_cl.space_id,
                    &parent_id,
                    &slug_fold,
                    None,
                )
                .await?
                {
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope_cl.space_id.clone(),
                            parent: input.parent.clone(),
                            component: input.slug.clone(),
                        },
                    }
                    .into());
                }

                let seq = item_ctx.alloc_next_seq()?;
                let note_rev = new_revision_id()?;
                let schema_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: input.schema_note.as_str().to_owned(),
                        owner_rev_id: note_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;

                let op_kind = if let Some(ex) = &existing_note {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE note_heads
                                 SET parent_folder_id = ?, slug = ?, slug_fold = ?, title = ?,
                                     title_fold = ?, head_rev_id = ?, content_blake3 = ?, byte_size = ?,
                                     updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                                 WHERE space_id = ? AND note_id = ?",
                            )
                            .bind(parent_id.as_str())
                            .bind(&input.slug)
                            .bind(&slug_fold)
                            .bind(&info.title)
                            .bind(&info.title_fold)
                            .bind(note_rev.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .bind(info.byte_size as i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(auth.principal().as_str())
                            .bind(scope_cl.space_id.as_str())
                            .bind(input.schema_note.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_upd_schema_note", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE note_heads
                                 SET parent_folder_id = $1, slug = $2, slug_fold = $3, title = $4,
                                     title_fold = $5, head_rev_id = $6, content_blake3 = $7, byte_size = $8,
                                     updated_seq = $9, updated_at_sec = $10, updated_at_nsec = $11, last_actor_id = $12
                                 WHERE space_id = $13 AND note_id = $14",
                            )
                            .bind(parent_id.as_str())
                            .bind(&input.slug)
                            .bind(&slug_fold)
                            .bind(&info.title)
                            .bind(&info.title_fold)
                            .bind(note_rev.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .bind(info.byte_size as i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(auth.principal().as_str())
                            .bind(scope_cl.space_id.as_str())
                            .bind(input.schema_note.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_upd_schema_note", err.to_string())
                            })?;
                        }
                    }
                    if ex.parent_folder_id != parent_id {
                        "move"
                    } else {
                        "edit"
                    }
                } else {
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "INSERT INTO note_heads (
                                    space_id, note_id, parent_folder_id, slug, slug_fold,
                                    title, title_fold, doc_class, ability_id, head_rev_id,
                                    content_blake3, byte_size, lifecycle_state, visibility_mask,
                                    settlement_successor_id, created_seq, updated_seq,
                                    created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user-doc', NULL, ?, ?, ?, 'active', 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
                            )
                            .bind(scope_cl.space_id.as_str())
                            .bind(input.schema_note.as_str())
                            .bind(parent_id.as_str())
                            .bind(&input.slug)
                            .bind(&slug_fold)
                            .bind(&info.title)
                            .bind(&info.title_fold)
                            .bind(note_rev.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .bind(info.byte_size as i64)
                            .bind(seq_i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(sec)
                            .bind(nsec)
                            .bind(auth.principal().as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_ins_schema_note", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "INSERT INTO note_heads (
                                    space_id, note_id, parent_folder_id, slug, slug_fold,
                                    title, title_fold, doc_class, ability_id, head_rev_id,
                                    content_blake3, byte_size, lifecycle_state, visibility_mask,
                                    settlement_successor_id, created_seq, updated_seq,
                                    created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'user-doc', NULL, $8, $9, $10, 'active', 0, NULL, $11, $11, $12, $13, $12, $13, $14)",
                            )
                            .bind(scope_cl.space_id.as_str())
                            .bind(input.schema_note.as_str())
                            .bind(parent_id.as_str())
                            .bind(&input.slug)
                            .bind(&slug_fold)
                            .bind(&info.title)
                            .bind(&info.title_fold)
                            .bind(note_rev.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .bind(info.byte_size as i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(auth.principal().as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_ins_schema_note", err.to_string())
                            })?;
                        }
                    }
                    "create"
                };

                if has_closed_room {
                    crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
                        tx,
                        &scope_cl.space_id,
                        &input.schema_note,
                        &note_rev,
                        seq,
                    )
                    .await?;
                }
                // Atomically flip `space_field_schemas` current head!
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE space_field_schemas SET is_current = 0
                             WHERE space_id = ? AND is_current = 1",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_clear_cur_schema", err.to_string())
                        })?;

                        sqlx::query(
                            "INSERT INTO space_field_schemas (
                                space_id, schema_rev_id, schema_note_id, is_current,
                                descriptor_msgpack, descriptor_fingerprint, created_seq,
                                visibility_seq, created_at_sec, created_at_nsec
                             ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(schema_rev.as_str())
                        .bind(input.schema_note.as_str())
                        .bind(&descriptor_msgpack)
                        .bind(descriptor_fp.as_bytes().as_slice())
                        .bind(seq_i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_ins_space_schema", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE space_field_schemas SET is_current = 0
                             WHERE space_id = $1 AND is_current = 1",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_clear_cur_schema", err.to_string())
                        })?;

                        sqlx::query(
                            "INSERT INTO space_field_schemas (
                                space_id, schema_rev_id, schema_note_id, is_current,
                                descriptor_msgpack, descriptor_fingerprint, created_seq,
                                visibility_seq, created_at_sec, created_at_nsec
                             ) VALUES ($1, $2, $3, 1, $4, $5, $6, $6, $7, $8)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(schema_rev.as_str())
                        .bind(input.schema_note.as_str())
                        .bind(&descriptor_msgpack)
                        .bind(descriptor_fp.as_bytes().as_slice())
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_ins_space_schema", err.to_string())
                        })?;
                    }
                }

                let eval_fields = evaluate_fields_with_schema(
                    info.raw_fields.as_ref(),
                    info.diagnostics.first(),
                    Some(&input.schema),
                );
                let run_opt = extract_agent_run_from_auth(&auth);
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page,
                        note_id: input.schema_note.clone(),
                        parent_folder_id: parent_id,
                        is_root_child: anc.is_root_child,
                        slug: input.slug,
                        slug_fold,
                        title: info.title,
                        doc_class: DocClass::UserDoc,
                        ability_id: None,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: 0,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: Some(schema_rev.clone()),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &note_rev,
                    "note",
                    input.schema_note.as_str(),
                    seq,
                    seq,
                    existing_note.as_ref().map(|e| &e.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope_cl,
                        run_id,
                        auth.principal(),
                        seq,
                        seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl.clone(),
                    range,
                    "update_space_schema",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::Structural,
                    },
                    vec![input.schema_note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredCommittedSchemaRevV1 {
                    value: SpaceSchemaRevision {
                        schema_revision: schema_rev,
                        schema_note: input.schema_note.clone(),
                        note_revision: note_rev.clone(),
                        descriptor_fingerprint: descriptor_fp,
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "update_space_schema".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: input.schema_note.as_str().to_owned(),
                        op_kind: op_kind.to_owned(),
                        rev_id: note_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(DocClass::UserDoc),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![input.schema_note],
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedSchemaRevV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(super) async fn get_note_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: GetNote,
    deadline: &super::common::CommandDeadline,
) -> Result<NoteSnapshot, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let req_note = request.note.clone();
    let req_rev_opt = request.revision.clone();
    let causal = request.causal.clone();

    let started = store.is_postgres().then(std::time::Instant::now);
    let record_failure = |phase: &'static str, error: PortError| {
        if let Some(started) = started
            && matches!(error, PortError::DeadlineExceeded(_))
        {
            tracing::warn!(
                phase,
                elapsed_us = started.elapsed().as_micros() as u64,
                "PostgreSQL note read reached its deadline"
            );
        }
        error
    };
    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let store_in = store.clone();
    let (
        rev_id,
        live_facts,
        lifecycle,
        digest,
        parent_opt,
        byte_size,
        fields,
        diagnostics,
        provenance,
        fast_local_read,
    ) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                // Validate causal basis watermarks/receipts against canonical Space history!
                let required_seq = match &causal {
                    CausalBasis::Exact(receipts) => {
                        let mut max_s = SpaceSeq::ZERO;
                        for r in receipts.for_scope(&scope)? {
                            match tx {
                                BackendConn::Postgres(_) => {
                                    // The Space scope and last_seq are already in this snapshot.
                                    crate::runtime::require_command_end_tx(tx, &scope, r.seq()).await?;
                                }
                                BackendConn::Sqlite(_) => {
                                    validate_snapshot_cutoff_tx(tx, &scope, Some(r.seq())).await?;
                                }
                            }
                            max_s = max_s.max(r.seq());
                        }
                        max_s
                    }
                    CausalBasis::Await(wm) => {
                        let s = wm.required(&scope)?;
                        if s > space_rec.last_seq {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidCutoff).into()
                            );
                        }
                        s
                    }
                };
                if required_seq > space_rec.last_seq {
                    return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                }

                if is_note_purge_fenced_tx(tx, &scope.space_id, req_note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let live_head = load_note_head_row_tx(tx, &scope.space_id, &req_note).await?;
                if live_head.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }

                // Always enforce CURRENT LIVE canonical ResourceFacts (including class/folder/lock changes)!
                let (live_facts, live_ancestry) = build_resource_facts_tx(
                    tx,
                    &space_rec.space,
                    &live_head.parent_folder_id,
                    live_head.doc_class,
                    live_head.ability_id.clone(),
                    false,
                )
                .await?;
                auth.authorize_read(&live_facts)?;

                let historical = req_rev_opt.is_some();
                let target_rev_id = req_rev_opt.unwrap_or_else(|| live_head.head_rev_id.clone());
                let revision: Option<(Vec<u8>, i64, String, i64, i32)> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(
                        "SELECT metadata_msgpack, visibility_seq, actor_id, created_at_sec, created_at_nsec FROM revisions
                         WHERE space_id = ? AND rev_id = ? AND entity_type = 'note' AND entity_key = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(target_rev_id.as_str())
                    .bind(req_note.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_get_note_rev", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_as(
                        "SELECT metadata_msgpack, visibility_seq, actor_id, created_at_sec, created_at_nsec FROM revisions
                         WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(target_rev_id.as_str())
                    .bind(req_note.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_get_note_rev", err))?,
                };

                let Some((raw_meta, visibility_seq, actor, seconds, nanos)) = revision else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                let env = RevisionMetadataEnvelope::decode(&raw_meta)?;
                let RevisionMetadataPayload::Note(nm) = env.payload else {
                    return Err(internal_not_committed(
                        "corrupt_note_rev_payload",
                        "expected Note metadata payload",
                    ));
                };
                if nm.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let digest = nm.content_digest.ok_or_else(|| {
                    internal_not_committed("note_rev_missing_digest", "note revision lacks digest")
                })?;
                let (facts, ancestry) = if historical {
                    let cutoff = crate::codec::i64_to_space_seq(visibility_seq)?;
                    let (facts, ancestry) = FolderAncestryCache::at_cut(&scope, cutoff)
                        .build_resource_facts_tx(tx, &space_rec.space, &nm.parent_folder_id,
                            nm.doc_class, nm.ability_id.clone(), false).await?;
                    auth.authorize_read(&facts)?;
                    (facts, ancestry)
                } else {
                    (live_facts, live_ancestry)
                };
                let provenance = ancestry.note_provenance(
                    &req_note, &nm.slug, nm.title, notarium_core::ids::PrincipalId::parse(&actor)?,
                    crate::codec::decode_timestamp_parts(seconds, nanos)?,
                );
                let parent_opt = (nm.parent_folder_id != space_rec.root_folder_id).then_some(nm.parent_folder_id);
                let effective_lc = if target_rev_id == live_head.head_rev_id {
                    live_head.lifecycle
                } else {
                    nm.lifecycle
                };

                // Re-evaluate against live Space schema if reading live head!
                let fields: BTreeMap<String, FieldObservation<FieldValue>> =
                    if live_head.doc_class == DocClass::EncryptedNote {
                        BTreeMap::new()
                    } else if target_rev_id == live_head.head_rev_id {
                        let cur_schema = load_current_space_schema_tx(tx, &scope.space_id).await?;
                        evaluate_fields_with_schema(
                            nm.raw_fields.as_ref(),
                            nm.diagnostics.first(),
                            cur_schema.as_ref().map(|s| &s.fields),
                        )
                    } else {
                        nm.evaluated_fields
                    };

                let fast_local_read = store_in
                    .try_prepare_local_blob_read_in_tx(tx, &scope.space_id, digest)
                    .await?;

                Ok((
                    target_rev_id,
                    facts,
                    effective_lc,
                    digest,
                    parent_opt,
                    nm.byte_size,
                    fields,
                    nm.diagnostics,
                    provenance,
                    fast_local_read,
                ))
            })
        })
        .await.map_err(|err| record_failure("revision_and_authorization", err))?;

    let raw_bytes = match fast_local_read {
        Some(plan) => plan.read_verified_async().await,
        None => store.read_verified_blob(ctx.scope(), digest).await,
    }
    .map_err(|err| record_failure("blob", err))?;
    let content = String::from_utf8(raw_bytes)
        .map_err(|_| internal_not_committed("get_note_utf8", "note carrier is not valid UTF-8"))?;

    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let (current, live_lifecycle) = recheck_note_read(store, &ctx, &request.note, false)
        .await
        .map_err(|err| record_failure("current_authorization", err))?;
    if request.revision.is_none()
        && (current.class != live_facts.class || current.project != live_facts.project)
    {
        return Err(DomainError::ResourceNotFound.into());
    }

    let mut document = ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: ctx.scope().space_id.clone(),
            note_id: request.note,
        },
        rev_id,
        live_facts,
        lifecycle,
        content,
        digest,
    )?;
    document.bind_current(current, live_lifecycle)?;

    deadline.remaining(&ctx.budget)?;
    Ok(NoteSnapshot {
        document,
        parent: parent_opt,
        byte_size,
        fields,
        diagnostics,
        provenance: Some(provenance),
    })
}

pub(super) async fn get_note_metadata_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: GetNote,
    deadline: &super::common::CommandDeadline,
) -> Result<notarium_core::ports::NoteMetadataSnapshot, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let req_note = request.note.clone();
    let req_rev_opt = request.revision.clone();
    let causal = request.causal.clone();

    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
    let (
        rev_id,
        recorded_facts,
        live_facts,
        recorded_lifecycle,
        live_lifecycle,
        digest,
        parent_opt,
        provenance,
    ) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let required_seq = match &causal {
                    CausalBasis::Exact(receipts) => {
                        let mut max_s = SpaceSeq::ZERO;
                        for r in receipts.for_scope(&scope)? {
                            match tx {
                                BackendConn::Postgres(_) => {
                                    crate::runtime::require_command_end_tx(tx, &scope, r.seq())
                                        .await?;
                                }
                                BackendConn::Sqlite(_) => {
                                    validate_snapshot_cutoff_tx(tx, &scope, Some(r.seq())).await?;
                                }
                            }
                            max_s = max_s.max(r.seq());
                        }
                        max_s
                    }
                    CausalBasis::Await(wm) => {
                        let s = wm.required(&scope)?;
                        if s > space_rec.last_seq {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidCutoff).into(),
                            );
                        }
                        s
                    }
                };
                if required_seq > space_rec.last_seq {
                    return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                }

                if is_note_purge_fenced_tx(tx, &scope.space_id, req_note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let live_head = load_note_head_row_tx(tx, &scope.space_id, &req_note).await?;
                if live_head.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let (live_facts, live_ancestry) = build_resource_facts_tx(
                    tx,
                    &space_rec.space,
                    &live_head.parent_folder_id,
                    live_head.doc_class,
                    live_head.ability_id.clone(),
                    false,
                )
                .await?;
                auth.authorize_read(&live_facts)?;

                let historical = req_rev_opt.is_some();
                let target_rev_id = req_rev_opt.unwrap_or_else(|| live_head.head_rev_id.clone());
                let revision: Option<(Vec<u8>, i64, String, i64, i32)> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(
                        "SELECT metadata_msgpack, visibility_seq, actor_id, created_at_sec, created_at_nsec FROM revisions
                         WHERE space_id = ? AND rev_id = ? AND entity_type = 'note' AND entity_key = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(target_rev_id.as_str())
                    .bind(req_note.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_get_note_meta_rev", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_as(
                        "SELECT metadata_msgpack, visibility_seq, actor_id, created_at_sec, created_at_nsec FROM revisions
                         WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(target_rev_id.as_str())
                    .bind(req_note.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_get_note_meta_rev", err))?,
                };

                let Some((raw_meta, visibility_seq, actor, seconds, nanos)) = revision else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                let env = RevisionMetadataEnvelope::decode(&raw_meta)?;
                let RevisionMetadataPayload::Note(nm) = env.payload else {
                    return Err(internal_not_committed(
                        "corrupt_note_rev_payload",
                        "expected Note metadata payload",
                    ));
                };
                if nm.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let digest = nm.content_digest.ok_or_else(|| {
                    internal_not_committed("note_rev_missing_digest", "note revision lacks digest")
                })?;
                let (recorded_facts, ancestry) = if historical {
                    let cutoff = crate::codec::i64_to_space_seq(visibility_seq)?;
                    let (facts, ancestry) = FolderAncestryCache::at_cut(&scope, cutoff)
                        .build_resource_facts_tx(
                            tx,
                            &space_rec.space,
                            &nm.parent_folder_id,
                            nm.doc_class,
                            nm.ability_id.clone(),
                            false,
                        )
                        .await?;
                    auth.authorize_read(&facts)?;
                    (facts, ancestry)
                } else {
                    (live_facts.clone(), live_ancestry)
                };
                let provenance = ancestry.note_provenance(
                    &req_note,
                    &nm.slug,
                    nm.title,
                    notarium_core::ids::PrincipalId::parse(&actor)?,
                    crate::codec::decode_timestamp_parts(seconds, nanos)?,
                );
                let parent_opt =
                    (nm.parent_folder_id != space_rec.root_folder_id).then_some(nm.parent_folder_id);
                let effective_lc = if target_rev_id == live_head.head_rev_id {
                    live_head.lifecycle
                } else {
                    nm.lifecycle
                };

                Ok((
                    target_rev_id,
                    recorded_facts,
                    live_facts,
                    effective_lc,
                    live_head.lifecycle,
                    digest,
                    parent_opt,
                    provenance,
                ))
            })
        })
        .await?;

    let mut metadata = ClassifiedMetadata::from_canonical(
        NoteRef {
            space_id: ctx.scope().space_id.clone(),
            note_id: request.note,
        },
        rev_id,
        recorded_facts,
        recorded_lifecycle,
        digest,
    )?;
    metadata.bind_current(live_facts, live_lifecycle)?;

    deadline.remaining(&ctx.budget)?;
    Ok(notarium_core::ports::NoteMetadataSnapshot {
        metadata,
        parent: parent_opt,
        provenance: Some(provenance),
    })
}

/// Authorize the current owner and location after immutable CAS bytes have arrived.
pub(crate) async fn recheck_note_read(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    active_only: bool,
) -> Result<(notarium_core::auth::ResourceFacts, Lifecycle), PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let note = note.clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &scope.space_id).await?;
                space.scope.check(&scope)?;
                if space.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let (facts, lifecycle) = FolderAncestryCache::default()
                    .live_note_facts(tx, &space.space, &note, active_only)
                    .await?
                    .ok_or(DomainError::ResourceNotFound)?;
                auth.authorize_read(&facts)?;
                Ok((facts, lifecycle))
            })
        })
        .await
}

pub(crate) async fn is_live_visible_impl(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
) -> Result<bool, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let note_cl = note.clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Ok(false);
                }
                crate::domain::folders::is_note_live_readable_tx(
                    tx,
                    &space_rec.space,
                    &auth,
                    &note_cl,
                )
                .await
            })
        })
        .await
}

pub(crate) async fn hydrate_cards_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    cut: SnapshotCut,
    notes: Vec<NoteId>,
) -> Result<Vec<Option<NoteCard>>, PortError> {
    ctx.scope().check(&cut.scope)?;
    if notes.is_empty() {
        let scope = ctx.scope().clone();
        let cut_seq = cut.canonical_seq;
        store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    let _ = validate_snapshot_cutoff_tx(tx, &scope, Some(cut_seq)).await?;
                    Ok(())
                })
            })
            .await?;
        return Ok(Vec::new());
    }

    #[allow(clippy::type_complexity)]
    let planned_slots: Vec<Option<(NoteId, SearchMetadataPlan)>> = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            let scope = ctx.scope().clone();
            let auth = ctx.auth().clone();
            let cut_seq = cut.canonical_seq;
            let notes_in = notes.clone();
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope.space_id).await?;
                space_rec.scope.check(&scope)?;
                if space_rec.space.lifecycle != SpaceLifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let valid_cut = validate_snapshot_cutoff_tx(tx, &scope, Some(cut_seq)).await?;
                let mut folder_cache = FolderAncestryCache::default();
                let mut historical = FolderAncestryCache::at_cut(&scope, valid_cut);

                let mut out = Vec::with_capacity(notes_in.len());
                for nid in notes_in {
                    if is_note_purge_fenced_tx(tx, &scope.space_id, nid.as_str()).await? {
                        out.push(None);
                        continue;
                    }
                    let Some(live_head) =
                        load_note_head_row_opt_tx(tx, &scope.space_id, &nid).await?
                    else {
                        out.push(None);
                        continue;
                    };
                    if live_head.lifecycle != Lifecycle::Active
                        || live_head.doc_class == DocClass::EncryptedNote
                    {
                        out.push(None);
                        continue;
                    }
                    let Some((live_facts, _)) = super::common::optional_read(
                        folder_cache
                            .build_resource_facts_tx(
                                tx,
                                &space_rec.space,
                                &live_head.parent_folder_id,
                                live_head.doc_class,
                                live_head.ability_id.clone(),
                                true,
                            )
                            .await,
                    )?
                    else {
                        out.push(None);
                        continue;
                    };

                    let Some(historical_note) = super::common::optional_read(
                        crate::projection_read::note_at(tx, &scope, valid_cut, &nid).await,
                    )?
                    .flatten() else {
                        out.push(None);
                        continue;
                    };
                    let nm = historical_note.metadata;
                    if nm.lifecycle != Lifecycle::Active || nm.doc_class == DocClass::EncryptedNote
                    {
                        out.push(None);
                        continue;
                    }
                    let Some(digest) = nm.content_digest else {
                        out.push(None);
                        continue;
                    };

                    if auth.can_view_resource(&live_facts).is_err() {
                        out.push(None);
                        continue;
                    }
                    let Some((snap_facts, ancestors)) = super::common::optional_read(
                        historical
                            .build_resource_facts_tx(
                                tx,
                                &space_rec.space,
                                &nm.parent_folder_id,
                                nm.doc_class,
                                nm.ability_id,
                                true,
                            )
                            .await,
                    )?
                    else {
                        out.push(None);
                        continue;
                    };
                    if auth.authorize_read(&snap_facts).is_err() {
                        out.push(None);
                        continue;
                    }
                    let Ok(cmeta) = ClassifiedMetadata::from_canonical(
                        NoteRef {
                            space_id: scope.space_id.clone(),
                            note_id: nid.clone(),
                        },
                        historical_note.revision_id,
                        snap_facts,
                        Lifecycle::Active,
                        digest,
                    ) else {
                        out.push(None);
                        continue;
                    };
                    let path = if ancestors.folder_path.is_empty() {
                        format!("{}.md", nm.slug)
                    } else {
                        format!("{}/{}.md", ancestors.folder_path, nm.slug)
                    };
                    out.push(Some((
                        nid,
                        SearchMetadataPlan {
                            metadata: cmeta,
                            title: nm.title,
                            path,
                            digest,
                            doc_class: nm.doc_class,
                        },
                    )));
                }
                Ok(out)
            })
        })
        .await?;

    let mut hydrated = Vec::with_capacity(planned_slots.len());
    for slot in planned_slots {
        let Some((nid, mut plan)) = slot else {
            hydrated.push(None);
            continue;
        };
        let Some(raw_bytes) =
            super::common::optional_read(store.read_verified_blob(ctx.scope(), plan.digest).await)?
        else {
            hydrated.push(None);
            continue;
        };
        let Ok(carrier) = String::from_utf8(raw_bytes) else {
            hydrated.push(None);
            continue;
        };
        let (live, lifecycle) = match recheck_note_read(store, &ctx, &nid, true).await {
            Ok(state) => state,
            Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                hydrated.push(None);
                continue;
            }
            Err(err) => return Err(err),
        };
        plan.metadata.bind_current(live, lifecycle)?;
        let Ok(document) = ClassEgressFence::search_metadata(plan.metadata, ctx.auth()) else {
            hydrated.push(None);
            continue;
        };
        let preview = extract_note_preview(&carrier, plan.doc_class);
        hydrated.push(Some(NoteCard {
            document,
            title: plan.title,
            path: plan.path,
            preview,
        }));
    }

    let _ = FolderRef {
        space_id: ctx.scope().space_id.clone(),
        folder_id: notarium_core::ids::FolderId::from_bytes([0u8; 16]),
    };
    Ok(hydrated)
}

struct SearchMetadataPlan {
    metadata: ClassifiedMetadata,
    title: String,
    path: String,
    digest: ContentDigest,
    doc_class: DocClass,
}

enum NoteMutationAccess {
    Current,
    Move(Option<notarium_core::ids::FolderId>),
    Link(LinkTarget),
}

pub(super) async fn authorize_note_placement_tx(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    auth: &notarium_core::auth::EngineAuthContext,
    head: &crate::domain::common::NoteHeadRow,
    destination: &notarium_core::ids::FolderId,
) -> Result<crate::domain::common::FolderAncestryFacts, PortError> {
    let (current, ancestry) = build_resource_facts_tx(
        tx,
        &space.space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id.clone(),
        true,
    )
    .await?;
    if destination == &head.parent_folder_id {
        auth.authorize_direct_write(&current, &current)?;
        return Ok(ancestry);
    }
    let (after, ancestry) = build_resource_facts_tx(
        tx,
        &space.space,
        destination,
        head.doc_class,
        head.ability_id.clone(),
        true,
    )
    .await?;
    auth.authorize_direct_write(&current, &after)?;
    Ok(ancestry)
}

async fn read_active_note_for_mutation(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note_id: &NoteId,
    preconditions: &Preconditions,
    access: NoteMutationAccess,
) -> Result<(crate::SpaceRecord, crate::domain::common::NoteHeadRow), PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let nid = note_id.clone();
    let prec = preconditions.clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                if is_note_purge_fenced_tx(tx, &scope.space_id, nid.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let head = load_note_head_row_tx(tx, &scope.space_id, &nid).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let destination = match &access {
                    NoteMutationAccess::Move(parent) => {
                        parent.as_ref().unwrap_or(&srec.root_folder_id)
                    }
                    _ => &head.parent_folder_id,
                };
                authorize_note_placement_tx(tx, &srec, &auth, &head, destination).await?;
                if let NoteMutationAccess::Link(target) = &access {
                    authorize_link_target_tx(tx, &srec, &auth, head.doc_class, target).await?;
                }
                if let Some(expected_rev) = &prec.revision
                    && *expected_rev != head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope.space_id, &nid, &prec).await?;
                Ok((srec, head))
            })
        })
        .await
}

pub(crate) fn missing_applied_outcome() -> PortError {
    crate::codec::unknown_commit_outcome(
        "interceptor_receipt_mismatch",
        "the applied receipt lacks a matching retained command outcome",
    )
}

pub(crate) async fn try_replay_completed_receipt<R: serde::de::DeserializeOwned>(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    idemp: &crate::writer::CommandIdentitySpec,
    budget: Option<&notarium_core::ports::CallBudget>,
) -> Result<Option<R>, PortError> {
    read_space_and_receipt(store, scope, idemp, budget)
        .await
        .map(|(_, receipt)| receipt)
}

pub(super) async fn replay_command<R: serde::de::DeserializeOwned>(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    deadline: CommandDeadline,
    idemp: &crate::writer::CommandIdentitySpec,
) -> Result<Option<R>, PortError> {
    let mut budget = ctx.budget.clone();
    budget.remaining = deadline.remaining(&budget)?;
    deadline
        .prepare(&budget, || {
            try_replay_completed_receipt(store, ctx.scope(), idemp, Some(&budget))
        })
        .await
}

pub(crate) async fn read_space_and_receipt<R: serde::de::DeserializeOwned>(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    idemp: &crate::writer::CommandIdentitySpec,
    budget: Option<&notarium_core::ports::CallBudget>,
) -> Result<(crate::SpaceRecord, Option<R>), PortError> {
    let scope_cl = scope.clone();
    let idemp_cl = idemp.clone();
    let inner = std::sync::Arc::clone(&store.inner);
    let (space, blob_opt) = store
        .with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_cl.space_id).await?;
                srec.scope.check(&scope_cl)?;
                inner.check_writer_epoch(&srec.scope.space_id, srec.active_epoch)?;
                let Some(existing) =
                    crate::writer::lookup_command_receipt_tx(tx, &scope_cl, &idemp_cl).await?
                else {
                    return Ok((srec, None));
                };
                if existing.command_hash != idemp_cl.command_hash {
                    return Err(DomainError::IdempotencyKeyReused.into());
                }
                if existing.status == "completed" {
                    Ok((srec, Some(existing.response_blob)))
                } else {
                    Ok((srec, None))
                }
            })
        })
        .await?;

    match blob_opt {
        Some(bytes) => {
            let decoded = rmp_serde::from_slice(&bytes).map_err(|err| {
                internal_not_committed("decode_replayed_receipt", err.to_string())
            })?;
            Ok((space, Some(decoded)))
        }
        None => Ok((space, None)),
    }
}

type PreparsedHeaderTuple = (
    Option<BTreeMap<String, YamlValue>>,
    Option<notarium_core::error::ValidationReason>,
    usize,
);

pub(crate) fn enforce_protected_frontmatter_unchanged_with_header(
    before: &str,
    after: &str,
    class: DocClass,
) -> Result<Option<PreparsedHeaderTuple>, PortError> {
    enforce_unchanged_protected_frontmatter(before, after, class, false)
}

pub(crate) fn enforce_room_frontmatter_unchanged_with_header(
    before: &str,
    after: &str,
    class: DocClass,
) -> Result<Option<PreparsedHeaderTuple>, PortError> {
    enforce_unchanged_protected_frontmatter(before, after, class, true)
}

fn enforce_unchanged_protected_frontmatter(
    before: &str,
    after: &str,
    class: DocClass,
    allow_room_separator: bool,
) -> Result<Option<PreparsedHeaderTuple>, PortError> {
    let old_hdr = notarium_syntax::frontmatter::analyze(before, class)?;
    notarium_syntax::unicode::validate_content(after)?;
    let new_carrier = notarium_syntax::carrier::Carrier::scan(after)?;
    let old_end = old_hdr.carrier.body.start();
    let new_end = new_carrier.body.start();
    if old_hdr.carrier.bom_end == new_carrier.bom_end
        && old_hdr.carrier.header.is_some() == new_carrier.header.is_some()
        && old_end == new_end
        && before.as_bytes()[..old_end] == after.as_bytes()[..new_end]
    {
        return Ok(Some((old_hdr.fields, old_hdr.diagnostic, new_end)));
    }
    let new_hdr = notarium_syntax::frontmatter::analyze(after, class)?;
    if let (Some(old_map), Some(new_map)) = (&old_hdr.fields, &new_hdr.fields) {
        for key in old_map.keys().chain(new_map.keys()) {
            if old_map.get(key) != new_map.get(key) {
                authorize_field_key(key)?;
            }
        }
    } else if !allow_room_separator
        || !notarium_syntax::live::is_room_separator_extension(
            before,
            after,
            &old_hdr.carrier,
            &new_carrier,
        )
    {
        // An opaque header must keep every original byte of its YAML and fences.
        return Err(DomainError::validation(ValidationReason::FmNotWritable).into());
    }
    Ok(Some((new_hdr.fields, new_hdr.diagnostic, new_end)))
}

async fn update_ability_package_slug_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    ability_id: &notarium_core::ids::AbilityId,
    new_slug_fold: &str,
    new_slug: &str,
    report_parent: Option<notarium_core::ids::FolderId>,
    project: Option<&notarium_core::ids::FolderId>,
) -> Result<(), PortError> {
    if super::packages::active_ability_slug_conflict_tx(
        tx,
        space_id,
        new_slug_fold,
        ability_id,
        project,
    )
    .await?
    {
        return Err(DomainError::PathConflict {
            target: PathTarget {
                space_id: space_id.clone(),
                parent: report_parent,
                component: new_slug.to_owned(),
            },
        }
        .into());
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE ability_packages SET slug_fold = ? WHERE space_id = ? AND ability_id = ?",
            )
            .bind(new_slug_fold)
            .bind(space_id.as_str())
            .bind(ability_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_ability_rename_upd", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE ability_packages SET slug_fold = $1 WHERE space_id = $2 AND ability_id = $3",
            )
            .bind(new_slug_fold)
            .bind(space_id.as_str())
            .bind(ability_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_ability_rename_upd", err.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod protected_frontmatter_tests {
    use super::*;

    #[test]
    fn header_analysis_always_describes_the_after_carrier() {
        for (before, after) in [
            ("\u{feff}draft", "\u{feff}---\nstatus: done\n---\ndraft"),
            ("---\n---\ndraft", "---\nstatus: done\n---\ndraft"),
            (
                "---\nstatus: todo\n---\ndraft",
                "---\nstatus: done\n---\ndraft",
            ),
            ("\u{feff}draft", "\u{feff}new draft"),
            ("draft", "---\n---\n\u{feff}draft"),
            (
                "---\nstatus: todo\nstatus: done\n---",
                "---\nstatus: todo\nstatus: done\n---\nbody",
            ),
            (
                "---\r\nstatus: todo\r\nstatus: done\r\n... \r",
                "---\r\nstatus: todo\r\nstatus: done\r\n... \r\n\nbody",
            ),
        ] {
            let got =
                enforce_room_frontmatter_unchanged_with_header(before, after, DocClass::UserDoc)
                    .unwrap()
                    .unwrap();
            let parsed = notarium_syntax::frontmatter::analyze(after, DocClass::UserDoc).unwrap();
            assert_eq!(
                got,
                (
                    parsed.fields,
                    parsed.diagnostic,
                    parsed.carrier.body.start()
                )
            );
        }
    }

    #[test]
    fn opaque_yaml_allows_only_room_generated_separators() {
        let before = "---\nstatus: todo\nstatus: done\n---";
        let after = "---\nstatus: todo\nstatus: done\n---\nbody";
        let changed_yaml = "---\nstatus: active\nstatus: done\n---\nbody";
        let changed_fence = "---\nstatus: todo\nstatus: done\n...\nbody";
        let isolated_separator = "---\nstatus: todo\nstatus: done\n---\n";
        for result in [
            enforce_protected_frontmatter_unchanged_with_header(before, after, DocClass::UserDoc),
            enforce_room_frontmatter_unchanged_with_header(before, changed_yaml, DocClass::UserDoc),
            enforce_room_frontmatter_unchanged_with_header(
                before,
                changed_fence,
                DocClass::UserDoc,
            ),
            enforce_room_frontmatter_unchanged_with_header(
                before,
                isolated_separator,
                DocClass::UserDoc,
            ),
        ] {
            assert!(matches!(
                result,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::FmNotWritable
            ));
        }
    }

    #[test]
    fn matching_prefix_cannot_hide_new_invalid_content() {
        let before = "\u{feff}draft";
        for (after, reason) in [
            (
                "\u{feff}---\nclass: skill\n---\ndraft",
                ValidationReason::ClassMismatch,
            ),
            (
                "\u{feff}---\nstatus: done\ndraft",
                ValidationReason::UnterminatedFrontmatter,
            ),
            ("\u{feff}draft\0", ValidationReason::DisallowedCodePoint),
        ] {
            assert!(matches!(
                enforce_protected_frontmatter_unchanged_with_header(before, after, DocClass::UserDoc),
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == reason
            ));
        }
    }
}

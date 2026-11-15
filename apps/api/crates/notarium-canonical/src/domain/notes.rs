use std::collections::{BTreeMap, HashMap};

use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    classes::{
        ClassEgressFence, ClassifiedDocument, ClassifiedMetadata, DocClass, authorize_field_key,
    },
    error::{Diagnostic, PortError, ValidationReason},
    ids::{BodyIdentity, ContentDigest, HeaderIdentity, NoteId, RevisionId, SpaceSeq},
    model::{FolderRef, Lifecycle, NoteRef, PathTarget, SnapshotCut},
    patch::{CarrierEditOrigin, CarrierPatchPlan, HeaderMutation},
    ports::{
        AcceptBatch, AppendMemory, BatchItem, BatchResult, Committed, CreateNote,
        DeleteDisposition, DeleteNote, EditNote, ExternalObservation, ExternalObservationResult,
        FilenamePin, GetNote, InterceptedMutation, InterceptedPayload, InterceptionResult, Link,
        LinkBatch, LinkTarget, MemoryTarget, MoveNote, Mutation, NoteCard, NoteRevision,
        NoteSnapshot, ObservedContent, Preconditions, RenameNote, SpaceContext,
    },
    query::{FieldObservation, FieldValue},
    receipt::{CausalBasis, CommandIdentity, MutationReceiptToken},
    span::ByteSpan,
    value::YamlValue,
};
use notarium_syntax::{extract::ExtractedDocDelta, frontmatter::FieldEdit};

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
        FolderAncestryCache, SpaceSchemaRevision, StoredCommittedLinkV1, StoredCommittedNoteRevV1,
        StoredCommittedSchemaRevV1, StoredExternalObsOutcomeV1, UpdateSpaceSchema,
        active_note_sibling_exists_tx, build_resource_facts_tx, check_collab_preconditions_tx,
        derive_command_identity_spec, extract_agent_run_from_auth, extract_note_preview,
        extract_note_title, insert_note_alias_tx, is_note_room_active_tx,
        load_current_space_schema_tx, load_folder_ancestry_tx, load_note_head_row_opt_tx,
        load_note_head_row_tx, note_rank_version_digest, schema_descriptor_bytes_and_fingerprint,
        upsert_agent_run_head_tx, validate_mutation_identity,
    },
    runtime::{
        insert_revision_row, is_note_purge_fenced_tx, load_folder_head_row, load_space_record,
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

pub(crate) fn analyze_and_prepare_carrier(
    carrier: &str,
    class: DocClass,
    note_id: &NoteId,
    slug: &str,
    codec: BlobCodecTag,
) -> Result<PreparedCarrierInfo, PortError> {
    let extracted = notarium_syntax::extract::extract(carrier, class, note_id, slug, None)?;
    let (raw_fields, diagnostics, headings) = match extracted {
        ExtractedDocDelta::Encrypted(_) => (None, Vec::new(), Vec::new()),
        ExtractedDocDelta::Plain(plain) => (plain.fields, plain.diagnostics, plain.headings),
    };
    let title = extract_note_title(carrier, slug, class, raw_fields.as_ref(), &headings);
    let title_fold = if class == DocClass::EncryptedNote {
        normalize_title_key(slug)
    } else {
        normalize_title_key(&title)
    };
    let prepared_blob = PreparedBlobSource::prepare(carrier.as_bytes(), codec)?;
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
        let old_hdr = notarium_syntax::frontmatter::analyze(before_carrier, class)?;
        let new_hdr = notarium_syntax::frontmatter::analyze(after_carrier, class)?;
        let before_with_new_header = format!(
            "{}{}",
            &after_carrier[..new_hdr.carrier.body.start()],
            old_hdr.carrier.body.slice(before_carrier)?
        );
        let raw_plan = notarium_syntax::live::raw_header_plan(
            before_carrier,
            &before_with_new_header,
            class,
            hdr_id,
        )?;
        HeaderMutation::RawHeader(raw_plan)
    };
    Ok((body_plan, header_mut))
}

pub(crate) async fn create_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<CreateNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let slug_fold = normalize_slug_key(&request.input.slug)?;
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

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

    let mut fp = blake3::Hasher::new();
    fp.update(request.input.note.as_str().as_bytes());
    fp.update(&[0]);
    if let Some(p) = &request.input.parent {
        fp.update(p.as_str().as_bytes());
    }
    fp.update(&[0]);
    fp.update(request.input.slug.as_bytes());
    fp.update(&[0]);
    fp.update(doc_class_to_db(request.input.class).as_bytes());
    fp.update(&[0]);
    fp.update(info.prepared_blob.digest.as_bytes());
    let idemp =
        derive_command_identity_spec(&request.identity, "create_note", fp.finalize().as_bytes());

    let intent = build_create_note_intent(
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.input,
        slug_fold,
        info,
        ticket,
    );

    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

#[allow(clippy::too_many_arguments)]
fn build_create_note_intent(
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

                if let Some(existing) =
                    load_note_head_row_opt_tx(tx, &scope_cl.space_id, &input.note).await?
                {
                    if existing.lifecycle == Lifecycle::Purged {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    return Err(DomainError::RevisionConflict {
                        current: existing.head_rev_id,
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

                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
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
                        .bind(seq_i64)
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
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, 'active', 0, NULL, $12, $12, $13, $14, $13, $14, $15)",
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                    seq,
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
                    "create_note",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: input.note.clone(),
                            revision: rev_id.clone(),
                            rank_version: note_rank_version_digest(&rev_id, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: input.class,
                            changed_fields: BTreeMap::new(),
                        }],
                    },
                    vec![input.note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: input.note.clone(),
                        revision: rev_id.clone(),
                    },
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "create_note".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: input.note.as_str().to_owned(),
                        op_kind: "create".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(input.class),
                    }],
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
    ctx: SpaceContext,
    request: Mutation<EditNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let mut fp_hasher = blake3::Hasher::new();
    fp_hasher.update(request.input.note.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(request.input.plan.base_content_hash.as_bytes());
    for edit in &request.input.plan.edits {
        fp_hasher.update(&[0]);
        fp_hasher.update(&edit.bytes.0.start().to_be_bytes());
        fp_hasher.update(&edit.bytes.0.end().to_be_bytes());
        fp_hasher.update(edit.replacement.as_bytes());
    }
    let idemp = derive_command_identity_spec(
        &request.identity,
        "edit_note",
        fp_hasher.finalize().as_bytes(),
    );

    // Check idempotency receipt BEFORE reading live head so replayed edits work even if head moved on!
    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let (space_rec, base_head) =
        read_active_note_for_mutation(store, &ctx, &request.input.note, &request.preconditions)
            .await?;

    let base_digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed(
            "active_note_missing_digest",
            "active note lacks content_blake3",
        )
    })?;
    if base_digest != request.input.plan.base_content_hash {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }

    let raw_bytes = store
        .read_verified_blob(&space_rec.scope, base_digest)
        .await?;
    let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
        internal_not_committed(
            "corrupt_note_utf8",
            "canonical note carrier is not valid UTF-8",
        )
    })?;

    let new_carrier = notarium_syntax::patch::apply(&base_carrier, &request.input.plan)?;
    if base_head.doc_class != DocClass::EncryptedNote {
        enforce_protected_frontmatter_unchanged(&base_carrier, &new_carrier, base_head.doc_class)?;
    }

    let mut reservation_opt = None;
    if let Some(interceptor) = store.inner.collab_interceptor.get()
        && base_head.doc_class != DocClass::EncryptedNote
    {
        let (body_plan, header_mut) = build_collab_edit_payload(
            &request.input.note,
            &base_carrier,
            &new_carrier,
            &request.input.plan,
            base_head.doc_class,
            &base_head.head_rev_id,
        )?;
        match interceptor
            .intercept(InterceptedMutation {
                context: ctx.clone(),
                identity: request.identity.clone(),
                preconditions: request.preconditions.clone(),
                payload: InterceptedPayload::EditNote {
                    note: request.input.note.clone(),
                    body: body_plan,
                    header: header_mut,
                },
            })
            .await?
        {
            InterceptionResult::Applied(receipt) => {
                let latest_rev =
                    read_current_note_rev(store, &space_rec.scope.space_id, &request.input.note)
                        .await?
                        .unwrap_or(base_head.head_rev_id);
                return Ok(Committed {
                    value: NoteRevision {
                        note: request.input.note,
                        revision: latest_rev,
                    },
                    receipt,
                });
            }
            InterceptionResult::Conflict(err) => return Err(err.into()),
            InterceptionResult::ClosedRoomReservation(res) => {
                reservation_opt = Some(res);
            }
        }
    }

    let info = analyze_and_prepare_carrier(
        &new_carrier,
        base_head.doc_class,
        &request.input.note,
        &base_head.slug,
        store.blob_codec(),
    )?;
    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

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
        None,
        info,
        ticket,
        reservation_opt,
    );

    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
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
    explicit_slug_override: Option<(String, String)>,
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
    reservation_opt: Option<notarium_core::ports::ClosedRoomReservation>,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let staged_bytes = ticket.compressed_size;
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);

    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp,
        source_note_ids: vec![note_id.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let fence_guard = if let Some(res) = reservation_opt {
                    let g = room_fences
                        .consume_reservation(&scope_cl, &note_id, res, &identity)
                        .await?;
                    let dstate: Option<String> = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_scalar(
                            "SELECT room_state FROM collab_sessions WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_note_collab_state", err.to_string()))?,
                        BackendConn::Postgres(conn) => sqlx::query_scalar(
                            "SELECT room_state FROM collab_sessions WHERE space_id = $1 AND note_id = $2",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(note_id.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_note_collab_state", err.to_string()))?,
                    };
                    if matches!(dstate.as_deref(), Some("active" | "fenced")) {
                        return Err(unavailable_retryable(
                            "collab_room_not_closed",
                            "note collaborative session is active or fenced awaiting recovery",
                            std::time::Duration::from_millis(50),
                        ));
                    }
                    Some(g)
                } else {
                    if crate::domain::common::is_note_room_active_tx(
                        tx,
                        &room_fences,
                        &scope_cl,
                        &note_id,
                    )
                    .await?
                    {
                        return Err(unavailable_retryable(
                            "collab_room_not_closed",
                            "note collaborative session is active or fenced awaiting recovery",
                            std::time::Duration::from_millis(50),
                        ));
                    }
                    None
                };
                if let Some(g) = fence_guard {
                    item_ctx.retain_until_batch_commit(g);
                }

                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note_id).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
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

                let (final_slug, final_slug_fold) = match &explicit_slug_override {
                    Some((s, sf)) => {
                        if sf != &head.slug_fold
                            && active_note_sibling_exists_tx(
                                tx,
                                &scope_cl.space_id,
                                &head.parent_folder_id,
                                sf,
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
                                    component: s.clone(),
                                },
                            }
                            .into());
                        }
                        (s.clone(), sf.clone())
                    }
                    None => (head.slug.clone(), head.slug_fold.clone()),
                };

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
                             SET slug = ?, slug_fold = ?, title = ?, title_fold = ?,
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
                             SET slug = $1, slug_fold = $2, title = $3, title_fold = $4,
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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

                let op_kind = if explicit_slug_override.is_some() {
                    "rename"
                } else {
                    "edit"
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
                            changed_fields: BTreeMap::new(),
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
                    receipt_detail_blob: None,
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
    if request.input.disposition == DeleteDisposition::Purge {
        return crate::domain::purge::purge_note_impl(store, ctx, request).await;
    }

    validate_mutation_identity(&ctx, &request.identity)?;
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let disp_tag = match request.input.disposition {
        DeleteDisposition::Trash => "trash_note",
        DeleteDisposition::Restore => "restore_note",
        DeleteDisposition::Purge => unreachable!(),
    };
    let fp = format!("{disp_tag}={}", request.input.note.as_str());
    let idemp = derive_command_identity_spec(&request.identity, disp_tag, fp.as_bytes());

    let intent = build_trash_or_restore_intent(
        store,
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        request.input,
    );

    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

fn build_trash_or_restore_intent(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    input: DeleteNote,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let note_id = input.note.clone();

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

                let require_active_folders = input.disposition == DeleteDisposition::Restore;
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

                let (target_lc, op_kind, cmd_kind) = match input.disposition {
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
                        (Lifecycle::Active, "restore", "restore_note")
                    }
                    DeleteDisposition::Purge => unreachable!(),
                };

                let digest = head.content_digest.ok_or_else(|| {
                    internal_not_committed("note_missing_digest", "non-purged note lacks digest")
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

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
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
                        .bind(seq_i64)
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
                        .bind(seq_i64)
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
                            .bind(seq_i64)
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
                            .bind(seq_i64)
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                    command_kind: cmd_kind.to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: note_id.as_str().to_owned(),
                        op_kind: op_kind.to_owned(),
                        rev_id: new_rev,
                        lifecycle: target_lc,
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

pub(crate) async fn move_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<MoveNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let new_slug_fold = normalize_slug_key(&request.input.slug)?;

    if let Some(interceptor) = store.inner.collab_interceptor.get() {
        let pin = interceptor
            .filename_pin(ctx.clone(), request.input.note.clone())
            .await?;
        if let FilenamePin::Pinned { .. } = pin {
            return Err(unavailable_retryable(
                "move_note_blocked_by_filename_pin",
                "cannot move note while live room holds a filename pin",
                std::time::Duration::from_millis(50),
            ));
        }
    }

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "note={}\0parent={}\0slug={}",
        request.input.note.as_str(),
        request
            .input
            .parent
            .as_ref()
            .map(|p| p.as_str())
            .unwrap_or("<root>"),
        request.input.slug
    );
    let idemp = derive_command_identity_spec(&request.identity, "move_note", fp.as_bytes());

    let intent = build_move_note_intent(
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        ctx.auth().clone(),
        request.preconditions,
        request.input,
        new_slug_fold,
    );

    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

fn build_move_note_intent(
    scope: &notarium_core::model::HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: Option<crate::writer::CommandIdentitySpec>,
    auth: notarium_core::auth::EngineAuthContext,
    preconditions: Preconditions,
    input: MoveNote,
    new_slug_fold: String,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let note_id = input.note.clone();

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

                let dest_parent = input
                    .parent
                    .clone()
                    .unwrap_or_else(|| item_ctx.root_folder_id.clone());

                let (before_facts, _) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                let (after_facts, after_anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &dest_parent,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&before_facts, &after_facts)?;

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
                    && new_slug_fold != head.slug_fold
                {
                    update_ability_package_slug_tx(
                        tx,
                        &scope_cl.space_id,
                        ab_id,
                        &new_slug_fold,
                        &input.slug,
                        input.parent.clone(),
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

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;

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
                        .bind(seq_i64)
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
                        .bind(seq_i64)
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                    command_kind: "move_note".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: note_id.as_str().to_owned(),
                        op_kind: "move".to_owned(),
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

pub(crate) async fn rename_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RenameNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let new_slug_fold = normalize_slug_key(&request.input.slug)?;

    if let Some(interceptor) = store.inner.collab_interceptor.get() {
        let pin = interceptor
            .filename_pin(ctx.clone(), request.input.note.clone())
            .await?;
        if let FilenamePin::Pinned { filename, .. } = pin
            && filename != request.input.slug
        {
            return Err(unavailable_retryable(
                "rename_note_blocked_by_filename_pin",
                "cannot rename note slug while live room holds filename pin",
                std::time::Duration::from_millis(50),
            ));
        }
    }

    let fp = format!(
        "note={}\0slug={}\0title={}",
        request.input.note.as_str(),
        request.input.slug,
        request.input.title.as_deref().unwrap_or("<none>")
    );
    let idemp = derive_command_identity_spec(&request.identity, "rename_note", fp.as_bytes());

    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let (space_rec, base_head) =
        read_active_note_for_mutation(store, &ctx, &request.input.note, &request.preconditions)
            .await?;

    if let Some(explicit_title) = &request.input.title {
        let trimmed = explicit_title.trim();
        if trimmed.is_empty() || trimmed.contains('\r') || trimmed.contains('\n') {
            return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
        }
        if base_head.doc_class == DocClass::EncryptedNote && trimmed != request.input.slug {
            return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
        }
        if base_head.doc_class != DocClass::EncryptedNote {
            let base_digest = base_head.content_digest.ok_or_else(|| {
                internal_not_committed("active_note_missing_digest", "active note lacks digest")
            })?;
            let raw_bytes = store
                .read_verified_blob(&space_rec.scope, base_digest)
                .await?;
            let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
                internal_not_committed("corrupt_note_utf8", "carrier not valid UTF-8")
            })?;
            let updated_carrier = apply_title_surgery_to_carrier(
                &base_carrier,
                base_head.doc_class,
                &request.input.note,
                &request.input.slug,
                trimmed,
            )?;
            let info = analyze_and_prepare_carrier(
                &updated_carrier,
                base_head.doc_class,
                &request.input.note,
                &request.input.slug,
                store.blob_codec(),
            )?;
            let ticket = store
                .stage_blob(
                    &space_rec.scope,
                    space_rec.active_epoch,
                    &info.prepared_blob,
                )
                .await?;
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
                Some((request.input.slug, new_slug_fold)),
                info,
                ticket,
                None,
            );
            let stored: StoredCommittedNoteRevV1 =
                store.submit_write_command(&ctx.budget, intent).await?;
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
        MoveNote {
            note: request.input.note,
            parent: (base_head.parent_folder_id != space_rec.root_folder_id)
                .then_some(base_head.parent_folder_id),
            slug: request.input.slug,
        },
        new_slug_fold,
    );
    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

fn apply_title_surgery_to_carrier(
    carrier: &str,
    class: DocClass,
    note_id: &NoteId,
    slug: &str,
    new_title: &str,
) -> Result<String, PortError> {
    let hdr = notarium_syntax::frontmatter::analyze(carrier, class)?;
    if let Some(fields) = &hdr.fields
        && fields.contains_key("title")
    {
        let plan = notarium_syntax::frontmatter::patch_frontmatter(
            carrier,
            class,
            &[FieldEdit::Set {
                key: "title".to_owned(),
                value: YamlValue::String(new_title.to_owned()),
            }],
        )?;
        return notarium_syntax::patch::apply(carrier, &plan).map_err(PortError::from);
    }

    let extracted = notarium_syntax::extract::extract(carrier, class, note_id, slug, None)?;
    if let ExtractedDocDelta::Plain(plain) = extracted
        && let Some(h1) = plain.headings.iter().find(|h| h.level == 1)
    {
        let plan = notarium_syntax::patch::plan(
            carrier,
            hdr.carrier.body,
            vec![(
                CarrierEditOrigin::Body,
                h1.heading_span,
                format!("# {new_title}"),
            )],
        )?;
        return notarium_syntax::patch::apply(carrier, &plan).map_err(PortError::from);
    }

    let body_start = hdr.carrier.body.start();
    let insert_span = ByteSpan::new(body_start, body_start)?;
    let prefix = if hdr.carrier.body.slice(carrier)?.is_empty() {
        format!("# {new_title}\n")
    } else {
        format!("# {new_title}\n\n")
    };
    let plan = notarium_syntax::patch::plan(
        carrier,
        hdr.carrier.body,
        vec![(CarrierEditOrigin::Body, insert_span, prefix)],
    )?;
    notarium_syntax::patch::apply(carrier, &plan).map_err(PortError::from)
}

#[derive(Clone)]
struct VirtualNoteState {
    class: DocClass,
    slug: String,
    carrier: String,
}

pub(crate) async fn accept_batch_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: AcceptBatch,
) -> Result<BatchResult<NoteRevision>, PortError> {
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    if request.items.is_empty() {
        return Ok(BatchResult {
            items: Vec::new(),
            committed_high_watermark: space_rec.last_seq,
        });
    }

    // Preload base carriers for any existing notes edited inside the batch so sequential intra-batch
    // edits (`Create(N)` -> `Edit(N)` or `Edit(N)` -> `Edit(N)`) compose cleanly in Phase 1!
    let mut referenced_edits = Vec::new();
    for item in &request.items {
        if let BatchItem::Edit(ed) = &item.input
            && !referenced_edits.contains(&ed.note)
        {
            referenced_edits.push(ed.note.clone());
        }
    }

    let mut virtual_notes: HashMap<NoteId, VirtualNoteState> = HashMap::new();
    for nid in referenced_edits {
        let scope_in = space_rec.scope.clone();
        let nid_in = nid.clone();
        let loaded_opt = store
            .with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    if is_note_purge_fenced_tx(tx, &scope_in.space_id, nid_in.as_str()).await? {
                        return Ok(None);
                    }
                    load_note_head_row_opt_tx(tx, &scope_in.space_id, &nid_in).await
                })
            })
            .await?;
        if let Some(head) = loaded_opt
            && head.lifecycle == Lifecycle::Active
            && let Some(digest) = head.content_digest
            && let Ok(bytes) = store.read_verified_blob(&space_rec.scope, digest).await
            && let Ok(carrier) = String::from_utf8(bytes)
        {
            virtual_notes.insert(
                nid,
                VirtualNoteState {
                    class: head.doc_class,
                    slug: head.slug,
                    carrier,
                },
            );
        }
    }

    let mut intents = Vec::with_capacity(request.items.len());
    for item_mut in request.items {
        if let Err(err) = validate_mutation_identity(&ctx, &item_mut.identity) {
            intents.push(build_failing_item_intent(
                &space_rec.scope,
                space_rec.active_epoch,
                err,
            ));
            continue;
        }
        match item_mut.input {
            BatchItem::Create(cr) => {
                let res: Result<PreparedWriteIntent, PortError> = async {
                    let slug_fold = normalize_slug_key(&cr.slug)?;
                    if cr.class == DocClass::Skill {
                        ctx.auth().authorize_ability_mutation()?;
                    }
                    let info = analyze_and_prepare_carrier(
                        &cr.carrier,
                        cr.class,
                        &cr.note,
                        &cr.slug,
                        store.blob_codec(),
                    )?;
                    let ticket = store
                        .stage_blob(
                            &space_rec.scope,
                            space_rec.active_epoch,
                            &info.prepared_blob,
                        )
                        .await?;
                    let mut fp = blake3::Hasher::new();
                    fp.update(cr.note.as_str().as_bytes());
                    fp.update(&[0]);
                    fp.update(cr.slug.as_bytes());
                    fp.update(&[0]);
                    fp.update(info.prepared_blob.digest.as_bytes());
                    let idemp = derive_command_identity_spec(
                        &item_mut.identity,
                        "create_note",
                        fp.finalize().as_bytes(),
                    );
                    virtual_notes.insert(
                        cr.note.clone(),
                        VirtualNoteState {
                            class: cr.class,
                            slug: cr.slug.clone(),
                            carrier: cr.carrier.clone(),
                        },
                    );
                    Ok(build_create_note_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        Some(idemp),
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
                    Err(err) => intents.push(build_failing_item_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        err,
                    )),
                }
            }
            BatchItem::Edit(ed) => {
                let res: Result<PreparedWriteIntent, PortError> = async {
                    let Some(vstate) = virtual_notes.get(&ed.note).cloned() else {
                        return Err(DomainError::ResourceNotFound.into());
                    };
                    let new_carrier = notarium_syntax::patch::apply(&vstate.carrier, &ed.plan)?;
                    if vstate.class != DocClass::EncryptedNote {
                        enforce_protected_frontmatter_unchanged(
                            &vstate.carrier,
                            &new_carrier,
                            vstate.class,
                        )?;
                    }
                    let info = analyze_and_prepare_carrier(
                        &new_carrier,
                        vstate.class,
                        &ed.note,
                        &vstate.slug,
                        store.blob_codec(),
                    )?;
                    let ticket = store
                        .stage_blob(
                            &space_rec.scope,
                            space_rec.active_epoch,
                            &info.prepared_blob,
                        )
                        .await?;
                    let mut fp = blake3::Hasher::new();
                    fp.update(ed.note.as_str().as_bytes());
                    fp.update(&[0]);
                    fp.update(ed.plan.base_content_hash.as_bytes());
                    fp.update(&[0]);
                    fp.update(info.prepared_blob.digest.as_bytes());
                    let idemp = derive_command_identity_spec(
                        &item_mut.identity,
                        "edit_note",
                        fp.finalize().as_bytes(),
                    );
                    virtual_notes.insert(
                        ed.note.clone(),
                        VirtualNoteState {
                            class: vstate.class,
                            slug: vstate.slug,
                            carrier: new_carrier,
                        },
                    );
                    Ok(build_batch_edit_intent(
                        store,
                        &space_rec.scope,
                        space_rec.active_epoch,
                        Some(idemp),
                        ctx.auth().clone(),
                        item_mut.preconditions,
                        ed.note,
                        ed.plan.base_content_hash,
                        info,
                        ticket,
                    ))
                }
                .await;
                match res {
                    Ok(intent) => intents.push(intent),
                    Err(err) => intents.push(build_failing_item_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        err,
                    )),
                }
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
                if del.disposition == DeleteDisposition::Trash {
                    virtual_notes.remove(&del.note);
                }
                let disp_tag = match del.disposition {
                    DeleteDisposition::Trash => "trash_note",
                    DeleteDisposition::Restore => "restore_note",
                    DeleteDisposition::Purge => unreachable!(),
                };
                let fp = format!("{disp_tag}={}", del.note.as_str());
                let idemp =
                    derive_command_identity_spec(&item_mut.identity, disp_tag, fp.as_bytes());
                intents.push(build_trash_or_restore_intent(
                    store,
                    &space_rec.scope,
                    space_rec.active_epoch,
                    Some(idemp),
                    ctx.auth().clone(),
                    item_mut.preconditions,
                    del,
                ));
            }
            BatchItem::Move(mv) => match normalize_slug_key(&mv.slug) {
                Ok(sf) => {
                    if let Some(vs) = virtual_notes.get_mut(&mv.note) {
                        vs.slug = mv.slug.clone();
                    }
                    let fp = format!(
                        "note={}\0parent={}\0slug={}",
                        mv.note.as_str(),
                        mv.parent.as_ref().map(|p| p.as_str()).unwrap_or("<root>"),
                        mv.slug
                    );
                    let idemp = derive_command_identity_spec(
                        &item_mut.identity,
                        "move_note",
                        fp.as_bytes(),
                    );
                    intents.push(build_move_note_intent(
                        &space_rec.scope,
                        space_rec.active_epoch,
                        Some(idemp),
                        ctx.auth().clone(),
                        item_mut.preconditions,
                        mv,
                        sf,
                    ));
                }
                Err(err) => intents.push(build_failing_item_intent(
                    &space_rec.scope,
                    space_rec.active_epoch,
                    err.into(),
                )),
            },
        }
    }

    let (raw_outcomes, committed_high_watermark) = store
        .submit_write_batch::<StoredCommittedNoteRevV1>(
            &ctx.budget,
            &space_rec.scope.space_id,
            intents,
        )
        .await?;

    let mut out_items = Vec::with_capacity(raw_outcomes.len());
    for res in raw_outcomes {
        match res {
            Ok(stored) => out_items.push(Ok(stored.into_committed())),
            Err(PortError::Domain(d)) => out_items.push(Err(d)),
            Err(operational) => return Err(operational),
        }
    }

    Ok(BatchResult {
        items: out_items,
        committed_high_watermark,
    })
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
    info: PreparedCarrierInfo,
    ticket: crate::blobs::StagedBlobTicket,
) -> PreparedWriteIntent {
    let scope_cl = scope.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);
    let staged_bytes = ticket.compressed_size;

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
                check_collab_preconditions_tx(tx, &scope_cl.space_id, &note_id, &preconditions)
                    .await?;
                if is_note_room_active_tx(tx, &room_fences, &scope_cl, &note_id).await? {
                    return Err(unavailable_retryable(
                        "batch_edit_blocked_by_active_or_fenced_room",
                        "cannot overwrite note carrier directly while collaborative room is active or fenced",
                        std::time::Duration::from_millis(50),
                    ));
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

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                            changed_fields: BTreeMap::new(),
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

pub(crate) async fn append_memory_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<AppendMemory>,
) -> Result<Committed<NoteRevision>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    if request.input.target.note.space_id != ctx.scope().space_id {
        return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
    }
    let category = request.input.target.category.trim();
    let text = request.input.text.trim();
    if category.is_empty() || text.is_empty() || category.contains('\r') || category.contains('\n')
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    let fp = format!(
        "note={}\0cat={category}\0text={text}",
        request.input.target.note.note_id.as_str()
    );
    let idemp = derive_command_identity_spec(&request.identity, "append_memory", fp.as_bytes());
    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedNoteRevV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let note_id = request.input.target.note.note_id.clone();
    let target_spec = request.input.target.target.clone();

    let (space_rec, base_head) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            let scope_in = ctx.scope().clone();
            let auth_in = ctx.auth().clone();
            let nid_in = note_id.clone();
            let target_in = target_spec.clone();
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_in.space_id).await?;
                srec.scope.check(&scope_in)?;
                if is_note_purge_fenced_tx(tx, &scope_in.space_id, nid_in.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let head = load_note_head_row_tx(tx, &scope_in.space_id, &nid_in).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if head.doc_class != DocClass::AgentMemory {
                    return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
                }
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &srec.space,
                    &head.parent_folder_id,
                    DocClass::AgentMemory,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth_in.authorize_direct_write(&facts, &facts)?;

                // Re-verify ResolvedMemoryTarget provenance!
                match &target_in {
                    MemoryTarget::User { owner } => {
                        if owner != auth_in.principal() {
                            return Err(DomainError::validation(
                                ValidationReason::InvalidAuthority,
                            )
                            .into());
                        }
                    }
                    MemoryTarget::Project { folder } => {
                        if folder.space_id != scope_in.space_id {
                            return Err(
                                DomainError::validation(ValidationReason::ScopeMismatch).into()
                            );
                        }
                        let proj_row =
                            load_folder_head_row(tx, &scope_in.space_id, &folder.folder_id).await?;
                        if proj_row.lifecycle != Lifecycle::Active || !proj_row.is_project {
                            return Err(
                                DomainError::validation(ValidationReason::ScopeMismatch).into()
                            );
                        }
                        if !anc.ancestors.contains(&folder.folder_id) {
                            return Err(
                                DomainError::validation(ValidationReason::ScopeMismatch).into()
                            );
                        }
                    }
                }
                Ok((srec, head))
            })
        })
        .await?;

    if let Some(prec_rev) = &request.preconditions.revision
        && *prec_rev != base_head.head_rev_id
    {
        return Err(DomainError::RevisionConflict {
            current: base_head.head_rev_id,
            lineage: None,
        }
        .into());
    }

    let base_digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed("memory_missing_digest", "AgentMemory note lacks digest")
    })?;
    let raw_bytes = store
        .read_verified_blob(&space_rec.scope, base_digest)
        .await?;
    let base_carrier = String::from_utf8(raw_bytes).map_err(|_| {
        internal_not_committed("memory_corrupt_utf8", "AgentMemory carrier not valid UTF-8")
    })?;

    let hdr = notarium_syntax::frontmatter::analyze(&base_carrier, DocClass::AgentMemory)?;
    let needs_leading_newline = !base_carrier.is_empty() && !base_carrier.ends_with('\n');
    let appended = if needs_leading_newline {
        format!("\n- [{category}] {text}\n")
    } else {
        format!("- [{category}] {text}\n")
    };
    let end_pos = base_carrier.len();
    let patch_plan = notarium_syntax::patch::plan(
        &base_carrier,
        hdr.carrier.body,
        vec![(
            CarrierEditOrigin::Body,
            ByteSpan::new(end_pos, end_pos)?,
            appended,
        )],
    )?;
    let new_carrier = notarium_syntax::patch::apply(&base_carrier, &patch_plan)?;
    let info = analyze_and_prepare_carrier(
        &new_carrier,
        DocClass::AgentMemory,
        &note_id,
        &base_head.slug,
        store.blob_codec(),
    )?;
    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

    let intent = build_carrier_replacement_intent(
        store,
        &space_rec.scope,
        space_rec.active_epoch,
        Some(idemp),
        "append_memory",
        ctx.auth().clone(),
        request.identity,
        request.preconditions,
        note_id,
        base_head.head_rev_id,
        None,
        info,
        ticket,
        None,
    );

    let stored: StoredCommittedNoteRevV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

fn validate_and_format_link_line(link: &Link) -> Result<String, PortError> {
    let rel = link.relation.trim();
    if rel.is_empty()
        || rel.contains('\r')
        || rel.contains('\n')
        || rel.contains('\0')
        || rel.contains(':')
    {
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
                || trimmed.contains('[')
                || trimmed.contains(']')
            {
                return Err(DomainError::validation(ValidationReason::InvalidPathComponent).into());
            }
            trimmed.to_owned()
        }
    };
    Ok(format!("- {rel}: [[{target_token}]]\n"))
}

pub(crate) async fn link_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<Link>,
) -> Result<Committed<Link>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let link_line = validate_and_format_link_line(&request.input)?;

    let fp = format!("src={}\0line={link_line}", request.input.source.as_str());
    let idemp = derive_command_identity_spec(&request.identity, "link", fp.as_bytes());
    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedLinkV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    let (space_rec, base_head) =
        read_active_note_for_mutation(store, &ctx, &request.input.source, &request.preconditions)
            .await?;
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

    let new_carrier = append_link_line_to_carrier(&base_carrier, base_head.doc_class, &link_line)?;
    let info = analyze_and_prepare_carrier(
        &new_carrier,
        base_head.doc_class,
        &request.input.source,
        &base_head.slug,
        store.blob_codec(),
    )?;
    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

    let intent = build_link_item_intent(
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
    );

    let stored: StoredCommittedLinkV1 = store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn link_many_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: LinkBatch,
) -> Result<BatchResult<Link>, PortError> {
    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    if request.items.is_empty() {
        return Ok(BatchResult {
            items: Vec::new(),
            committed_high_watermark: space_rec.last_seq,
        });
    }

    let mut virtual_sources: HashMap<NoteId, (DocClass, String, String, ContentDigest)> =
        HashMap::new();
    for item in &request.items {
        if !virtual_sources.contains_key(&item.input.source) {
            let scope_in = space_rec.scope.clone();
            let src_id = item.input.source.clone();
            let head_opt = store
                .with_read_tx_budget(Some(&ctx.budget), |tx| {
                    Box::pin(async move {
                        if is_note_purge_fenced_tx(tx, &scope_in.space_id, src_id.as_str()).await? {
                            return Ok(None);
                        }
                        load_note_head_row_opt_tx(tx, &scope_in.space_id, &src_id).await
                    })
                })
                .await?;
            if let Some(head) = head_opt
                && head.lifecycle == Lifecycle::Active
                && let Some(digest) = head.content_digest
                && let Ok(bytes) = store.read_verified_blob(&space_rec.scope, digest).await
                && let Ok(carrier) = String::from_utf8(bytes)
            {
                virtual_sources.insert(
                    item.input.source.clone(),
                    (head.doc_class, head.slug, carrier, digest),
                );
            }
        }
    }

    let mut intents = Vec::with_capacity(request.items.len());
    for item_mut in request.items {
        let res: Result<PreparedWriteIntent, PortError> = async {
            validate_mutation_identity(&ctx, &item_mut.identity)?;
            let link_line = validate_and_format_link_line(&item_mut.input)?;
            let Some((doc_class, slug, cur_carrier, cur_digest)) =
                virtual_sources.get(&item_mut.input.source).cloned()
            else {
                return Err(DomainError::ResourceNotFound.into());
            };
            if doc_class == DocClass::EncryptedNote {
                return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
            }
            let new_carrier = append_link_line_to_carrier(&cur_carrier, doc_class, &link_line)?;
            let info = analyze_and_prepare_carrier(
                &new_carrier,
                doc_class,
                &item_mut.input.source,
                &slug,
                store.blob_codec(),
            )?;
            let new_digest = info.prepared_blob.digest;
            let ticket = store
                .stage_blob(
                    &space_rec.scope,
                    space_rec.active_epoch,
                    &info.prepared_blob,
                )
                .await?;
            let fp = format!(
                "src={}\0base={}\0line={link_line}",
                item_mut.input.source.as_str(),
                cur_digest.to_hex()
            );
            let idemp = derive_command_identity_spec(&item_mut.identity, "link", fp.as_bytes());
            virtual_sources.insert(
                item_mut.input.source.clone(),
                (doc_class, slug, new_carrier, new_digest),
            );
            Ok(build_link_item_intent(
                store,
                &space_rec.scope,
                space_rec.active_epoch,
                Some(idemp),
                ctx.auth().clone(),
                item_mut.preconditions,
                item_mut.input,
                cur_digest,
                info,
                ticket,
            ))
        }
        .await;

        match res {
            Ok(intent) => intents.push(intent),
            Err(err) => intents.push(build_failing_item_intent(
                &space_rec.scope,
                space_rec.active_epoch,
                err,
            )),
        }
    }

    let (raw_outcomes, committed_high_watermark) = store
        .submit_write_batch::<StoredCommittedLinkV1>(
            &ctx.budget,
            &space_rec.scope.space_id,
            intents,
        )
        .await?;

    let mut out_items = Vec::with_capacity(raw_outcomes.len());
    for res in raw_outcomes {
        match res {
            Ok(stored) => out_items.push(Ok(stored.into_committed())),
            Err(PortError::Domain(d)) => out_items.push(Err(d)),
            Err(operational) => return Err(operational),
        }
    }

    Ok(BatchResult {
        items: out_items,
        committed_high_watermark,
    })
}

fn append_link_line_to_carrier(
    carrier: &str,
    class: DocClass,
    link_line: &str,
) -> Result<String, PortError> {
    let hdr = notarium_syntax::frontmatter::analyze(carrier, class)?;
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
    notarium_syntax::patch::apply(carrier, &plan).map_err(PortError::from)
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

                // Verify typed target existence and caller visibility inside the same Space!
                let mut owner_notes = vec![source_id.clone()];
                match &link.target {
                    LinkTarget::Note(target_nid) => {
                        if is_note_purge_fenced_tx(tx, &scope_cl.space_id, target_nid.as_str())
                            .await?
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let target_head =
                            load_note_head_row_tx(tx, &scope_cl.space_id, target_nid).await?;
                        if target_head.lifecycle != Lifecycle::Active {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        let (tfacts, _) = build_resource_facts_tx(
                            tx,
                            &live_space.space,
                            &target_head.parent_folder_id,
                            target_head.doc_class,
                            target_head.ability_id,
                            true,
                        )
                        .await?;
                        auth.authorize_read(&tfacts)?;
                        if !owner_notes.contains(target_nid) {
                            owner_notes.push(target_nid.clone());
                        }
                    }
                    LinkTarget::Folder(target_fid) => {
                        let fanc =
                            load_folder_ancestry_tx(tx, &scope_cl.space_id, target_fid, true)
                                .await?;
                        let tfacts = notarium_core::auth::ResourceFacts {
                            space: live_space.space.clone(),
                            class: head.doc_class,
                            ancestor_folders: fanc.ancestors,
                            folder_write_locked: fanc.write_locked,
                            ability_package: None,
                        };
                        auth.authorize_read(&tfacts)?;
                    }
                    LinkTarget::AuthoredName(_) => {}
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                            changed_fields: BTreeMap::new(),
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

pub(crate) async fn accept_external_observation_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ExternalObservation>,
) -> Result<ExternalObservationResult, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let mut fp = blake3::Hasher::new();
    fp.update(request.input.note.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.observed_digest.as_bytes());
    fp.update(&[0]);
    fp.update(request.input.base_revision.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.disk_identity.as_bytes());
    let idemp = derive_command_identity_spec(
        &request.identity,
        "accept_external_observation",
        fp.finalize().as_bytes(),
    );

    if let Some(replayed) = try_replay_completed_receipt::<StoredExternalObsOutcomeV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(match replayed {
            StoredExternalObsOutcomeV1::Committed(c) => {
                ExternalObservationResult::Committed(c.into_committed())
            }
            StoredExternalObsOutcomeV1::NoChange { revision } => {
                ExternalObservationResult::NoChange { revision }
            }
            StoredExternalObsOutcomeV1::Conflict { current } => {
                ExternalObservationResult::Conflict { current }
            }
        });
    }

    let (space_rec, base_head) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            let scope_in = ctx.scope().clone();
            let auth_in = ctx.auth().clone();
            let nid_in = request.input.note.clone();
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_in.space_id).await?;
                srec.scope.check(&scope_in)?;
                if is_note_purge_fenced_tx(tx, &scope_in.space_id, nid_in.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let head = load_note_head_row_tx(tx, &scope_in.space_id, &nid_in).await?;
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
                auth_in.authorize_direct_write(&facts, &facts)?;
                Ok((srec, head))
            })
        })
        .await?;

    if base_head.head_rev_id != request.input.base_revision {
        return Ok(ExternalObservationResult::Conflict {
            current: base_head.head_rev_id,
        });
    }
    if base_head.content_digest == Some(request.input.observed_digest) {
        return Ok(ExternalObservationResult::NoChange {
            revision: base_head.head_rev_id,
        });
    }

    let base_digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed("obs_missing_digest", "active note lacks content_blake3")
    })?;
    let raw_bytes = store
        .read_verified_blob(&space_rec.scope, base_digest)
        .await?;
    let base_carrier = String::from_utf8(raw_bytes)
        .map_err(|_| internal_not_committed("obs_corrupt_utf8", "carrier not valid UTF-8"))?;

    let (new_carrier, patch_plan_for_collab) = match &request.input.content {
        ObservedContent::Carrier(c) => {
            let hdr = notarium_syntax::frontmatter::analyze(&base_carrier, base_head.doc_class)?;
            let full_span = ByteSpan::new(0, base_carrier.len())?;
            let plan_opt = if hdr.carrier.body.start() == 0 {
                Some(notarium_syntax::patch::plan(
                    &base_carrier,
                    hdr.carrier.body,
                    vec![(CarrierEditOrigin::Body, full_span, c.clone())],
                )?)
            } else {
                None
            };
            (c.clone(), plan_opt)
        }
        ObservedContent::Planned(plan) => {
            let applied = notarium_syntax::patch::apply(&base_carrier, plan)?;
            (applied, Some(plan.clone()))
        }
    };

    let computed_digest = notarium_syntax::content_digest(&new_carrier);
    if computed_digest != request.input.observed_digest {
        return Err(DomainError::validation(ValidationReason::InvalidDigest).into());
    }
    if base_head.doc_class != DocClass::EncryptedNote {
        enforce_protected_frontmatter_unchanged(&base_carrier, &new_carrier, base_head.doc_class)?;
    }

    let mut reservation_opt = None;
    if let Some(interceptor) = store.inner.collab_interceptor.get()
        && base_head.doc_class != DocClass::EncryptedNote
        && let Some(plan) = &patch_plan_for_collab
    {
        let (body_plan, header_mut) = build_collab_edit_payload(
            &request.input.note,
            &base_carrier,
            &new_carrier,
            plan,
            base_head.doc_class,
            &base_head.head_rev_id,
        )?;
        match interceptor
            .intercept(InterceptedMutation {
                context: ctx.clone(),
                identity: request.identity.clone(),
                preconditions: request.preconditions.clone(),
                payload: InterceptedPayload::ExternalObservation {
                    observation: request.input.clone(),
                    body: body_plan,
                    header: header_mut,
                },
            })
            .await?
        {
            InterceptionResult::Applied(receipt) => {
                let latest_rev =
                    read_current_note_rev(store, &space_rec.scope.space_id, &request.input.note)
                        .await?
                        .unwrap_or(base_head.head_rev_id);
                return Ok(ExternalObservationResult::Committed(Committed {
                    value: NoteRevision {
                        note: request.input.note,
                        revision: latest_rev,
                    },
                    receipt,
                }));
            }
            InterceptionResult::Conflict(_) => {
                let latest_rev =
                    read_current_note_rev(store, &space_rec.scope.space_id, &request.input.note)
                        .await?
                        .unwrap_or(base_head.head_rev_id);
                return Ok(ExternalObservationResult::Conflict {
                    current: latest_rev,
                });
            }
            InterceptionResult::ClosedRoomReservation(res) => {
                reservation_opt = Some(res);
            }
        }
    }

    let info = analyze_and_prepare_carrier(
        &new_carrier,
        base_head.doc_class,
        &request.input.note,
        &base_head.slug,
        store.blob_codec(),
    )?;
    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;

    let scope_cl = space_rec.scope.clone();
    let staged_bytes = ticket.compressed_size;
    let auth = ctx.auth().clone();
    let identity = request.identity.clone();
    let preconditions = request.preconditions.clone();
    let obs_input = request.input.clone();
    let room_fences = std::sync::Arc::clone(&store.inner.room_fences);

    let intent = PreparedWriteIntent {
        scope: scope_cl.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: Some(idemp),
        source_note_ids: vec![obs_input.note.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let _fence_guard = if let Some(res) = reservation_opt {
                    Some(
                        room_fences
                            .consume_reservation(&scope_cl, &obs_input.note, res, &identity)
                            .await?,
                    )
                } else {
                    None
                };

                let live_space = load_space_record(tx, &scope_cl.space_id).await?;
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &obs_input.note).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
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

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
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
                        .bind(info.byte_size as i64)
                        .bind(digest.as_bytes().as_slice())
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
                        .bind(info.byte_size as i64)
                        .bind(digest.as_bytes().as_slice())
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
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
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
                            changed_fields: BTreeMap::new(),
                        }],
                    },
                    vec![obs_input.note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)?;
                let stored_resp = StoredExternalObsOutcomeV1::Committed(StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: obs_input.note.clone(),
                        revision: new_rev.clone(),
                    },
                    receipt,
                });
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

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
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![obs_input.note],
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    match store
        .submit_write_command::<StoredExternalObsOutcomeV1>(&ctx.budget, intent)
        .await
    {
        Ok(StoredExternalObsOutcomeV1::Committed(c)) => {
            Ok(ExternalObservationResult::Committed(c.into_committed()))
        }
        Ok(StoredExternalObsOutcomeV1::NoChange { revision }) => {
            Ok(ExternalObservationResult::NoChange { revision })
        }
        Ok(StoredExternalObsOutcomeV1::Conflict { current }) => {
            Ok(ExternalObservationResult::Conflict { current })
        }
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. })) => {
            Ok(ExternalObservationResult::Conflict { current })
        }
        Err(other) => Err(other),
    }
}

pub(crate) async fn update_space_schema_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<UpdateSpaceSchema>,
) -> Result<Committed<SpaceSchemaRevision>, PortError> {
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

    let space_rec = store.read_space(&ctx.scope().space_id).await?;
    space_rec.scope.check(ctx.scope())?;

    let ticket = store
        .stage_blob(
            &space_rec.scope,
            space_rec.active_epoch,
            &info.prepared_blob,
        )
        .await?;
    let staged_bytes = ticket.compressed_size;

    let mut fp_hasher = blake3::Hasher::new();
    fp_hasher.update(request.input.schema_note.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(descriptor_fp.as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(info.prepared_blob.digest.as_bytes());
    let idemp = derive_command_identity_spec(
        &request.identity,
        "update_space_schema",
        fp_hasher.finalize().as_bytes(),
    );

    let scope_cl = space_rec.scope.clone();
    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input;

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
                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &parent_id,
                    DocClass::UserDoc,
                    None,
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;

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

                let existing_note =
                    load_note_head_row_opt_tx(tx, &scope_cl.space_id, &input.schema_note).await?;
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

                let op_kind = if existing_note.is_some() {
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
                    "edit"
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

    let stored: StoredCommittedSchemaRevV1 =
        store.submit_write_command(&ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn get_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: GetNote,
) -> Result<NoteSnapshot, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let req_note = request.note.clone();
    let req_rev_opt = request.revision.clone();
    let causal = request.causal.clone();

    let (rev_id, live_facts, lifecycle, digest, parent_opt, byte_size, fields, diagnostics) = store
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
                            let _ = validate_snapshot_cutoff_tx(tx, &scope, Some(r.seq())).await?;
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
                let (live_facts, _) = build_resource_facts_tx(
                    tx,
                    &space_rec.space,
                    &live_head.parent_folder_id,
                    live_head.doc_class,
                    live_head.ability_id.clone(),
                    false,
                )
                .await?;
                auth.authorize_read(&live_facts)?;

                let target_rev_id = req_rev_opt.unwrap_or_else(|| live_head.head_rev_id.clone());
                let meta_bytes: Option<Vec<u8>> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT metadata_msgpack FROM revisions
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
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT metadata_msgpack FROM revisions
                         WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(target_rev_id.as_str())
                    .bind(req_note.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_get_note_rev", err.to_string()))?,
                };

                let Some(raw_meta) = meta_bytes else {
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
                let parent_opt = (!nm.is_root_child).then_some(nm.parent_folder_id);
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

                Ok((
                    target_rev_id,
                    live_facts,
                    effective_lc,
                    digest,
                    parent_opt,
                    nm.byte_size,
                    fields,
                    nm.diagnostics,
                ))
            })
        })
        .await?;

    let raw_bytes = store.read_verified_blob(ctx.scope(), digest).await?;
    let content = String::from_utf8(raw_bytes)
        .map_err(|_| internal_not_committed("get_note_utf8", "note carrier is not valid UTF-8"))?;

    // Re-check live purge fence AFTER CAS read so a concurrent purge never leaks purged content!
    let scope_recheck = ctx.scope().clone();
    let note_recheck = request.note.clone();
    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                if is_note_purge_fenced_tx(tx, &scope_recheck.space_id, note_recheck.as_str())
                    .await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(())
            })
        })
        .await?;

    let document = ClassifiedDocument::from_canonical(
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

    Ok(NoteSnapshot {
        document,
        parent: parent_opt,
        byte_size,
        fields,
        diagnostics,
    })
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
                    let Ok((live_facts, live_anc)) = folder_cache
                        .build_resource_facts_tx(
                            tx,
                            &space_rec.space,
                            &live_head.parent_folder_id,
                            live_head.doc_class,
                            live_head.ability_id.clone(),
                            true,
                        )
                        .await
                    else {
                        out.push(None);
                        continue;
                    };

                    let Ok(Some(hist_rev)) =
                        read_immutable_revision_tx(tx, &scope, "note", nid.as_str(), valid_cut)
                            .await
                    else {
                        out.push(None);
                        continue;
                    };
                    let RevisionMetadataPayload::Note(nm) = hist_rev.metadata.payload else {
                        out.push(None);
                        continue;
                    };
                    if nm.lifecycle != Lifecycle::Active || nm.doc_class == DocClass::EncryptedNote
                    {
                        out.push(None);
                        continue;
                    }
                    let Some(digest) = nm.content_digest else {
                        out.push(None);
                        continue;
                    };

                    let Ok(cmeta) = ClassifiedMetadata::from_canonical(
                        NoteRef {
                            space_id: scope.space_id.clone(),
                            note_id: nid.clone(),
                        },
                        hist_rev.revision_id,
                        live_facts,
                        Lifecycle::Active,
                        digest,
                    ) else {
                        out.push(None);
                        continue;
                    };
                    let Ok(search_meta) = ClassEgressFence::search_metadata(cmeta, &auth) else {
                        out.push(None);
                        continue;
                    };

                    let path = if live_anc.folder_path.is_empty() {
                        format!("{}.md", nm.slug)
                    } else {
                        format!("{}/{}.md", live_anc.folder_path, nm.slug)
                    };
                    out.push(Some((
                        nid,
                        SearchMetadataPlan {
                            search_meta,
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
        let Some((nid, plan)) = slot else {
            hydrated.push(None);
            continue;
        };
        let Ok(raw_bytes) = store.read_verified_blob(ctx.scope(), plan.digest).await else {
            hydrated.push(None);
            continue;
        };
        let Ok(carrier) = String::from_utf8(raw_bytes) else {
            hydrated.push(None);
            continue;
        };
        // Re-check live visibility fence after reading CAS blob!
        if !is_live_visible_impl(store, &ctx, &nid).await? {
            hydrated.push(None);
            continue;
        }
        let preview = extract_note_preview(&carrier, plan.doc_class);
        hydrated.push(Some(NoteCard {
            document: plan.search_meta,
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
    search_meta: notarium_core::classes::SearchMetadata,
    title: String,
    path: String,
    digest: ContentDigest,
    doc_class: DocClass,
}

async fn read_active_note_for_mutation(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note_id: &NoteId,
    preconditions: &Preconditions,
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
                let (facts, _) = build_resource_facts_tx(
                    tx,
                    &srec.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                auth.authorize_direct_write(&facts, &facts)?;
                Ok((srec, head))
            })
        })
        .await
}

async fn read_current_note_rev(
    store: &CanonicalStore,
    space_id: &notarium_core::ids::SpaceId,
    note_id: &NoteId,
) -> Result<Option<RevisionId>, PortError> {
    let sid = space_id.clone();
    let nid = note_id.clone();
    store
        .with_read_tx(|tx| {
            Box::pin(async move {
                let raw: Option<String> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT head_rev_id FROM note_heads WHERE space_id = ? AND note_id = ?",
                    )
                    .bind(sid.as_str())
                    .bind(nid.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_read_cur_rev", err.to_string())
                    })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT head_rev_id FROM note_heads WHERE space_id = $1 AND note_id = $2",
                    )
                    .bind(sid.as_str())
                    .bind(nid.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_read_cur_rev", err.to_string()))?,
                };
                match raw {
                    Some(s) => Ok(Some(RevisionId::parse(&s).map_err(|_| {
                        internal_not_committed("corrupt_cur_rev", "invalid head_rev_id")
                    })?)),
                    None => Ok(None),
                }
            })
        })
        .await
}

pub(crate) async fn try_replay_completed_receipt<R: serde::de::DeserializeOwned>(
    store: &CanonicalStore,
    scope: &notarium_core::model::HistoryScope,
    idemp: &crate::writer::CommandIdentitySpec,
    budget: Option<&notarium_core::ports::CallBudget>,
) -> Result<Option<R>, PortError> {
    let scope_cl = scope.clone();
    let idemp_cl = idemp.clone();
    let blob_opt = store
        .with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_cl.space_id).await?;
                srec.scope.check(&scope_cl)?;
                let Some(existing) =
                    crate::writer::lookup_command_receipt_tx(tx, &scope_cl, &idemp_cl).await?
                else {
                    return Ok(None);
                };
                if existing.command_hash != idemp_cl.command_hash {
                    return Err(DomainError::IdempotencyKeyReused.into());
                }
                if existing.status == "completed" {
                    Ok(Some(existing.response_blob))
                } else {
                    Ok(None)
                }
            })
        })
        .await?;

    match blob_opt {
        Some(bytes) => {
            let decoded = rmp_serde::from_slice(&bytes).map_err(|err| {
                internal_not_committed("decode_replayed_receipt", err.to_string())
            })?;
            Ok(Some(decoded))
        }
        None => Ok(None),
    }
}

fn enforce_protected_frontmatter_unchanged(
    before: &str,
    after: &str,
    class: DocClass,
) -> Result<(), PortError> {
    let old_hdr = notarium_syntax::frontmatter::analyze(before, class)?;
    let new_hdr = notarium_syntax::frontmatter::analyze(after, class)?;
    let empty = BTreeMap::new();
    let old_map = old_hdr.fields.as_ref().unwrap_or(&empty);
    let new_map = new_hdr.fields.as_ref().unwrap_or(&empty);
    for key in old_map.keys().chain(new_map.keys()) {
        if old_map.get(key) != new_map.get(key) {
            authorize_field_key(key)?;
        }
    }
    Ok(())
}

async fn update_ability_package_slug_tx(
    tx: &mut BackendConn<'_>,
    space_id: &notarium_core::ids::SpaceId,
    ability_id: &notarium_core::ids::AbilityId,
    new_slug_fold: &str,
    new_slug: &str,
    report_parent: Option<notarium_core::ids::FolderId>,
) -> Result<(), PortError> {
    let conflict: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM ability_packages
             WHERE space_id = ? AND slug_fold = ? AND lifecycle_state = 'active' AND ability_id <> ?
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(new_slug_fold)
        .bind(ability_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_ability_rename_check", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM ability_packages
             WHERE space_id = $1 AND slug_fold = $2 AND lifecycle_state = 'active' AND ability_id <> $3
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(new_slug_fold)
        .bind(ability_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_ability_rename_check", err.to_string()))?,
    };
    if conflict.is_some() {
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

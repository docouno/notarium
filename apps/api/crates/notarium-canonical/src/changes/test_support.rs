use std::{collections::BTreeMap, time::Duration};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::{
        ChatThreadId, ContentDigest, FolderId, HistoryIncarnation, LeaseEpoch, NoteId, PrincipalId,
        RequestId, RevisionId, SpaceSeq, ThreadEntrySeq,
    },
    model::{HistoryScope, Lifecycle},
    ports::{CallBudget, Cancellation, ChatThreadKind, CommandSeqRange},
    query::{FieldObservation, FieldValue},
};

use crate::{
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, activate_and_bind_blob_ref_tx,
        release_owner_blob_refs_tx,
    },
    changes::{ChangedNoteSummaryV1, EffectBodyV1, build_effect_payload_draft},
    codec::{
        NoteRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload,
        ThreadRevisionMetadata, chat_thread_kind_to_db, doc_class_to_db, encode_timestamp_parts,
        internal_not_committed, lifecycle_to_db, new_prefixed_hex_id, new_revision_id,
        normalize_slug_key, normalize_title_key, now_utc_timestamp,
    },
    runtime::{CanonicalStore, bump_space_seq_checked, insert_revision_row, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct SyntheticNoteSpec {
    pub note_id: NoteId,
    pub parent_folder: Option<FolderId>,
    pub slug: String,
    pub title: String,
    pub doc_class: DocClass,
    pub lifecycle: Lifecycle,
    pub carrier: String,
    pub fields: BTreeMap<String, FieldObservation<FieldValue>>,
}

impl CanonicalStore {
    #[doc(hidden)]
    pub async fn commit_synthetic_note_batch_for_test(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        actor: &PrincipalId,
        notes: Vec<SyntheticNoteSpec>,
    ) -> Result<(CommandSeqRange, Vec<(NoteId, RevisionId)>), PortError> {
        let mut staged_items = Vec::with_capacity(notes.len());
        let mut total_staged_bytes = 0u64;
        let space = self.read_space(&scope.space_id).await?;
        space.scope.check(scope)?;
        if space.active_epoch != active_epoch {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }

        for spec in notes {
            let (raw_fields, diagnostics) = if spec.doc_class == DocClass::EncryptedNote {
                (None, Vec::new())
            } else {
                let header = notarium_syntax::frontmatter::analyze(&spec.carrier, spec.doc_class)?;
                let diagnostics = header
                    .diagnostic
                    .map(|reason| Diagnostic {
                        reason,
                        location: None,
                    })
                    .into_iter()
                    .collect();
                (header.fields, diagnostics)
            };
            let prep = self.prepare_blob(spec.carrier.as_bytes())?;
            let ticket = self
                .stage_blob_for_batch_prechecked(scope, active_epoch, &prep)
                .await?;
            total_staged_bytes = total_staged_bytes.saturating_add(ticket.compressed_size);
            staged_items.push((spec, prep.digest, ticket, raw_fields, diagnostics));
        }

        let budget = CallBudget {
            request: RequestId::from_bytes(crate::codec::csprng_16()?),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        };
        let scope_cl = scope.clone();
        let actor_cl = actor.clone();

        let intent = PreparedWriteIntent {
            scope: scope_cl,
            active_epoch,
            idempotency: None,
            source_note_ids: staged_items
                .iter()
                .map(|(spec, ..)| spec.note_id.clone())
                .collect(),
            staged_bytes: total_staged_bytes,
            required_semantic_cut: None,
            execute: Box::new(move |tx, ctx| {
                Box::pin(async move {
                    let count = staged_items.len() as u64;
                    let (first_seq, visibility_seq) = ctx.preview_seq_range(count)?;
                    let cmd_range = CommandSeqRange::new(first_seq, visibility_seq)?;
                    let ts = now_utc_timestamp()?;
                    let (sec, nsec) = encode_timestamp_parts(ts);
                    let cmd_id = new_prefixed_hex_id("cmd_")?;
                    let payload_id = new_prefixed_hex_id("pay_")?;

                    let mut events = Vec::with_capacity(staged_items.len());
                    let mut summaries = Vec::with_capacity(staged_items.len());
                    let mut owner_notes = Vec::with_capacity(staged_items.len());
                    let mut pairs_raw: Vec<(String, String)> =
                        Vec::with_capacity(staged_items.len());

                    for (spec, digest, ticket, raw_fields, diagnostics) in staged_items {
                        let seq = ctx.alloc_next_seq()?;
                        let rev_id = new_revision_id()?;
                        let is_root_child = spec
                            .parent_folder
                            .as_ref()
                            .is_none_or(|p| p == &ctx.root_folder_id);
                        let parent_id = spec
                            .parent_folder
                            .unwrap_or_else(|| ctx.root_folder_id.clone());
                        let slug_fold = normalize_slug_key(&spec.slug)?;
                        let title_fold = normalize_title_key(&spec.title);
                        let byte_size = spec.carrier.len() as u64;

                        // Check if note already exists in `note_heads`.
                        let existing_rev: Option<String> = match tx {
                            BackendConn::Sqlite(conn) => sqlx::query_scalar(
                                "SELECT head_rev_id FROM note_heads WHERE space_id = ? AND note_id = ?",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(spec.note_id.as_str())
                            .fetch_optional(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_chk_nh", err.to_string()))?,
                            BackendConn::Postgres(conn) => sqlx::query_scalar(
                                "SELECT head_rev_id FROM note_heads WHERE space_id = $1 AND note_id = $2",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(spec.note_id.as_str())
                            .fetch_optional(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_chk_nh", err.to_string()))?,
                        };

                        let op_kind = if existing_rev.is_some() {
                            "edit"
                        } else {
                            "create"
                        };
                        let parent_rev = match &existing_rev {
                            Some(r) => Some(RevisionId::parse(r).map_err(|_| {
                                internal_not_committed("corrupt_prev_rev", "invalid RevisionId")
                            })?),
                            None => None,
                        };

                        let claim = BlobReferenceClaim {
                            owner_kind: BlobOwnerKind::NoteRevision,
                            owner_id: spec.note_id.as_str().to_owned(),
                            owner_rev_id: rev_id.as_str().to_owned(),
                            resource_key: "body".to_owned(),
                            ticket,
                        };
                        let claim_ticket = claim.ticket.clone();
                        activate_and_bind_blob_ref_tx(
                            tx,
                            &ctx.scope,
                            ctx.active_epoch,
                            &claim,
                            seq,
                        )
                        .await?;
                        ctx.record_staged_ticket(claim_ticket);

                        let dc_str = doc_class_to_db(spec.doc_class);
                        let lc_str = lifecycle_to_db(spec.lifecycle);
                        let seq_i64 = seq.get() as i64;
                        let size_i64 = byte_size as i64;

                        match (&mut *tx, existing_rev.is_some()) {
                            (BackendConn::Sqlite(conn), false) => {
                                sqlx::query(
                                    "INSERT INTO note_heads (
                                        space_id, note_id, parent_folder_id, slug, slug_fold,
                                        title, title_fold, doc_class, ability_id, head_rev_id,
                                        content_blake3, byte_size, lifecycle_state, visibility_mask,
                                        settlement_successor_id, created_seq, updated_seq,
                                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec,
                                        last_actor_id
                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
                                )
                                .bind(ctx.scope.space_id.as_str())
                                .bind(spec.note_id.as_str())
                                .bind(parent_id.as_str())
                                .bind(&spec.slug)
                                .bind(&slug_fold)
                                .bind(&spec.title)
                                .bind(&title_fold)
                                .bind(dc_str)
                                .bind(rev_id.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(size_i64)
                                .bind(lc_str)
                                .bind(seq_i64)
                                .bind(seq_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(sec)
                                .bind(nsec)
                                .bind(actor_cl.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| internal_not_committed("sqlite_ins_nh", err.to_string()))?;
                            }
                            (BackendConn::Sqlite(conn), true) => {
                                sqlx::query(
                                    "UPDATE note_heads
                                     SET parent_folder_id = ?, slug = ?, slug_fold = ?, title = ?, title_fold = ?,
                                         doc_class = ?, head_rev_id = ?, content_blake3 = ?, byte_size = ?,
                                         lifecycle_state = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?,
                                         last_actor_id = ?
                                     WHERE space_id = ? AND note_id = ?",
                                )
                                .bind(parent_id.as_str())
                                .bind(&spec.slug)
                                .bind(&slug_fold)
                                .bind(&spec.title)
                                .bind(&title_fold)
                                .bind(dc_str)
                                .bind(rev_id.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(size_i64)
                                .bind(lc_str)
                                .bind(seq_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(actor_cl.as_str())
                                .bind(ctx.scope.space_id.as_str())
                                .bind(spec.note_id.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| internal_not_committed("sqlite_upd_nh", err.to_string()))?;
                            }
                            (BackendConn::Postgres(conn), false) => {
                                sqlx::query(
                                    "INSERT INTO note_heads (
                                        space_id, note_id, parent_folder_id, slug, slug_fold,
                                        title, title_fold, doc_class, ability_id, head_rev_id,
                                        content_blake3, byte_size, lifecycle_state, visibility_mask,
                                        settlement_successor_id, created_seq, updated_seq,
                                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec,
                                        last_actor_id
                                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, $12, 0, NULL, $13, $13, $14, $15, $14, $15, $16)",
                                )
                                .bind(ctx.scope.space_id.as_str())
                                .bind(spec.note_id.as_str())
                                .bind(parent_id.as_str())
                                .bind(&spec.slug)
                                .bind(&slug_fold)
                                .bind(&spec.title)
                                .bind(&title_fold)
                                .bind(dc_str)
                                .bind(rev_id.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(size_i64)
                                .bind(lc_str)
                                .bind(seq_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(actor_cl.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| internal_not_committed("pg_ins_nh", err.to_string()))?;
                            }
                            (BackendConn::Postgres(conn), true) => {
                                sqlx::query(
                                    "UPDATE note_heads
                                     SET parent_folder_id = $1, slug = $2, slug_fold = $3, title = $4, title_fold = $5,
                                         doc_class = $6, head_rev_id = $7, content_blake3 = $8, byte_size = $9,
                                         lifecycle_state = $10, updated_seq = $11, updated_at_sec = $12, updated_at_nsec = $13,
                                         last_actor_id = $14
                                     WHERE space_id = $15 AND note_id = $16",
                                )
                                .bind(parent_id.as_str())
                                .bind(&spec.slug)
                                .bind(&slug_fold)
                                .bind(&spec.title)
                                .bind(&title_fold)
                                .bind(dc_str)
                                .bind(rev_id.as_str())
                                .bind(digest.as_bytes().as_slice())
                                .bind(size_i64)
                                .bind(lc_str)
                                .bind(seq_i64)
                                .bind(sec)
                                .bind(nsec)
                                .bind(actor_cl.as_str())
                                .bind(ctx.scope.space_id.as_str())
                                .bind(spec.note_id.as_str())
                                .execute(&mut **conn)
                                .await
                                .map_err(|err| internal_not_committed("pg_upd_nh", err.to_string()))?;
                            }
                        }

                        let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                            NoteRevisionMetadata {
                                note_id: spec.note_id.clone(),
                                parent_folder_id: parent_id,
                                is_root_child,
                                slug: spec.slug,
                                slug_fold,
                                title: spec.title,
                                doc_class: spec.doc_class,
                                ability_id: None,
                                lifecycle: spec.lifecycle,
                                visibility_mask: 0,
                                byte_size,
                                content_digest: Some(digest),
                                schema_revision: None,
                                raw_fields,
                                evaluated_fields: spec.fields.clone(),
                                diagnostics,
                            },
                        ))
                        .encode()?;

                        // Note: `visibility_seq` for ALL events in the atomic command is `visibility_seq` (`last_seq`)!
                        insert_revision_row(
                            tx,
                            &ctx.scope,
                            &rev_id,
                            "note",
                            spec.note_id.as_str(),
                            seq,
                            visibility_seq,
                            parent_rev.as_ref(),
                            None,
                            Some(digest),
                            &meta,
                            &actor_cl,
                            None,
                            ts,
                        )
                        .await?;

                        events.push(BatchEventDraft {
                            space_seq: seq,
                            entity_type: "note".to_owned(),
                            entity_id: spec.note_id.as_str().to_owned(),
                            op_kind: op_kind.to_owned(),
                            rev_id: rev_id.clone(),
                            lifecycle: spec.lifecycle,
                            doc_class: Some(spec.doc_class),
                        });
                        summaries.push(ChangedNoteSummaryV1 {
                            note_id: spec.note_id.clone(),
                            revision: rev_id.clone(),
                            rank_version: ContentDigest::from_bytes([0u8; 32]),
                            lifecycle: spec.lifecycle,
                            doc_class: spec.doc_class,
                            changed_fields: spec.fields,
                        });
                        owner_notes.push(spec.note_id.clone());
                        pairs_raw
                            .push((spec.note_id.as_str().to_owned(), rev_id.as_str().to_owned()));
                    }

                    let cp = build_effect_payload_draft(
                        payload_id,
                        ctx.scope.clone(),
                        cmd_range,
                        "synthetic_note_batch",
                        EffectBodyV1::Notes { notes: summaries },
                        owner_notes.clone(),
                    )?;

                    let resp = CanonicalStore::encode_command_outcome(&(
                        first_seq.get(),
                        visibility_seq.get(),
                        pairs_raw,
                    ))?;

                    Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "synthetic_note_batch".to_owned(),
                        events,
                        change_payload: Some(cp),
                        receipt_detail_blob: Some(resp.clone()),
                        receipt_sanitized_blob: resp.clone(),
                        receipt_owner_note_ids: owner_notes,
                        response_bytes: resp,
                    })
                })
            }),
        };

        let (first_u64, last_u64, pairs_raw): (u64, u64, Vec<(String, String)>) =
            self.submit_write_command(&budget, intent).await?;
        let range = CommandSeqRange::new(SpaceSeq::new(first_u64)?, SpaceSeq::new(last_u64)?)?;
        let mut pairs = Vec::with_capacity(pairs_raw.len());
        for (n_s, r_s) in pairs_raw {
            pairs.push((
                NoteId::parse(&n_s)
                    .map_err(|_| internal_not_committed("parse_nid", "invalid NoteId"))?,
                RevisionId::parse(&r_s)
                    .map_err(|_| internal_not_committed("parse_rid", "invalid RevisionId"))?,
            ));
        }
        Ok((range, pairs))
    }

    #[doc(hidden)]
    pub async fn commit_synthetic_thread_for_test(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        thread_id: &ChatThreadId,
        owner: &PrincipalId,
        title: &str,
        head_leaf: u64,
    ) -> Result<(SpaceSeq, RevisionId), PortError> {
        let budget = CallBudget {
            request: RequestId::from_bytes(crate::codec::csprng_16()?),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        };
        let scope_cl = scope.clone();
        let tid_cl = thread_id.clone();
        let owner_cl = owner.clone();
        let title_cl = title.to_owned();
        let leaf_seq = ThreadEntrySeq::new(head_leaf)?;

        let intent = PreparedWriteIntent {
            scope: scope_cl,
            active_epoch,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(move |tx, ctx| {
                Box::pin(async move {
                    let seq = ctx.alloc_next_seq()?;
                    let rev_id = new_revision_id()?;
                    let ts = now_utc_timestamp()?;
                    let (sec, nsec) = encode_timestamp_parts(ts);
                    let seq_i64 = seq.get() as i64;
                    let leaf_i64 = leaf_seq.get() as i64;
                    let next_entry_i64 = (leaf_seq.get() + 1) as i64;
                    let kind_str = chat_thread_kind_to_db(ChatThreadKind::Personal);

                    let exists: Option<i64> = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_scalar(
                            "SELECT 1 FROM chat_threads WHERE space_id = ? AND thread_id = ?",
                        )
                        .bind(ctx.scope.space_id.as_str())
                        .bind(tid_cl.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_chk_th", err.to_string()))?,
                        BackendConn::Postgres(conn) => sqlx::query_scalar(
                            "SELECT 1::BIGINT FROM chat_threads WHERE space_id = $1 AND thread_id = $2",
                        )
                        .bind(ctx.scope.space_id.as_str())
                        .bind(tid_cl.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_chk_th", err.to_string()))?,
                    };

                    let op_kind = if exists.is_some() { "edit" } else { "create" };

                    match (&mut *tx, exists.is_some()) {
                        (BackendConn::Sqlite(conn), false) => {
                            sqlx::query(
                                "INSERT INTO chat_threads (
                                    space_id, history_incarnation, thread_id, kind, owner_id,
                                    project_folder_id, title, head_leaf_seq, head_rev_id,
                                    next_entry_seq, active_run_id, ext_space_tainted_mask,
                                    created_seq, updated_seq, created_at_sec, created_at_nsec,
                                    updated_at_sec, updated_at_nsec
                                ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(ctx.scope.incarnation.as_bytes().as_slice())
                            .bind(tid_cl.as_str())
                            .bind(kind_str)
                            .bind(owner_cl.as_str())
                            .bind(&title_cl)
                            .bind(leaf_i64)
                            .bind(rev_id.as_str())
                            .bind(next_entry_i64)
                            .bind(seq_i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(sec)
                            .bind(nsec)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_ins_th", err.to_string()))?;
                        }
                        (BackendConn::Sqlite(conn), true) => {
                            sqlx::query(
                                "UPDATE chat_threads
                                 SET title = ?, head_leaf_seq = ?, head_rev_id = ?, updated_seq = ?,
                                     updated_at_sec = ?, updated_at_nsec = ?
                                 WHERE space_id = ? AND thread_id = ?",
                            )
                            .bind(&title_cl)
                            .bind(leaf_i64)
                            .bind(rev_id.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(ctx.scope.space_id.as_str())
                            .bind(tid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_upd_th", err.to_string())
                            })?;
                        }
                        (BackendConn::Postgres(conn), false) => {
                            sqlx::query(
                                "INSERT INTO chat_threads (
                                    space_id, history_incarnation, thread_id, kind, owner_id,
                                    project_folder_id, title, head_leaf_seq, head_rev_id,
                                    next_entry_seq, active_run_id, ext_space_tainted_mask,
                                    created_seq, updated_seq, created_at_sec, created_at_nsec,
                                    updated_at_sec, updated_at_nsec
                                ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, NULL, 0, $10, $10, $11, $12, $11, $12)",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(ctx.scope.incarnation.as_bytes().as_slice())
                            .bind(tid_cl.as_str())
                            .bind(kind_str)
                            .bind(owner_cl.as_str())
                            .bind(&title_cl)
                            .bind(leaf_i64)
                            .bind(rev_id.as_str())
                            .bind(next_entry_i64)
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_ins_th", err.to_string()))?;
                        }
                        (BackendConn::Postgres(conn), true) => {
                            sqlx::query(
                                "UPDATE chat_threads
                                 SET title = $1, head_leaf_seq = $2, head_rev_id = $3, updated_seq = $4,
                                     updated_at_sec = $5, updated_at_nsec = $6
                                 WHERE space_id = $7 AND thread_id = $8",
                            )
                            .bind(&title_cl)
                            .bind(leaf_i64)
                            .bind(rev_id.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(ctx.scope.space_id.as_str())
                            .bind(tid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_upd_th", err.to_string()))?;
                        }
                    }

                    let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Thread(
                        ThreadRevisionMetadata {
                            thread_id: tid_cl.clone(),
                            kind: ChatThreadKind::Personal,
                            owner_id: owner_cl.clone(),
                            project_folder_id: None,
                            title: title_cl,
                            head_leaf_seq: leaf_seq,
                            tainted: false,
                        },
                    ))
                    .encode()?;

                    insert_revision_row(
                        tx,
                        &ctx.scope,
                        &rev_id,
                        "thread",
                        tid_cl.as_str(),
                        seq,
                        seq,
                        None,
                        None,
                        None,
                        &meta,
                        &owner_cl,
                        None,
                        ts,
                    )
                    .await?;

                    let cmd_id = new_prefixed_hex_id("cmd_")?;
                    let resp = CanonicalStore::encode_command_outcome(&(
                        seq.get(),
                        rev_id.as_str().to_owned(),
                    ))?;
                    Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "synthetic_thread".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "thread".to_owned(),
                            entity_id: tid_cl.as_str().to_owned(),
                            op_kind: op_kind.to_owned(),
                            rev_id,
                            lifecycle: Lifecycle::Active,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp,
                    })
                })
            }),
        };

        let (seq_u64, rev_s): (u64, String) = self.submit_write_command(&budget, intent).await?;
        Ok((
            SpaceSeq::new(seq_u64)?,
            RevisionId::parse(&rev_s)
                .map_err(|_| internal_not_committed("parse_th_rev", "invalid RevisionId"))?,
        ))
    }

    #[doc(hidden)]
    pub async fn commit_synthetic_note_purge_for_test(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        note_id: &NoteId,
    ) -> Result<SpaceSeq, PortError> {
        let budget = CallBudget {
            request: RequestId::from_bytes(crate::codec::csprng_16()?),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(30),
        };
        let scope_cl = scope.clone();
        let nid_cl = note_id.clone();

        let intent = PreparedWriteIntent {
            scope: scope_cl,
            active_epoch,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(move |tx, ctx| {
                Box::pin(async move {
                    let seq = ctx.alloc_next_seq()?;
                    let purge_rev = new_revision_id()?;
                    let ts = now_utc_timestamp()?;
                    let (sec, nsec) = encode_timestamp_parts(ts);
                    let seq_i64 = seq.get() as i64;

                    // Collect all revision IDs to release CAS references cleanly.
                    let rev_ids: Vec<String> = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_scalar(
                            "SELECT rev_id FROM revisions
                             WHERE space_id = ? AND entity_type = 'note' AND entity_key = ?",
                        )
                        .bind(ctx.scope.space_id.as_str())
                        .bind(nid_cl.as_str())
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_purge_revs", err.to_string())
                        })?,
                        BackendConn::Postgres(conn) => sqlx::query_scalar(
                            "SELECT rev_id FROM revisions
                             WHERE space_id = $1 AND entity_type = 'note' AND entity_key = $2",
                        )
                        .bind(ctx.scope.space_id.as_str())
                        .bind(nid_cl.as_str())
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_purge_revs", err.to_string()))?,
                    };

                    for rid in &rev_ids {
                        let owner_key = format!("{}:{rid}", nid_cl.as_str());
                        let _ = release_owner_blob_refs_tx(
                            tx,
                            &ctx.scope.space_id,
                            BlobOwnerKind::NoteRevision,
                            &owner_key,
                        )
                        .await?;
                    }

                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE note_heads
                                 SET lifecycle_state = 'purged', content_blake3 = NULL, byte_size = 0,
                                     head_rev_id = ?, updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?
                                 WHERE space_id = ? AND note_id = ?",
                            )
                            .bind(purge_rev.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_purge_nh", err.to_string()))?;

                            sqlx::query(
                                "DELETE FROM revisions
                                 WHERE space_id = ? AND entity_type = 'note' AND entity_key = ?",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_del_revs", err.to_string())
                            })?;

                            sqlx::query(
                                "INSERT INTO revision_purge_fences (
                                    space_id, history_incarnation, note_id, purge_seq,
                                    old_identity_state, successor_note_id, created_at_sec, created_at_nsec
                                ) VALUES (?, ?, ?, ?, 'purged', NULL, ?, ?)",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(ctx.scope.incarnation.as_bytes().as_slice())
                            .bind(nid_cl.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_ins_pf", err.to_string()))?;

                            sqlx::query(
                                "UPDATE change_payloads
                                 SET erased_by_purge = 1, effect_msgpack = NULL
                                 WHERE space_id = ? AND payload_id IN (
                                     SELECT payload_id FROM payload_owners
                                     WHERE space_id = ? AND payload_kind = 'change_payload' AND note_id = ?
                                 )",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_erase_cp", err.to_string()))?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE note_heads
                                 SET lifecycle_state = 'purged', content_blake3 = NULL, byte_size = 0,
                                     head_rev_id = $1, updated_seq = $2, updated_at_sec = $3, updated_at_nsec = $4
                                 WHERE space_id = $5 AND note_id = $6",
                            )
                            .bind(purge_rev.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_purge_nh", err.to_string()))?;

                            sqlx::query(
                                "DELETE FROM revisions
                                 WHERE space_id = $1 AND entity_type = 'note' AND entity_key = $2",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_del_revs", err.to_string())
                            })?;

                            sqlx::query(
                                "INSERT INTO revision_purge_fences (
                                    space_id, history_incarnation, note_id, purge_seq,
                                    old_identity_state, successor_note_id, created_at_sec, created_at_nsec
                                ) VALUES ($1, $2, $3, $4, 'purged', NULL, $5, $6)",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(ctx.scope.incarnation.as_bytes().as_slice())
                            .bind(nid_cl.as_str())
                            .bind(seq_i64)
                            .bind(sec)
                            .bind(nsec)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_ins_pf", err.to_string()))?;

                            sqlx::query(
                                "UPDATE change_payloads
                                 SET erased_by_purge = 1, effect_msgpack = NULL
                                 WHERE space_id = $1 AND payload_id IN (
                                     SELECT payload_id FROM payload_owners
                                     WHERE space_id = $1 AND payload_kind = 'change_payload' AND note_id = $2
                                 )",
                            )
                            .bind(ctx.scope.space_id.as_str())
                            .bind(nid_cl.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_erase_cp", err.to_string()))?;
                        }
                    }

                    let cmd_id = new_prefixed_hex_id("cmd_")?;
                    let resp = CanonicalStore::encode_command_outcome(&seq.get())?;
                    Ok(ItemCommitArtifacts {
                        command_id: cmd_id,
                        command_kind: "purge_note".to_owned(),
                        events: vec![BatchEventDraft {
                            space_seq: seq,
                            entity_type: "note".to_owned(),
                            entity_id: nid_cl.as_str().to_owned(),
                            op_kind: "purge".to_owned(),
                            rev_id: purge_rev,
                            lifecycle: Lifecycle::Purged,
                            doc_class: None,
                        }],
                        change_payload: None,
                        receipt_detail_blob: None,
                        receipt_sanitized_blob: resp.clone(),
                        receipt_owner_note_ids: Vec::new(),
                        response_bytes: resp,
                    })
                })
            }),
        };

        let seq_u64: u64 = self.submit_write_command(&budget, intent).await?;
        Ok(SpaceSeq::new(seq_u64)?)
    }

    #[doc(hidden)]
    pub async fn fast_forward_space_to_seq_for_test(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        target_seq: SpaceSeq,
    ) -> Result<(), PortError> {
        let scope_cl = scope.clone();
        self.with_write_tx(|tx| {
            Box::pin(async move {
                let rec = load_space_record(tx, &scope_cl.space_id).await?;
                rec.scope.check(&scope_cl)?;
                if target_seq <= rec.last_seq {
                    return Ok(());
                }
                let first_seq = rec.last_seq.checked_next()?;
                let delta = target_seq.get() - rec.last_seq.get();
                bump_space_seq_checked(tx, &scope_cl, active_epoch, delta, rec.last_seq).await?;

                let cmd_id = new_prefixed_hex_id("cmd_ff_")?;
                let now_ms = crate::codec::now_unix_ms()?;
                let first_i64 = first_seq.get() as i64;
                let last_i64 = target_seq.get() as i64;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO change_commands (
                                space_id, history_incarnation, command_id, first_seq, last_seq,
                                command_kind, payload_id, committed_at_ms
                            ) VALUES (?, ?, ?, ?, ?, 'fast_forward_test', NULL, ?)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(&cmd_id)
                        .bind(first_i64)
                        .bind(last_i64)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_ff_cmd", err.to_string()))?;

                        for s in first_seq.get()..=target_seq.get() {
                            let rev = new_revision_id()?;
                            sqlx::query(
                                "INSERT INTO change_log (
                                    space_id, space_seq, history_incarnation, command_id,
                                    command_first_seq, command_last_seq, entity_type, entity_id,
                                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                                ) VALUES (?, ?, ?, ?, ?, ?, 'folder', ?, 'edit', ?, 'active', NULL, NULL, ?)",
                            )
                            .bind(scope_cl.space_id.as_str())
                            .bind(s as i64)
                            .bind(scope_cl.incarnation.as_bytes().as_slice())
                            .bind(&cmd_id)
                            .bind(first_i64)
                            .bind(last_i64)
                            .bind(rec.root_folder_id.as_str())
                            .bind(rev.as_str())
                            .bind(now_ms)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("sqlite_ff_ev", err.to_string()))?;
                        }
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO change_commands (
                                space_id, history_incarnation, command_id, first_seq, last_seq,
                                command_kind, payload_id, committed_at_ms
                            ) VALUES ($1, $2, $3, $4, $5, 'fast_forward_test', NULL, $6)",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(&cmd_id)
                        .bind(first_i64)
                        .bind(last_i64)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_ff_cmd", err.to_string()))?;

                        for s in first_seq.get()..=target_seq.get() {
                            let rev = new_revision_id()?;
                            sqlx::query(
                                "INSERT INTO change_log (
                                    space_id, space_seq, history_incarnation, command_id,
                                    command_first_seq, command_last_seq, entity_type, entity_id,
                                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                                ) VALUES ($1, $2, $3, $4, $5, $6, 'folder', $7, 'edit', $8, 'active', NULL, NULL, $9)",
                            )
                            .bind(scope_cl.space_id.as_str())
                            .bind(s as i64)
                            .bind(scope_cl.incarnation.as_bytes().as_slice())
                            .bind(&cmd_id)
                            .bind(first_i64)
                            .bind(last_i64)
                            .bind(rec.root_folder_id.as_str())
                            .bind(rev.as_str())
                            .bind(now_ms)
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_ff_ev", err.to_string()))?;
                        }
                    }
                }
                Ok(())
            })
        })
        .await?;

        self.inner
            .broadcast_hub
            .publish(crate::changes::BroadcastSignal::Committed {
                scope: scope.clone(),
                new_last_seq: target_seq,
                targets: crate::changes::CommittedTargets::All,
            });
        Ok(())
    }

    #[doc(hidden)]
    pub async fn evict_retained_revision_for_test(
        &self,
        scope: &HistoryScope,
        entity_type: &str,
        entity_key: &str,
        rev_id: &RevisionId,
    ) -> Result<(), PortError> {
        let sid = scope.space_id.clone();
        let et = entity_type.to_owned();
        let ek = entity_key.to_owned();
        let rid = rev_id.clone();
        self.with_write_tx(|tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "DELETE FROM revisions
                             WHERE space_id = ? AND entity_type = ? AND entity_key = ? AND rev_id = ?",
                        )
                        .bind(sid.as_str())
                        .bind(&et)
                        .bind(&ek)
                        .bind(rid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_evict_rev", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "DELETE FROM revisions
                             WHERE space_id = $1 AND entity_type = $2 AND entity_key = $3 AND rev_id = $4",
                        )
                        .bind(sid.as_str())
                        .bind(&et)
                        .bind(&ek)
                        .bind(rid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_evict_rev", err.to_string()))?;
                    }
                }
                Ok(())
            })
        })
        .await
    }

    #[doc(hidden)]
    pub async fn rotate_incarnation_for_test(
        &self,
        scope: &HistoryScope,
        new_incarnation: HistoryIncarnation,
    ) -> Result<HistoryScope, PortError> {
        let scope_cl = scope.clone();
        let ceiling = self
            .with_write_tx(|tx| {
                Box::pin(async move {
                    let rec = load_space_record(tx, &scope_cl.space_id).await?;
                    rec.scope.check(&scope_cl)?;
                    match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query(
                                "UPDATE spaces SET history_incarnation = ? WHERE space_id = ?",
                            )
                            .bind(new_incarnation.as_bytes().as_slice())
                            .bind(scope_cl.space_id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_rot_inc", err.to_string())
                            })?;
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query(
                                "UPDATE spaces SET history_incarnation = $1 WHERE space_id = $2",
                            )
                            .bind(new_incarnation.as_bytes().as_slice())
                            .bind(scope_cl.space_id.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| internal_not_committed("pg_rot_inc", err.to_string()))?;
                        }
                    }
                    Ok(rec.last_seq)
                })
            })
            .await?;

        let new_scope = HistoryScope {
            space_id: scope.space_id.clone(),
            incarnation: new_incarnation,
        };
        self.inner
            .broadcast_hub
            .publish(crate::changes::BroadcastSignal::IncarnationChanged {
                new_scope: new_scope.clone(),
                ceiling,
            });
        Ok(new_scope)
    }

    #[doc(hidden)]
    pub async fn read_all_change_log_seqs_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<Vec<u64>, PortError> {
        let scope_cl = scope.clone();
        self.with_read_tx(|tx| {
            Box::pin(async move {
                let raw: Vec<i64> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT space_seq FROM change_log
                         WHERE space_id = ? AND history_incarnation = ?
                         ORDER BY space_seq ASC",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(scope_cl.incarnation.as_bytes().as_slice())
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_all_seqs", err.to_string()))?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT space_seq FROM change_log
                         WHERE space_id = $1 AND history_incarnation = $2
                         ORDER BY space_seq ASC",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(scope_cl.incarnation.as_bytes().as_slice())
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_all_seqs", err.to_string()))?,
                };
                Ok(raw.into_iter().map(|v| v as u64).collect())
            })
        })
        .await
    }
}

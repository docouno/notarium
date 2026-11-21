//! Read-only search carriers over canonical history and live lifecycle fences.

use super::{has_post_cutoff_purge_of_prior_note_tx, list_note_keys_at_or_below_cutoff_tx};
use crate::{
    codec::{
        NoteRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload, i64_to_space_seq,
        internal_not_committed,
    },
    domain::common::{
        CommandDeadline, FolderAncestryCache, extract_note_preview, load_note_heads_batch_tx,
    },
    projection_read::notes_at_batch,
    runtime::{
        CanonicalStore, SpaceRecord, load_space_record, pg_read_error, purge_fenced_note_ids_tx,
        read_immutable_revision_tx, validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, ResourceFacts, SpaceLifecycle},
    classes::{ClassEgressFence, ClassifiedDocument, DocClass},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId, PrincipalId, RevisionId, SpaceSeq},
    model::{HistoryScope, Lifecycle, NoteRef},
    ports::{CallBudget, PageLimit, ServiceAuthority, ServicePurpose, SpaceContext},
    query::{FieldObservation, FieldValue},
    receipt::{
        ChangeCursor, OverlayDecision, OverlayRowVersion, ReceiptSet, TrustedMutationEffect,
        plan_overlay,
    },
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[derive(Clone, Debug)]
pub struct SearchIndexedNote {
    pub note_id: NoteId,
    pub document: ClassifiedDocument,
    pub title: String,
    pub parent_folder_id: FolderId,
    pub enclosing_project: Option<FolderId>,
    pub revision_actor: PrincipalId,
    /// Folder ancestry was active at the indexing cut and the last live check.
    pub remote_indexable: bool,
}

#[derive(Clone, Debug)]
pub struct SearchNotesSeedPage {
    pub cutoff: ChangeCursor,
    pub notes: Vec<SearchIndexedNote>,
    pub next_after: Option<NoteId>,
}

struct PendingNote {
    meta: NoteRevisionMetadata,
    revision: RevisionId,
    actor: PrincipalId,
    digest: ContentDigest,
    facts: ResourceFacts,
    project: Option<FolderId>,
    active_ancestry: bool,
}

#[derive(Clone, Debug)]
pub struct SearchOverlayNote {
    pub note_id: NoteId,
    pub document: ClassifiedDocument,
    pub title: String,
    pub path: String,
    pub preview: String,
    pub parent_folder_id: FolderId,
    pub fields: BTreeMap<String, FieldObservation<FieldValue>>,
}

/// The revision shown by a projected cut, or the exact revision of a receipt.
pub struct SearchDocumentTarget {
    pub note_id: NoteId,
    pub revision: RevisionId,
    pub projected_at: Option<SpaceSeq>,
}

struct SearchTargetNote {
    note: SearchIndexedNote,
    path: String,
    fields: BTreeMap<String, FieldObservation<FieldValue>>,
}

enum Notes {
    Seed {
        after: Option<NoteId>,
        limit: PageLimit,
    },
    Selected(Vec<NoteId>),
}

impl CanonicalStore {
    /// A receipt overlay may only reuse the base cut's folder and schema state.
    pub async fn plan_search_overlay(
        &self,
        authority: &ServiceAuthority,
        budget: &CallBudget,
        scope: &HistoryScope,
        base: SpaceSeq,
        receipts: &ReceiptSet,
    ) -> Result<Option<Vec<OverlayRowVersion>>, PortError> {
        authority.require(ServicePurpose::Search)?;
        let selected: Vec<_> = receipts
            .for_scope(scope)?
            .into_iter()
            .filter(|receipt| receipt.seq() > base)
            .cloned()
            .collect();
        let scope = scope.clone();
        let receipts = receipts.clone();
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                active_space(tx, &scope).await?;
                let through = selected
                    .iter()
                    .map(|receipt| receipt.seq())
                    .max()
                    .unwrap_or(base);
                if !crate::projection_read::structural_overlay_supported(tx, &scope, base, through)
                    .await?
                {
                    return Ok(None);
                }
                let mut effects = Vec::with_capacity(selected.len());
                for receipt in selected {
                    let (kind, effect) =
                        super::resolve_receipt_effect_tx(tx, &scope, receipt.seq()).await?;
                    // The package binding can change without a new note revision.
                    if kind.as_deref() == Some("publish_ability_package") {
                        return Ok(None);
                    }
                    effects.push(TrustedMutationEffect { receipt, effect });
                }
                match plan_overlay(
                    &scope,
                    base,
                    &receipts,
                    &effects,
                    crate::codec::EFFECT_PAYLOAD_BUDGET_BYTES,
                )? {
                    OverlayDecision::Bounded { versions } => Ok(Some(versions)),
                    OverlayDecision::AwaitProjection { .. } => Ok(None),
                }
            })
        })
        .await
    }

    pub async fn read_note_revisions_for_overlay(
        &self,
        authority: &ServiceAuthority,
        ctx: SpaceContext,
        filter_cut: SpaceSeq,
        targets: Vec<(NoteId, RevisionId)>,
    ) -> Result<Vec<(NoteId, Option<SearchOverlayNote>)>, PortError> {
        authority.require(ServicePurpose::Search)?;
        if targets.len() > 8 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let targets = targets
            .into_iter()
            .map(|(note_id, revision)| SearchDocumentTarget {
                note_id,
                revision,
                projected_at: None,
            })
            .collect();
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        self.read_search_targets(ctx.budget, scope, targets, auth, Some(filter_cut))
            .await?
            .into_iter()
            .map(|(key, row)| {
                let overlay = row
                    .map(|SearchTargetNote { note, path, fields }| {
                        let content =
                            ClassEgressFence::index_for_search(note.document.clone(), authority)?;
                        Ok::<_, DomainError>(SearchOverlayNote {
                            note_id: note.note_id,
                            preview: extract_note_preview(
                                content.text(),
                                content.provenance().class(),
                            ),
                            document: note.document,
                            title: note.title,
                            path,
                            parent_folder_id: note.parent_folder_id,
                            fields,
                        })
                    })
                    .transpose()?;
                Ok((key, overlay))
            })
            .collect()
    }

    pub async fn read_authorized_documents_for_search(
        &self,
        ctx: SpaceContext,
        targets: Vec<SearchDocumentTarget>,
    ) -> Result<Vec<Option<Arc<ClassifiedDocument>>>, PortError> {
        if targets.len() > 200 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let scope = ctx.scope().clone();
        let auth = ctx.auth().clone();
        let rows = self
            .read_search_targets(ctx.budget, scope, targets, auth.clone(), None)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(_, row)| {
                row.and_then(|SearchTargetNote { note, .. }| {
                    ClassEgressFence::search(note.document.clone(), &auth).ok()?;
                    Some(Arc::new(note.document))
                })
            })
            .collect())
    }

    async fn read_search_targets(
        &self,
        mut budget: CallBudget,
        scope: HistoryScope,
        targets: Vec<SearchDocumentTarget>,
        auth: EngineAuthContext,
        filter_cut: Option<SpaceSeq>,
    ) -> Result<Vec<(NoteId, Option<SearchTargetNote>)>, PortError> {
        let deadline = CommandDeadline::start(&budget, "read_search_targets");
        let mut tx_budget = budget.clone();
        tx_budget.remaining = deadline.remaining(&budget)?.min(Duration::from_millis(250));
        let scope_for_tx = scope.clone();
        let auth_for_tx = auth.clone();
        let pending = self
            .with_read_tx_budget(Some(&tx_budget), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &scope_for_tx).await?;
                    let mut live = FolderAncestryCache::default();
                    let schema = match filter_cut {
                        Some(cut) => {
                            validate_snapshot_cutoff_tx(tx, &scope_for_tx, Some(cut)).await?;
                            crate::projection_read::schema_at(tx, &scope_for_tx, cut).await?
                        }
                        None => None,
                    };
                    let mut historical = BTreeMap::new();
                    let mut slots = Vec::with_capacity(targets.len());
                    for target in targets {
                        let row = if let Some(cutoff) = target.projected_at {
                            let ancestry = match historical.entry(cutoff) {
                                std::collections::btree_map::Entry::Occupied(entry) => {
                                    entry.into_mut()
                                }
                                std::collections::btree_map::Entry::Vacant(entry) => {
                                    validate_snapshot_cutoff_tx(tx, &scope_for_tx, Some(cutoff))
                                        .await?;
                                    entry.insert(FolderAncestryCache::at_cut(&scope_for_tx, cutoff))
                                }
                            };
                            load_note(
                                tx,
                                &space,
                                &target.note_id,
                                cutoff,
                                ancestry,
                                &mut live,
                                Some(&auth_for_tx),
                            )
                            .await?
                            .filter(|pending| pending.revision == target.revision)
                            .map(|pending| (pending, String::new()))
                        } else {
                            load_exact_note(
                                tx,
                                &space,
                                &target.note_id,
                                target.revision,
                                &mut live,
                                &auth_for_tx,
                            )
                            .await?
                        };
                        let mut row = row;
                        if filter_cut.is_some()
                            && let Some((pending, _)) = &mut row
                        {
                            refresh_overlay_fields(&mut pending.meta, schema.as_ref());
                        }
                        slots.push((target.note_id, row));
                    }
                    Ok(slots)
                })
            })
            .await?;
        let mut rows = Vec::with_capacity(pending.len());
        for (key, row) in pending {
            budget.remaining = deadline.remaining(&budget)?;
            let row = match row {
                Some((mut pending, path)) => {
                    let fields = std::mem::take(&mut pending.meta.evaluated_fields);
                    self.load_search_carrier(&scope, &budget, pending)
                        .await?
                        .map(|note| SearchTargetNote { note, path, fields })
                }
                None => None,
            };
            rows.push((key, row));
        }
        tx_budget.remaining = deadline.remaining(&budget)?.min(Duration::from_millis(250));
        self.with_read_tx_budget(Some(&tx_budget), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &scope).await?;
                let mut live = FolderAncestryCache::default();
                for (key, row) in &mut rows {
                    let Some(SearchTargetNote { note, .. }) = row else {
                        continue;
                    };
                    match live_search_facts(tx, &space, key, &mut live).await? {
                        Some(facts) if auth.can_view_resource(&facts).is_ok() => {
                            note.document.bind_current(facts, Lifecycle::Active)?;
                        }
                        _ => *row = None,
                    }
                }
                Ok(rows)
            })
        })
        .await
    }

    /// Check whether a durable search cut still describes retained history.
    /// This needs neither an index reader nor access to any carrier bytes.
    pub async fn validate_search_index_cut(
        &self,
        authority: &ServiceAuthority,
        budget: CallBudget,
        cursor: ChangeCursor,
    ) -> Result<(), PortError> {
        authority.require(ServicePurpose::Search)?;
        self.with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &cursor.scope).await?;
                let cutoff =
                    validate_snapshot_cutoff_tx(tx, &cursor.scope, Some(cursor.after)).await?;
                check_seed(tx, &space, cutoff).await
            })
        })
        .await
    }

    /// Verify current placement again when an admitted batch leaves the queue.
    /// This read never fetches document bytes.
    pub async fn can_index_remote_search_note(
        &self,
        authority: &ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        note: NoteId,
        project: Option<FolderId>,
    ) -> Result<bool, PortError> {
        authority.require(ServicePurpose::Search)?;
        self.with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &scope).await?;
                let mut live = FolderAncestryCache::default();
                Ok(live_search_facts(tx, &space, &note, &mut live)
                    .await?
                    .is_some_and(|facts| {
                        live.all_active(&facts.ancestor_folders)
                            && project
                                .as_ref()
                                .is_none_or(|id| facts.ancestor_folders.contains(id))
                    }))
            })
        })
        .await
    }

    /// Detect chat redactions that a search cut has not applied when its
    /// reader cannot be opened to merge away the old postings.
    pub async fn has_search_redaction_after(
        &self,
        authority: &ServiceAuthority,
        budget: CallBudget,
        cursor: ChangeCursor,
    ) -> Result<bool, PortError> {
        authority.require(ServicePurpose::Search)?;
        self.with_read_tx_budget(Some(&budget), |tx| {
            Box::pin(async move {
                let space = active_space(tx, &cursor.scope).await?;
                if cursor.after >= space.last_seq {
                    return Ok(false);
                }
                const SQL: &str = "SELECT EXISTS (SELECT 1 FROM change_log WHERE space_id=$1
                    AND history_incarnation=$2 AND space_seq>$3 AND entity_type='thread' AND op_kind='redact')";
                let scope = &space.scope;
                let cutoff = cursor.after.get() as i64;
                match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice())
                        .bind(cutoff)
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_search_redaction", err.to_string())),
                    BackendConn::Postgres(conn) => sqlx::query_scalar(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(scope.incarnation.as_bytes().as_slice())
                        .bind(cutoff)
                        .fetch_one(&mut **conn)
                        .await
                        .map_err(|err| pg_read_error("pg_search_redaction", err)),
                }
            })
        })
        .await
    }

    pub async fn read_searchable_notes_seed_page(
        &self,
        authority: &ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        after_note: Option<NoteId>,
        limit: PageLimit,
    ) -> Result<SearchNotesSeedPage, PortError> {
        authority.require(ServicePurpose::Search)?;
        if after_note.is_some() && cutoff.is_none() {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        let (cutoff, rows, next_after) = self
            .read_search_notes(
                budget,
                scope,
                cutoff,
                Notes::Seed {
                    after: after_note,
                    limit,
                },
            )
            .await?;
        Ok(SearchNotesSeedPage {
            cutoff,
            notes: rows.into_iter().filter_map(|(_, row)| row).collect(),
            next_after,
        })
    }

    pub async fn read_note_documents_at_cutoff(
        &self,
        authority: &ServiceAuthority,
        budget: CallBudget,
        scope: HistoryScope,
        cutoff: SpaceSeq,
        notes: Vec<NoteId>,
    ) -> Result<Vec<(NoteId, Option<SearchIndexedNote>)>, PortError> {
        authority.require(ServicePurpose::Search)?;
        if notes.len() > 200 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let (_, rows, _) = self
            .read_search_notes(budget, scope, Some(cutoff), Notes::Selected(notes))
            .await?;
        Ok(rows)
    }

    async fn read_search_notes(
        &self,
        mut budget: CallBudget,
        scope: HistoryScope,
        cutoff: Option<SpaceSeq>,
        notes: Notes,
    ) -> Result<
        (
            ChangeCursor,
            Vec<(NoteId, Option<SearchIndexedNote>)>,
            Option<NoteId>,
        ),
        PortError,
    > {
        let seed = matches!(&notes, Notes::Seed { .. });
        let deadline = CommandDeadline::start(&budget, "read_search_notes");
        let mut tx_budget = budget.clone();
        tx_budget.remaining = deadline.remaining(&budget)?.min(Duration::from_millis(250));
        let scope_for_tx = scope.clone();
        let (cutoff, keys, pending, next_after) = self
            .with_read_tx_budget(Some(&tx_budget), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &scope_for_tx).await?;
                    let cutoff = validate_snapshot_cutoff_tx(tx, &scope_for_tx, cutoff).await?;
                    if seed {
                        check_seed(tx, &space, cutoff).await?;
                    }
                    let (keys, next_after) = match notes {
                        Notes::Seed { after, limit } => {
                            let limit = usize::from(limit.get());
                            let mut keys = list_note_keys_at_or_below_cutoff_tx(
                                tx,
                                &scope_for_tx,
                                cutoff,
                                after.as_ref().map(NoteId::as_str),
                                limit as i64 + 1,
                            )
                            .await?
                            .iter()
                            .map(|key| NoteId::parse(key))
                            .collect::<Result<Vec<_>, _>>()?;
                            let next_after = (keys.len() > limit).then(|| keys[limit - 1].clone());
                            keys.truncate(limit);
                            (keys, next_after)
                        }
                        Notes::Selected(keys) => (keys, None),
                    };
                    let live = live_search_batch(tx, &space, &keys).await?;
                    let visible = live.into_keys().collect::<Vec<_>>();
                    let revisions = notes_at_batch(tx, &scope_for_tx, cutoff, &visible).await?;
                    let mut historical = FolderAncestryCache::at_cut(&scope_for_tx, cutoff);
                    let mut pending = Vec::with_capacity(revisions.len());
                    for revision in revisions.into_values() {
                        let meta = revision.metadata;
                        if meta.lifecycle != Lifecycle::Active
                            || meta.doc_class == DocClass::EncryptedNote
                        {
                            continue;
                        }
                        let digest = meta.content_digest.ok_or_else(|| {
                            internal_not_committed(
                                "search_note_revision",
                                "active note is missing its carrier",
                            )
                        })?;
                        let (facts, ancestry) = historical
                            .build_resource_facts_tx(
                                tx,
                                &space.space,
                                &meta.parent_folder_id,
                                meta.doc_class,
                                meta.ability_id.clone(),
                                false,
                            )
                            .await?;
                        pending.push(PendingNote {
                            meta,
                            revision: revision.revision_id,
                            actor: revision.revision_actor,
                            digest,
                            facts,
                            project: historical.enclosing_project(&ancestry),
                            active_ancestry: historical.all_active(&ancestry.ancestors),
                        });
                    }
                    Ok((cutoff, keys, pending, next_after))
                })
            })
            .await?;

        let mut loaded = BTreeMap::new();
        for note in pending {
            budget.remaining = deadline.remaining(&budget)?;
            if let Some(note) = self.load_search_carrier(&scope, &budget, note).await? {
                loaded.insert(note.note_id.clone(), note);
            }
        }

        let ids = loaded.keys().cloned().collect::<Vec<_>>();
        // Fill missing and duplicate positions before the final live check.
        // Only an explicitly repeated note needs a second copy of the carrier.
        let mut rows: Vec<(NoteId, Option<SearchIndexedNote>)> = Vec::with_capacity(keys.len());
        let mut positions = BTreeMap::<NoteId, usize>::new();
        for key in keys {
            let note = match positions.entry(key.clone()) {
                std::collections::btree_map::Entry::Occupied(first) => rows[*first.get()].1.clone(),
                std::collections::btree_map::Entry::Vacant(first) => {
                    first.insert(rows.len());
                    loaded.remove(&key)
                }
            };
            rows.push((key, note));
        }

        tx_budget.remaining = deadline.remaining(&budget)?.min(Duration::from_millis(250));
        let scope_for_tx = scope.clone();
        let rows = self
            .with_read_tx_budget(Some(&tx_budget), |tx| {
                Box::pin(async move {
                    let space = active_space(tx, &scope_for_tx).await?;
                    if seed {
                        check_seed(tx, &space, cutoff).await?;
                    }
                    let live = live_search_batch(tx, &space, &ids).await?;
                    for (key, row) in &mut rows {
                        if let Some(note) = row {
                            if let Some((facts, active_ancestry)) = live.get(key) {
                                note.remote_indexable &= *active_ancestry;
                                note.document
                                    .bind_current(facts.clone(), Lifecycle::Active)?;
                            } else {
                                *row = None;
                            }
                        }
                    }
                    Ok(rows)
                })
            })
            .await?;
        Ok((
            ChangeCursor {
                scope,
                after: cutoff,
            },
            rows,
            next_after,
        ))
    }

    async fn load_search_carrier(
        &self,
        scope: &HistoryScope,
        budget: &CallBudget,
        pending: PendingNote,
    ) -> Result<Option<SearchIndexedNote>, PortError> {
        let bytes = match self
            .read_verified_blob_with_budget(scope, pending.digest, Some(budget))
            .await
        {
            Ok(bytes) => bytes,
            Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let text = String::from_utf8(bytes)
            .map_err(|_| internal_not_committed("search_note_utf8", "note carrier is not UTF-8"))?;
        let document = ClassifiedDocument::from_canonical(
            NoteRef {
                space_id: scope.space_id.clone(),
                note_id: pending.meta.note_id.clone(),
            },
            pending.revision,
            pending.facts,
            pending.meta.lifecycle,
            text,
            pending.digest,
        )?;
        Ok(Some(SearchIndexedNote {
            note_id: pending.meta.note_id,
            document,
            title: pending.meta.title,
            parent_folder_id: pending.meta.parent_folder_id,
            enclosing_project: pending.project,
            revision_actor: pending.actor,
            remote_indexable: pending.active_ancestry,
        }))
    }
}

// Moves and restores can carry field observations from an earlier schema.
fn refresh_overlay_fields(
    meta: &mut NoteRevisionMetadata,
    schema: Option<&crate::projection_read::ProjectedSchemaSnapshot>,
) {
    if meta.schema_revision.as_ref() != schema.map(|schema| &schema.schema_rev_id) {
        meta.evaluated_fields = crate::codec::evaluate_fields_with_schema(
            meta.raw_fields.as_ref(),
            meta.diagnostics.first(),
            schema.map(|schema| &schema.fields),
        );
    }
}

// Package publications can change a skill's binding without a new note revision.
async fn bind_search_ability(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    meta: &mut NoteRevisionMetadata,
) -> Result<(), PortError> {
    if matches!(meta.doc_class, DocClass::Skill | DocClass::Profile) {
        meta.ability_id = crate::projection_read::note_at(tx, scope, cutoff, &meta.note_id)
            .await?
            .and_then(|note| note.metadata.ability_id);
    }
    Ok(())
}

async fn load_exact_note(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    note: &NoteId,
    revision: RevisionId,
    live: &mut FolderAncestryCache,
    auth: &EngineAuthContext,
) -> Result<Option<(PendingNote, String)>, PortError> {
    let Some(current) = live_search_facts(tx, space, note, live).await? else {
        return Ok(None);
    };
    if auth.can_view_resource(&current).is_err() {
        return Ok(None);
    }
    const SQL: &str = "SELECT metadata_msgpack, visibility_seq, actor_id FROM revisions
        WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3
          AND history_incarnation = $4";
    let row: Option<(Vec<u8>, i64, String)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(space.scope.space_id.as_str())
            .bind(revision.as_str())
            .bind(note.as_str())
            .bind(space.scope.incarnation.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_search_exact", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(space.scope.space_id.as_str())
            .bind(revision.as_str())
            .bind(note.as_str())
            .bind(space.scope.incarnation.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_search_exact", err))?,
    };
    let Some((bytes, visibility, actor)) = row else {
        return Ok(None);
    };
    let RevisionMetadataPayload::Note(mut meta) = RevisionMetadataEnvelope::decode(&bytes)?.payload
    else {
        return Err(internal_not_committed(
            "search_exact_revision",
            "expected note metadata",
        ));
    };
    if meta.doc_class == DocClass::EncryptedNote || meta.lifecycle != Lifecycle::Active {
        return Ok(None);
    }
    let digest = meta.content_digest.ok_or_else(|| {
        internal_not_committed(
            "search_exact_revision",
            "active note is missing its carrier",
        )
    })?;
    let cutoff = i64_to_space_seq(visibility)?;
    bind_search_ability(tx, &space.scope, cutoff, &mut meta).await?;
    let mut history = FolderAncestryCache::at_cut(&space.scope, cutoff);
    let (facts, ancestry) = history
        .build_resource_facts_tx(
            tx,
            &space.space,
            &meta.parent_folder_id,
            meta.doc_class,
            meta.ability_id.clone(),
            false,
        )
        .await?;
    if auth.can_view_resource(&facts).is_err() {
        return Ok(None);
    }
    let path = if ancestry.folder_path.is_empty() {
        format!("{}.md", meta.slug)
    } else {
        format!("{}/{}.md", ancestry.folder_path, meta.slug)
    };
    let project = history.enclosing_project(&ancestry);
    let active_ancestry = history.all_active(&ancestry.ancestors);
    Ok(Some((
        PendingNote {
            meta,
            revision,
            actor: PrincipalId::parse(&actor)?,
            digest,
            facts,
            project,
            active_ancestry,
        },
        path,
    )))
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

async fn check_seed(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    cutoff: SpaceSeq,
) -> Result<(), PortError> {
    if has_post_cutoff_purge_of_prior_note_tx(tx, &space.scope, cutoff, space.last_seq).await? {
        return Err(DomainError::validation(ValidationReason::CursorStale).into());
    }
    Ok(())
}

/// Resolve current visibility in one head/fence batch, sharing ancestry
/// across every note in the same folder and keeping historical facts separate.
async fn live_search_batch(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    notes: &[NoteId],
) -> Result<BTreeMap<NoteId, (ResourceFacts, bool)>, PortError> {
    let fenced = purge_fenced_note_ids_tx(tx, &space.scope.space_id, notes).await?;
    let unfenced: Vec<_> = notes
        .iter()
        .filter(|id| !fenced.contains(*id))
        .cloned()
        .collect();
    let heads = load_note_heads_batch_tx(tx, &space.scope.space_id, &unfenced).await?;
    let mut folders = FolderAncestryCache::default();
    let mut live = BTreeMap::new();
    for (id, head) in heads {
        if head.lifecycle != Lifecycle::Active || head.doc_class == DocClass::EncryptedNote {
            continue;
        }
        let (facts, ancestry) = folders
            .build_resource_facts_tx(
                tx,
                &space.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id,
                false,
            )
            .await?;
        live.insert(id, (facts, folders.all_active(&ancestry.ancestors)));
    }
    Ok(live)
}

async fn live_search_facts(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    note: &NoteId,
    live: &mut FolderAncestryCache,
) -> Result<Option<ResourceFacts>, PortError> {
    Ok(live
        .live_note_facts(tx, &space.space, note, false)
        .await?
        .and_then(|(facts, lifecycle)| {
            (lifecycle == Lifecycle::Active && facts.class != DocClass::EncryptedNote)
                .then_some(facts)
        }))
}

async fn load_note(
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    note: &NoteId,
    cutoff: SpaceSeq,
    historical: &mut FolderAncestryCache,
    live: &mut FolderAncestryCache,
    auth: Option<&EngineAuthContext>,
) -> Result<Option<PendingNote>, PortError> {
    let Some(current) = live_search_facts(tx, space, note, live).await? else {
        return Ok(None);
    };
    if auth.is_some_and(|auth| auth.can_view_resource(&current).is_err()) {
        return Ok(None);
    }
    let Some(revision) =
        read_immutable_revision_tx(tx, &space.scope, "note", note.as_str(), cutoff).await?
    else {
        return Ok(None);
    };
    let RevisionMetadataPayload::Note(mut meta) = revision.metadata.payload else {
        return Err(internal_not_committed(
            "search_note_revision",
            "expected note metadata",
        ));
    };
    if meta.lifecycle != Lifecycle::Active || meta.doc_class == DocClass::EncryptedNote {
        return Ok(None);
    }
    let digest = meta.content_digest.ok_or_else(|| {
        internal_not_committed("search_note_revision", "active note is missing its carrier")
    })?;
    bind_search_ability(tx, &space.scope, cutoff, &mut meta).await?;
    let (facts, ancestry) = historical
        .build_resource_facts_tx(
            tx,
            &space.space,
            &meta.parent_folder_id,
            meta.doc_class,
            meta.ability_id.clone(),
            false,
        )
        .await?;
    if auth.is_some_and(|auth| auth.can_view_resource(&facts).is_err()) {
        return Ok(None);
    }
    let project = historical.enclosing_project(&ancestry);
    let active_ancestry = historical.all_active(&ancestry.ancestors);
    Ok(Some(PendingNote {
        meta,
        revision: revision.revision_id,
        actor: revision.actor_id,
        digest,
        facts,
        project,
        active_ancestry,
    }))
}

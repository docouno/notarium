//! Read-only search carriers over canonical history and live lifecycle fences.

use super::{has_post_cutoff_purge_of_prior_note_tx, list_note_keys_at_or_below_cutoff_tx};
use crate::{
    codec::{NoteRevisionMetadata, RevisionMetadataPayload, internal_not_committed},
    domain::common::{CommandDeadline, FolderAncestryCache},
    runtime::{
        CanonicalStore, SpaceRecord, load_space_record, read_immutable_revision_tx,
        validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
};
use notarium_core::{
    DomainError,
    auth::{ResourceFacts, SpaceLifecycle},
    classes::{ClassifiedDocument, DocClass},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, FolderId, NoteId, PrincipalId, RevisionId, SpaceSeq},
    model::{HistoryScope, Lifecycle, NoteRef},
    ports::{CallBudget, PageLimit, ServiceAuthority, ServicePurpose},
    receipt::ChangeCursor,
};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct SearchIndexedNote {
    pub note_id: NoteId,
    pub document: ClassifiedDocument,
    pub title: String,
    pub parent_folder_id: FolderId,
    pub enclosing_project: Option<FolderId>,
    pub revision_actor: PrincipalId,
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
}

enum Notes {
    Seed {
        after: Option<NoteId>,
        limit: PageLimit,
    },
    Selected(Vec<NoteId>),
}

impl CanonicalStore {
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
        let (cutoff, pending, next_after) = self
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
                    let mut historical = FolderAncestryCache::at_cut(&scope_for_tx, cutoff);
                    let mut live = FolderAncestryCache::default();
                    let mut pending = Vec::with_capacity(keys.len());
                    for key in keys {
                        let candidate =
                            load_note(tx, &space, &key, cutoff, &mut historical, &mut live).await?;
                        pending.push((key, candidate));
                    }
                    Ok((cutoff, pending, next_after))
                })
            })
            .await?;

        let mut rows = Vec::with_capacity(pending.len());
        for (key, note) in pending {
            budget.remaining = deadline.remaining(&budget)?;
            let row = match note {
                Some(note) => self.load_search_carrier(&scope, &budget, note).await?,
                None => None,
            };
            rows.push((key, row));
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
                    let mut live = FolderAncestryCache::default();
                    for (key, row) in &mut rows {
                        if let Some(note) = row {
                            match live_search_facts(tx, &space, key, &mut live).await? {
                                Some(facts) => {
                                    note.document.bind_current(facts, Lifecycle::Active)?
                                }
                                None => *row = None,
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
        }))
    }
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
) -> Result<Option<PendingNote>, PortError> {
    if live_search_facts(tx, space, note, live).await?.is_none() {
        return Ok(None);
    }
    let Some(revision) =
        read_immutable_revision_tx(tx, &space.scope, "note", note.as_str(), cutoff).await?
    else {
        return Ok(None);
    };
    let RevisionMetadataPayload::Note(meta) = revision.metadata.payload else {
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
    let project = historical.enclosing_project(&ancestry);
    Ok(Some(PendingNote {
        meta,
        revision: revision.revision_id,
        actor: revision.actor_id,
        digest,
        facts,
        project,
    }))
}

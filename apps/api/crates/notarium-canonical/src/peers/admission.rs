use notarium_core::{
    DomainError,
    auth::{ResourceFacts, Space, SpaceLifecycle},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, LineageEpoch, NoteId, RevisionId, SpaceId},
    model::{HistoryScope, Lifecycle},
    ports::{CallBudget, ServiceAuthority, ServicePurpose, SpaceContext},
};

use super::{
    CollabRoomState, CollabSessionSnapshot, load_collab_snapshot_tx, wal::verify_wal_owner_tx,
};
use crate::{
    CanonicalStore,
    codec::internal_not_committed,
    domain::common::{
        CommandDeadline, NoteHeadRow, build_resource_facts_tx, load_note_head_row_tx,
    },
    runtime::{is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
};

/// Current authorized carrier and collaboration state, read at a single cut.
#[derive(Debug)]
pub struct NoteCollabAdmission {
    pub scope: HistoryScope,
    pub head_rev_id: RevisionId,
    pub doc_class: DocClass,
    pub slug: String,
    pub can_write: bool,
    pub carrier: String,
    pub session: Option<CollabSessionSnapshot>,
    pub verified_base_rev_id: Option<RevisionId>,
}

/// Current note metadata and policy facts under an exact active room lease.
#[derive(Debug)]
pub struct ActiveRoomFacts {
    pub resource: ResourceFacts,
    pub head_rev_id: RevisionId,
    pub slug: String,
    pub content_digest: ContentDigest,
}

/// A fenced room's current carrier and the durable state to settle onto it.
#[derive(Debug)]
pub struct FencedCollabRecovery {
    pub head_rev_id: RevisionId,
    pub carrier: String,
    pub session: CollabSessionSnapshot,
}

impl CanonicalStore {
    /// Reads note authority and recovery state, with a base revision confined to
    /// this note in this Space.
    pub async fn read_note_collab_admission(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        verify_base_rev: Option<&RevisionId>,
    ) -> Result<NoteCollabAdmission, PortError> {
        read_note_collab_admission(self, ctx, note, verify_base_rev).await
    }

    /// Reads the current history identifier for a trusted composition caller.
    pub async fn read_current_history_scope(
        &self,
        budget: Option<&CallBudget>,
        space: &SpaceId,
    ) -> Result<HistoryScope, PortError> {
        let space = space.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move { Ok(load_space_record(tx, &space).await?.scope) })
        })
        .await
    }

    /// Reads fresh ancestry and authority facts without fetching carrier or CRDT payloads.
    pub async fn read_room_resource_facts(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<ResourceFacts, PortError> {
        let scope = scope.clone();
        let note = note.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                let (_, facts) = load_room_note_facts_tx(tx, &srec.space, &note).await?;
                Ok(facts)
            })
        })
        .await
    }

    /// Reads current note metadata and facts only while this owner still holds
    /// the requested collaboration lease and lineage.
    pub async fn read_active_room_facts(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
        expected_lease: LeaseEpoch,
        expected_lineage: LineageEpoch,
        owner_id: &str,
    ) -> Result<ActiveRoomFacts, PortError> {
        let scope = scope.clone();
        let note = note.clone();
        let owner_id = owner_id.to_owned();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                let (head, resource) = load_room_note_facts_tx(tx, &srec.space, &note).await?;
                verify_wal_owner_tx(
                    tx,
                    &scope,
                    &note,
                    &owner_id,
                    expected_lease,
                    expected_lineage,
                )
                .await?;
                if head.doc_class != DocClass::UserDoc {
                    return Err(DomainError::ResourceNotFound.into());
                }
                Ok(ActiveRoomFacts {
                    resource,
                    content_digest: note_carrier_digest(&head)?,
                    head_rev_id: head.head_rev_id,
                    slug: head.slug,
                })
            })
        })
        .await
    }

    /// Lists a bounded set of rooms with no current owner awaiting recovery.
    pub async fn list_fenced_collab_sessions(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        limit: u16,
    ) -> Result<Vec<NoteId>, PortError> {
        let scope = scope.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                Ok(
                    list_fenced_collab_leases_tx(tx, &scope.space_id, i64::from(limit))
                        .await?
                        .into_iter()
                        .map(|(note, _)| note)
                        .collect(),
                )
            })
        })
        .await
    }

    /// Lists owner-matched active rooms in the current history for an internal
    /// lifecycle drain, including rooms whose owner has no actor in memory.
    pub async fn list_owned_active_collab_sessions(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        owner_id: &str,
        limit: u16,
    ) -> Result<Vec<NoteId>, PortError> {
        let scope = scope.clone();
        let owner_id = owner_id.to_owned();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                const SQL: &str = "SELECT note_id FROM collab_sessions
                    WHERE space_id = $1 AND room_state = 'active' AND owner_id = $2
                    ORDER BY note_id LIMIT $3";
                let notes: Vec<String> = match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query_scalar(SQL)
                            .bind(scope.space_id.as_str())
                            .bind(&owner_id)
                            .bind(i64::from(limit))
                            .fetch_all(&mut **conn)
                            .await
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query_scalar(SQL)
                            .bind(scope.space_id.as_str())
                            .bind(&owner_id)
                            .bind(i64::from(limit))
                            .fetch_all(&mut **conn)
                            .await
                    }
                }
                .map_err(|err| {
                    internal_not_committed("collab_list_owned_rooms", err.to_string())
                })?;
                notes
                    .into_iter()
                    .map(|note| {
                        NoteId::parse(&note).map_err(|err| {
                            internal_not_committed("collab_active_note_id", err.to_string())
                        })
                    })
                    .collect()
            })
        })
        .await
    }

    /// Loads a fenced room for internal recovery, without requiring a live
    /// writer credential from before the crash or revocation.
    pub async fn read_fenced_collab_recovery(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
        authority: &ServiceAuthority,
    ) -> Result<Option<FencedCollabRecovery>, PortError> {
        authority.require(ServicePurpose::CollabRecovery)?;
        let scope_cl = scope.clone();
        let note = note.clone();
        let recovered = self
            .with_read_tx_budget(budget, |tx| {
                Box::pin(async move {
                    let srec = load_space_record(tx, &scope_cl.space_id).await?;
                    srec.scope.check(&scope_cl)?;
                    let (head, _) = load_room_note_facts_tx(tx, &srec.space, &note).await?;
                    if head.doc_class != DocClass::UserDoc {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let Some(session) = load_collab_snapshot_tx(tx, &scope_cl, &note).await? else {
                        return Ok(None);
                    };
                    if session.session.room_state != CollabRoomState::Fenced {
                        return Ok(None);
                    }
                    if session.session.owner_id.is_some()
                        || session.session.carrier_rev_id != head.head_rev_id
                    {
                        return Err(
                            DomainError::validation(ValidationReason::SourceMismatch).into()
                        );
                    }
                    Ok(Some((head, session)))
                })
            })
            .await?;
        let Some((head, session)) = recovered else {
            return Ok(None);
        };
        let carrier = String::from_utf8(
            self.read_verified_blob_with_budget(scope, note_carrier_digest(&head)?, budget)
                .await?,
        )
        .map_err(|err| {
            internal_not_committed("collab_carrier_utf8", err.utf8_error().to_string())
        })?;
        Ok(Some(FencedCollabRecovery {
            head_rev_id: head.head_rev_id,
            carrier,
            session,
        }))
    }
}

fn note_carrier_digest(head: &NoteHeadRow) -> Result<ContentDigest, PortError> {
    head.content_digest.ok_or_else(|| {
        internal_not_committed("collab_missing_carrier", "active note lacks content_blake3")
    })
}

pub(super) async fn load_room_note_facts_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    note: &NoteId,
) -> Result<(NoteHeadRow, ResourceFacts), PortError> {
    if space.lifecycle != SpaceLifecycle::Active
        || is_note_purge_fenced_tx(tx, &space.id, note.as_str()).await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let head = load_note_head_row_tx(tx, &space.id, note).await?;
    if head.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = build_resource_facts_tx(
        tx,
        space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id.clone(),
        true,
    )
    .await?;
    Ok((head, facts))
}

async fn read_note_collab_admission(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    verify_base_rev: Option<&RevisionId>,
) -> Result<NoteCollabAdmission, PortError> {
    let deadline = CommandDeadline::start(&ctx.budget, "collab_admission");
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let note = note.clone();
    let base = verify_base_rev.cloned();
    let (head, can_write, session, verified_base_rev_id) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                let (head, facts) = load_room_note_facts_tx(tx, &srec.space, &note).await?;
                auth.authorize_read(&facts)?;
                if head.doc_class != DocClass::UserDoc {
                    return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
                }
                let can_write = auth.authorize_direct_write(&facts, &facts).is_ok();
                let verified = match base {
                    Some(base) if base == head.head_rev_id => Some(base),
                    Some(base)
                        if collab_base_revision_exists_tx(tx, &scope, &note, &base).await? =>
                    {
                        Some(base)
                    }
                    _ => None,
                };
                let room = load_collab_snapshot_tx(tx, &scope, &note).await?;
                Ok((head, can_write, room, verified))
            })
        })
        .await?;
    let digest = note_carrier_digest(&head)?;
    let bytes = deadline
        .prepare(&ctx.budget, || {
            store.read_verified_blob(ctx.scope(), digest)
        })
        .await?;
    let carrier = String::from_utf8(bytes).map_err(|err| {
        internal_not_committed("collab_carrier_utf8", err.utf8_error().to_string())
    })?;
    Ok(NoteCollabAdmission {
        scope: ctx.scope().clone(),
        head_rev_id: head.head_rev_id,
        doc_class: head.doc_class,
        slug: head.slug,
        can_write,
        carrier,
        session,
        verified_base_rev_id,
    })
}

async fn collab_base_revision_exists_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    base: &RevisionId,
) -> Result<bool, PortError> {
    const SQL: &str = "SELECT EXISTS(SELECT 1 FROM revisions
        WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3)";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(base.as_str())
                .bind(note.as_str())
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(base.as_str())
                .bind(note.as_str())
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("collab_verify_base_revision", err.to_string()))
}

pub(crate) async fn list_fenced_collab_leases_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    limit: i64,
) -> Result<Vec<(NoteId, LeaseEpoch)>, PortError> {
    const SQL: &str = "SELECT note_id, lease_epoch FROM collab_sessions
        WHERE space_id = $1 AND room_state = 'fenced' ORDER BY note_id LIMIT $2";
    let notes: Vec<(String, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(SQL)
                .bind(space.as_str())
                .bind(limit)
                .fetch_all(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(SQL)
                .bind(space.as_str())
                .bind(limit)
                .fetch_all(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("collab_list_fenced_notes", err.to_string()))?;
    notes
        .into_iter()
        .map(|(note, epoch)| {
            let note = NoteId::parse(&note)
                .map_err(|err| internal_not_committed("collab_fenced_note_id", err.to_string()))?;
            let epoch = LeaseEpoch::new(u64::try_from(epoch).map_err(|err| {
                internal_not_committed("collab_fenced_room_epoch", err.to_string())
            })?)?;
            Ok((note, epoch))
        })
        .collect()
}

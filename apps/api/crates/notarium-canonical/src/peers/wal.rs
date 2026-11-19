use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::PortError,
    error::ValidationReason,
    ids::{LeaseEpoch, LineageEpoch, NoteId},
    model::HistoryScope,
    ports::CallBudget,
};

use super::{
    AppendCollabUpdate, AppendCollabUpdates, CollabRoomState, admission::load_room_note_facts_tx,
};
use crate::{
    CanonicalStore,
    codec::{internal_not_committed, now_unix_ms},
    domain::common::CommandDeadline,
    sql_exec::BackendConn,
    writer::{ItemCommitArtifacts, PreparedWriteIntent, RoomWalAdmission},
};

pub(super) struct PendingWalBatch {
    scope: HistoryScope,
    note: NoteId,
    owner_id: String,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
    entries: Vec<PendingWalEntry>,
    replay_safe: bool,
}

struct PendingWalEntry {
    seq: u64,
    bytes: Vec<u8>,
    auth: Option<EngineAuthContext>,
}

impl From<AppendCollabUpdates> for PendingWalBatch {
    fn from(spec: AppendCollabUpdates) -> Self {
        Self {
            scope: spec.scope,
            note: spec.note,
            owner_id: spec.owner_id,
            lease: spec.expected_lease,
            lineage: spec.expected_lineage,
            entries: spec
                .updates
                .into_iter()
                .map(|entry| PendingWalEntry {
                    seq: entry.update_seq,
                    bytes: entry.update_bytes,
                    auth: Some(entry.auth),
                })
                .collect(),
            replay_safe: true,
        }
    }
}

impl PendingWalBatch {
    /// Trusted room-owner seam retained for internal callers of the single-update API.
    pub(super) fn single(spec: AppendCollabUpdate) -> Self {
        Self {
            scope: spec.scope,
            note: spec.note,
            owner_id: spec.owner_id,
            lease: spec.expected_lease,
            lineage: spec.expected_lineage,
            entries: vec![PendingWalEntry {
                seq: spec.update_seq,
                bytes: spec.update_bytes,
                auth: None,
            }],
            replay_safe: false,
        }
    }
}

pub(super) async fn append_collab_updates_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    batch: PendingWalBatch,
    admission: Option<&RoomWalAdmission<'_>>,
) -> Result<u64, PortError> {
    let deadline = CommandDeadline::start(budget, "append_collab_updates");
    let mut last_seq = 0;
    let mut staged_bytes = 0u64;
    for entry in &batch.entries {
        if entry.seq <= last_seq || entry.seq > i64::MAX as u64 {
            return Err(DomainError::validation(ValidationReason::InvalidRange).into());
        }
        last_seq = entry.seq;
        staged_bytes = staged_bytes.saturating_add(entry.bytes.len() as u64);
    }
    if last_seq == 0 {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    let replay_safe = batch.replay_safe;
    let intent = PreparedWriteIntent {
        scope: batch.scope.clone(),
        active_epoch: LeaseEpoch::ZERO, // Room WAL admission derives writer authority internally.
        idempotency: None,
        source_note_ids: vec![batch.note.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, ctx| {
            Box::pin(async move {
                append_batch_tx(tx, &ctx.space, batch).await?;
                Ok(ItemCommitArtifacts::unsequenced(
                    CanonicalStore::encode_command_outcome(&last_seq)?,
                ))
            })
        }),
    };
    store
        .submit_room_wal(budget, deadline.at, intent, replay_safe, admission)
        .await
}

struct RoomLeaseRow {
    lease: i64,
    lineage: i64,
    state: String,
    owner: Option<String>,
}

pub(super) async fn verify_wal_owner_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    owner: &str,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
) -> Result<(), PortError> {
    const SQL: &str = "SELECT lease_epoch, lineage_epoch, room_state, owner_id
        FROM collab_sessions WHERE space_id = $1 AND note_id = $2";
    let row = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as::<_, (i64, i64, String, Option<String>)>(SQL)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as::<_, (i64, i64, String, Option<String>)>(SQL)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| internal_not_committed("read_collab_wal_lease", error.to_string()))?
    .map(|(lease, lineage, state, owner)| RoomLeaseRow {
        lease,
        lineage,
        state,
        owner,
    })
    .ok_or(DomainError::ResourceNotFound)?;
    if CollabRoomState::from_db(&row.state)? != CollabRoomState::Active {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if row.lease != lease.get() as i64 || row.owner.as_deref() != Some(owner) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if row.lineage != lineage.get() as i64 {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

async fn append_batch_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    batch: PendingWalBatch,
) -> Result<(), PortError> {
    // The batch writer already locks the Space row. Keep the exact room lease
    // predicate on the guarded SQL statement as well.
    const GUARD: &str = "UPDATE collab_sessions SET lease_epoch = lease_epoch
        WHERE space_id = $1 AND note_id = $2 AND lease_epoch = $3 AND lineage_epoch = $4
            AND room_state = 'active' AND owner_id = $5 RETURNING lease_epoch";
    let space_id = batch.scope.space_id.as_str();
    let note = batch.note.as_str();
    let lease = batch.lease.get() as i64;
    let lineage = batch.lineage.get() as i64;
    let guarded: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(GUARD)
                .bind(space_id)
                .bind(note)
                .bind(lease)
                .bind(lineage)
                .bind(&batch.owner_id)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(GUARD)
                .bind(space_id)
                .bind(note)
                .bind(lease)
                .bind(lineage)
                .bind(&batch.owner_id)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| internal_not_committed("guard_collab_wal_lease", error.to_string()))?;
    if guarded.is_none() {
        verify_wal_owner_tx(
            tx,
            &batch.scope,
            &batch.note,
            &batch.owner_id,
            batch.lease,
            batch.lineage,
        )
        .await?;
        return Err(internal_not_committed(
            "changed_collab_wal_lease",
            "room lease did not survive its guarded write",
        ));
    }

    const COVERAGE: &str = "SELECT snapshot_lease_epoch, snapshot_update_seq, carrier_dirty
        FROM collab_checkpoints WHERE space_id = $1 AND note_id = $2";
    let coverage: Option<(i64, i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(COVERAGE)
                .bind(space_id)
                .bind(note)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(COVERAGE)
                .bind(space_id)
                .bind(note)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|error| internal_not_committed("collab_wal_checkpoint_coverage", error.to_string()))?;
    let first_seq = batch.entries[0].seq as i64;
    if coverage
        .is_some_and(|(covered_lease, through, _)| (lease, first_seq) <= (covered_lease, through))
    {
        return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
    }

    if batch.replay_safe {
        if resolve_replay_tx(tx, &batch, first_seq).await? {
            return Ok(());
        }

        let (head, facts) = load_room_note_facts_tx(tx, space, &batch.note).await?;
        if head.doc_class != DocClass::UserDoc {
            return Err(DomainError::ResourceNotFound.into());
        }
        for entry in &batch.entries {
            let auth = entry.auth.as_ref().ok_or_else(|| {
                internal_not_committed("missing_room_writer", "new room WAL row lacks an author")
            })?;
            auth.authorize_read(&facts)?;
            auth.authorize_direct_write(&facts, &facts)?;
        }
    }

    const INSERT: &str = "INSERT INTO collab_update_log
        (space_id, note_id, lease_epoch, update_seq, update_bytes, created_at_ms)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING";
    let now_ms = now_unix_ms()?;
    for entry in batch.entries {
        let inserted = match tx {
            BackendConn::Sqlite(conn) => sqlx::query(INSERT)
                .bind(space_id)
                .bind(note)
                .bind(lease)
                .bind(entry.seq as i64)
                .bind(&entry.bytes)
                .bind(now_ms)
                .execute(&mut **conn)
                .await
                .map(|result| result.rows_affected()),
            BackendConn::Postgres(conn) => sqlx::query(INSERT)
                .bind(space_id)
                .bind(note)
                .bind(lease)
                .bind(entry.seq as i64)
                .bind(&entry.bytes)
                .bind(now_ms)
                .execute(&mut **conn)
                .await
                .map(|result| result.rows_affected()),
        }
        .map_err(|error| internal_not_committed("insert_collab_wal", error.to_string()))?;
        if inserted != 1 {
            return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
        }
    }

    if !coverage.is_some_and(|(_, _, dirty)| dirty != 0) {
        const MARK_DIRTY: &str = "INSERT INTO collab_checkpoints
            (space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
            VALUES ($1, $2, 0, 0, 1)
            ON CONFLICT(space_id, note_id) DO UPDATE SET carrier_dirty = 1";
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query(MARK_DIRTY)
                .bind(space_id)
                .bind(note)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
            BackendConn::Postgres(conn) => sqlx::query(MARK_DIRTY)
                .bind(space_id)
                .bind(note)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
        }
        .map_err(|error| internal_not_committed("mark_collab_wal_dirty", error.to_string()))?;
    }
    Ok(())
}

async fn resolve_replay_tx(
    tx: &mut BackendConn<'_>,
    batch: &PendingWalBatch,
    first_seq: i64,
) -> Result<bool, PortError> {
    const MAX_SEQ: &str = "SELECT MAX(update_seq) FROM collab_update_log
        WHERE space_id = $1 AND note_id = $2 AND lease_epoch = $3";
    let space = batch.scope.space_id.as_str();
    let note = batch.note.as_str();
    let lease = batch.lease.get() as i64;
    let max: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(MAX_SEQ)
                .bind(space)
                .bind(note)
                .bind(lease)
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(MAX_SEQ)
                .bind(space)
                .bind(note)
                .bind(lease)
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|error| internal_not_committed("collab_wal_last_sequence", error.to_string()))?;
    if max.is_none_or(|max| max < first_seq) {
        return Ok(false);
    }

    // An overlap is only legitimate for a byte-exact retry of the whole batch.
    // Read by primary key to bound the work even with sparse sequence numbers.
    const GET: &str = "SELECT update_bytes FROM collab_update_log
        WHERE space_id = $1 AND note_id = $2 AND lease_epoch = $3 AND update_seq = $4";
    for entry in &batch.entries {
        let found: Option<Vec<u8>> = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query_scalar(GET)
                    .bind(space)
                    .bind(note)
                    .bind(lease)
                    .bind(entry.seq as i64)
                    .fetch_optional(&mut **conn)
                    .await
            }
            BackendConn::Postgres(conn) => {
                sqlx::query_scalar(GET)
                    .bind(space)
                    .bind(note)
                    .bind(lease)
                    .bind(entry.seq as i64)
                    .fetch_optional(&mut **conn)
                    .await
            }
        }
        .map_err(|error| internal_not_committed("lookup_collab_wal_retry", error.to_string()))?;
        if found.as_deref() != Some(entry.bytes.as_slice()) {
            return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
        }
    }
    Ok(true)
}

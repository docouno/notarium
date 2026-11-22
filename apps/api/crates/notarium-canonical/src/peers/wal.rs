use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{LeaseEpoch, LineageEpoch, NoteId},
    model::{HistoryScope, Lifecycle},
    ports::CallBudget,
};
use rusqlite::{OptionalExtension, params};

#[cfg(any(test, feature = "test-support"))]
use super::AppendCollabUpdate;
use super::{AppendCollabUpdates, CollabRoomState, admission::load_room_note_facts_after_purge_tx};
use crate::{
    CanonicalStore,
    codec::{internal_not_committed, now_unix_ms},
    domain::common::CommandDeadline,
    runtime::pg_read_error,
    sql_exec::BackendConn,
    sqlite_fast::{
        DeferredAppendRows, FastBatchSqlCache, FastItemExecError, SqliteSyncItemPlan,
        build_resource_facts_cached, load_note_head_row_rusqlite,
    },
    writer::{
        ItemCommitArtifacts, ItemExecCtx, ItemExecuteFn, PreparedWriteIntent, RoomWalAdmission,
    },
};

pub(crate) struct PendingWalBatch {
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
    /// Trusted room-owner seam retained only for internal storage tests of the
    /// single-update API.
    #[cfg(any(test, feature = "test-support"))]
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
    let scope = batch.scope.clone();
    let note = batch.note.clone();
    let batch = std::sync::Arc::new(batch);
    let batch_async = std::sync::Arc::clone(&batch);
    let intent = PreparedWriteIntent {
        scope,
        active_epoch: LeaseEpoch::ZERO,
        idempotency: None,
        source_note_ids: vec![note],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, ctx| {
            Box::pin(async move {
                append_batch_tx(tx, &ctx.space, &batch_async).await?;
                Ok(ItemCommitArtifacts::unsequenced(
                    CanonicalStore::encode_command_outcome(&last_seq)?,
                ))
            })
        }),
    };
    let fast_plan: Option<Box<dyn SqliteSyncItemPlan>> = store
        .is_sqlite_local()
        .then(|| Box::new(RoomWalFastPlan { batch, last_seq }) as Box<dyn SqliteSyncItemPlan>);
    store
        .submit_room_wal(
            budget,
            deadline.at,
            intent,
            replay_safe,
            fast_plan,
            admission,
        )
        .await
}

struct RoomWalFastPlan {
    batch: std::sync::Arc<PendingWalBatch>,
    last_seq: u64,
}

impl SqliteSyncItemPlan for RoomWalFastPlan {
    fn take_deferred_local_staging(&self) -> Option<crate::blobs::local::DeferredLocalStaging> {
        None
    }

    fn is_unsequenced_room_wal(&self) -> bool {
        true
    }

    fn replay_safe(&self) -> bool {
        self.batch.replay_safe
    }

    fn into_async_exec(self: Box<Self>) -> ItemExecuteFn {
        let me = *self;
        Box::new(move |tx, ctx| {
            Box::pin(async move {
                append_batch_tx(tx, &ctx.space, &me.batch).await?;
                Ok(ItemCommitArtifacts::unsequenced(
                    CanonicalStore::encode_command_outcome(&me.last_seq)?,
                ))
            })
        })
    }

    fn execute_sqlite_sync(
        &self,
        conn: &rusqlite::Connection,
        item_ctx: &mut ItemExecCtx,
        cache: &mut FastBatchSqlCache,
        _batch_now_ts: notarium_core::value::Timestamp,
        batch_now_ms: i64,
        _defer_append: Option<&mut DeferredAppendRows>,
    ) -> Result<ItemCommitArtifacts, FastItemExecError> {
        let batch = &self.batch;
        let space_id = batch.scope.space_id.as_str();
        let note = batch.note.as_str();
        let lease = batch.lease.get() as i64;
        let lineage = batch.lineage.get() as i64;

        let lease_row: Option<(i64, i64, String, Option<String>)> = conn
            .prepare_cached(
                "SELECT lease_epoch, lineage_epoch, room_state, owner_id
                 FROM collab_sessions WHERE space_id = ?1 AND note_id = ?2",
            )
            .and_then(|mut s| {
                s.query_row(params![space_id, note], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()
            })
            .map_err(|err| {
                FastItemExecError::PreWrite(internal_not_committed(
                    "sqlite_read_collab_wal_lease",
                    err.to_string(),
                ))
            })?;
        verify_lease_row(lease_row, &batch.owner_id, batch.lease, batch.lineage)
            .map_err(FastItemExecError::PreWrite)?;

        let coverage: Option<(i64, i64, i64)> = conn
            .prepare_cached(
                "SELECT snapshot_lease_epoch, snapshot_update_seq, carrier_dirty
                 FROM collab_checkpoints WHERE space_id = ?1 AND note_id = ?2",
            )
            .and_then(|mut s| {
                s.query_row(params![space_id, note], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()
            })
            .map_err(|err| {
                FastItemExecError::PreWrite(internal_not_committed(
                    "sqlite_collab_wal_checkpoint_coverage",
                    err.to_string(),
                ))
            })?;
        let first_seq = batch.entries[0].seq as i64;
        if coverage.is_some_and(|(covered_lease, through, _)| {
            (lease, first_seq) <= (covered_lease, through)
        }) {
            return Err(FastItemExecError::PreWrite(
                DomainError::validation(ValidationReason::DuplicateKey).into(),
            ));
        }

        if batch.replay_safe {
            let max_seq: Option<i64> = conn
                .prepare_cached(
                    "SELECT MAX(update_seq) FROM collab_update_log
                     WHERE space_id = ?1 AND note_id = ?2 AND lease_epoch = ?3",
                )
                .and_then(|mut s| s.query_row(params![space_id, note, lease], |r| r.get(0)))
                .map_err(|err| {
                    FastItemExecError::PreWrite(internal_not_committed(
                        "sqlite_collab_wal_last_seq",
                        err.to_string(),
                    ))
                })?;
            if max_seq.is_some_and(|max| max >= first_seq) {
                let mut get_stmt = conn
                    .prepare_cached(
                        "SELECT update_bytes FROM collab_update_log
                         WHERE space_id = ?1 AND note_id = ?2 AND lease_epoch = ?3 AND update_seq = ?4",
                    )
                    .map_err(|err| {
                        FastItemExecError::PreWrite(internal_not_committed(
                            "sqlite_lookup_collab_wal_retry",
                            err.to_string(),
                        ))
                    })?;
                for entry in &batch.entries {
                    let found: Option<Vec<u8>> = get_stmt
                        .query_row(params![space_id, note, lease, entry.seq as i64], |r| {
                            r.get(0)
                        })
                        .optional()
                        .map_err(|err| {
                            FastItemExecError::PreWrite(internal_not_committed(
                                "sqlite_lookup_collab_wal_retry",
                                err.to_string(),
                            ))
                        })?;
                    if found.as_deref() != Some(entry.bytes.as_slice()) {
                        return Err(FastItemExecError::PreWrite(
                            DomainError::validation(ValidationReason::DuplicateKey).into(),
                        ));
                    }
                }
                let encoded = CanonicalStore::encode_command_outcome(&self.last_seq)
                    .map_err(FastItemExecError::PreWrite)?;
                return Ok(ItemCommitArtifacts::unsequenced(encoded));
            }

            if item_ctx.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active {
                return Err(FastItemExecError::PreWrite(
                    DomainError::ResourceNotFound.into(),
                ));
            }
            let head = load_note_head_row_rusqlite(conn, &batch.scope.space_id, &batch.note)
                .map_err(FastItemExecError::PreWrite)?;
            if head.lifecycle != Lifecycle::Active || head.doc_class != DocClass::UserDoc {
                return Err(FastItemExecError::PreWrite(
                    DomainError::ResourceNotFound.into(),
                ));
            }
            let (facts, _) = build_resource_facts_cached(
                conn,
                cache,
                &item_ctx.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                true,
            )
            .map_err(FastItemExecError::PreWrite)?;
            for entry in &batch.entries {
                let auth = entry.auth.as_ref().ok_or_else(|| {
                    FastItemExecError::PreWrite(internal_not_committed(
                        "missing_room_writer",
                        "new room WAL row lacks an author",
                    ))
                })?;
                auth.authorize_read(&facts)
                    .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
                auth.authorize_direct_write(&facts, &facts)
                    .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
            }
        } else {
            // Non-replay-safe test seam: pre-check duplicates before any write so
            // DuplicateKey stays a clean PreWrite error without forcing fallback.
            let mut exists_stmt = conn
                .prepare_cached(
                    "SELECT 1 FROM collab_update_log
                     WHERE space_id = ?1 AND note_id = ?2 AND lease_epoch = ?3 AND update_seq = ?4",
                )
                .map_err(|err| {
                    FastItemExecError::PreWrite(internal_not_committed(
                        "sqlite_check_collab_wal_dup",
                        err.to_string(),
                    ))
                })?;
            for entry in &batch.entries {
                let exists: Option<i64> = exists_stmt
                    .query_row(params![space_id, note, lease, entry.seq as i64], |r| {
                        r.get(0)
                    })
                    .optional()
                    .map_err(|err| {
                        FastItemExecError::PreWrite(internal_not_committed(
                            "sqlite_check_collab_wal_dup",
                            err.to_string(),
                        ))
                    })?;
                if exists.is_some() {
                    return Err(FastItemExecError::PreWrite(
                        DomainError::validation(ValidationReason::DuplicateKey).into(),
                    ));
                }
            }
        }

        // --- All validations passed; perform SQLite WAL inserts ---
        let mut insert_stmt = conn
            .prepare_cached(
                "INSERT INTO collab_update_log
                 (space_id, note_id, lease_epoch, update_seq, update_bytes, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
            )
            .map_err(|err| {
                FastItemExecError::PostWrite(internal_not_committed(
                    "sqlite_insert_collab_wal",
                    err.to_string(),
                ))
            })?;
        for entry in &batch.entries {
            let inserted = insert_stmt
                .execute(params![
                    space_id,
                    note,
                    lease,
                    entry.seq as i64,
                    entry.bytes.as_slice(),
                    batch_now_ms
                ])
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_insert_collab_wal",
                        err.to_string(),
                    ))
                })?;
            if inserted != 1 {
                return Err(FastItemExecError::PostWrite(
                    DomainError::validation(ValidationReason::DuplicateKey).into(),
                ));
            }
        }

        if !coverage.is_some_and(|(_, _, dirty)| dirty != 0) {
            conn.prepare_cached(
                "INSERT INTO collab_checkpoints
                 (space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
                 VALUES (?1, ?2, 0, 0, 1)
                 ON CONFLICT(space_id, note_id) DO UPDATE SET carrier_dirty = 1",
            )
            .and_then(|mut s| s.execute(params![space_id, note]))
            .map_err(|err| {
                FastItemExecError::PostWrite(internal_not_committed(
                    "sqlite_mark_collab_wal_dirty",
                    err.to_string(),
                ))
            })?;
        }
        // Keep lineage binding visible to clippy / invariants.
        let _ = lineage;

        let encoded = CanonicalStore::encode_command_outcome(&self.last_seq)
            .map_err(FastItemExecError::PostWrite)?;
        Ok(ItemCommitArtifacts::unsequenced(encoded))
    }
}

fn verify_lease_row(
    row: Option<(i64, i64, String, Option<String>)>,
    owner: &str,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
) -> Result<(), PortError> {
    let (row_lease, row_lineage, row_state, row_owner) =
        row.ok_or(DomainError::ResourceNotFound)?;
    if CollabRoomState::from_db(&row_state)? != CollabRoomState::Active {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if row_lease != lease.get() as i64 || row_owner.as_deref() != Some(owner) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if row_lineage != lineage.get() as i64 {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

async fn verify_wal_owner_inner(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    owner: &str,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
    lock_pg_share: bool,
) -> Result<(), PortError> {
    const SQL_SQLITE: &str = "SELECT lease_epoch, lineage_epoch, room_state, owner_id
        FROM collab_sessions WHERE space_id = $1 AND note_id = $2";
    const SQL_PG_SHARE: &str = "SELECT lease_epoch, lineage_epoch, room_state, owner_id
        FROM collab_sessions WHERE space_id = $1 AND note_id = $2 FOR SHARE";
    let row = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as::<_, (i64, i64, String, Option<String>)>(SQL_SQLITE)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|error| {
                    internal_not_committed("read_collab_wal_lease", error.to_string())
                })?
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as::<_, (i64, i64, String, Option<String>)>(if lock_pg_share {
                SQL_PG_SHARE
            } else {
                SQL_SQLITE
            })
            .bind(scope.space_id.as_str())
            .bind(note.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|error| pg_read_error("pg_read_collab_wal_lease", error))?
        }
    };
    verify_lease_row(row, owner, lease, lineage)
}

async fn append_batch_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    batch: &PendingWalBatch,
) -> Result<(), PortError> {
    // The batch writer already holds the Space row lock (`FOR NO KEY UPDATE` on PG,
    // single writer mutex on SQLite). Verify exact room lease with `SELECT ... FOR SHARE`
    // on PG instead of issuing a no-op `UPDATE` that dirties pages / dead tuples.
    verify_wal_owner_inner(
        tx,
        &batch.scope,
        &batch.note,
        &batch.owner_id,
        batch.lease,
        batch.lineage,
        true,
    )
    .await?;

    let space_id = batch.scope.space_id.as_str();
    let note = batch.note.as_str();
    let lease = batch.lease.get() as i64;

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
        if resolve_replay_tx(tx, batch, first_seq).await? {
            return Ok(());
        }

        let facts = match tx {
            BackendConn::Postgres(conn) => {
                let rows =
                    super::admission::query_room_facts_pg(conn, &batch.scope.space_id, &batch.note)
                        .await?;
                let active = super::admission::decode_room_facts_rows(&batch.scope, rows, None)?;
                if active.resource.class != DocClass::UserDoc {
                    return Err(DomainError::ResourceNotFound.into());
                }
                active.resource
            }
            BackendConn::Sqlite(_) => {
                let (head, facts) =
                    load_room_note_facts_after_purge_tx(tx, space, &batch.note, true).await?;
                if head.doc_class != DocClass::UserDoc {
                    return Err(DomainError::ResourceNotFound.into());
                }
                facts
            }
        };
        for entry in &batch.entries {
            let auth = entry.auth.as_ref().ok_or_else(|| {
                internal_not_committed("missing_room_writer", "new room WAL row lacks an author")
            })?;
            auth.authorize_read(&facts)?;
            auth.authorize_direct_write(&facts, &facts)?;
        }
    }

    let now_ms = now_unix_ms()?;
    let expected_rows = batch.entries.len() as u64;
    let mut inserted = 0u64;
    for chunk in batch.entries.chunks(500) {
        let rows: u64 = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "INSERT INTO collab_update_log \
                     (space_id, note_id, lease_epoch, update_seq, update_bytes, created_at_ms) ",
                );
                qb.push_values(chunk, |mut b, entry| {
                    b.push_bind(space_id)
                        .push_bind(note)
                        .push_bind(lease)
                        .push_bind(entry.seq as i64)
                        .push_bind(entry.bytes.as_slice())
                        .push_bind(now_ms);
                });
                qb.push(" ON CONFLICT DO NOTHING");
                qb.build()
                    .execute(&mut **conn)
                    .await
                    .map(|r| r.rows_affected())
            }
            BackendConn::Postgres(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
                    "INSERT INTO collab_update_log \
                     (space_id, note_id, lease_epoch, update_seq, update_bytes, created_at_ms) ",
                );
                qb.push_values(chunk, |mut b, entry| {
                    b.push_bind(space_id)
                        .push_bind(note)
                        .push_bind(lease)
                        .push_bind(entry.seq as i64)
                        .push_bind(entry.bytes.as_slice())
                        .push_bind(now_ms);
                });
                qb.push(" ON CONFLICT DO NOTHING");
                qb.build()
                    .execute(&mut **conn)
                    .await
                    .map(|r| r.rows_affected())
            }
        }
        .map_err(|error| internal_not_committed("insert_collab_wal", error.to_string()))?;
        inserted += rows;
    }
    if inserted != expected_rows {
        return Err(DomainError::validation(ValidationReason::DuplicateKey).into());
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

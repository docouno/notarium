use std::time::Duration;

use notarium_core::ids::RequestId;
use sqlx::PgConnection;

use crate::{
    codec::{doc_class_from_db, internal_not_committed, lifecycle_from_db},
    runtime::{load_space_record, load_space_record_for_update_opt, pg_read_error},
    sql_exec::{BackendConn, PgTransactionLease, WriteTransaction},
};

use super::*;

pub(super) struct NoteRow {
    pub id: NoteId,
    pub parent: Option<FolderId>,
    pub class: DocClass,
    pub lifecycle: Lifecycle,
    pub ability: Option<AbilityId>,
}

pub(super) struct FolderRow {
    pub id: FolderId,
    pub parent: Option<FolderId>,
    pub lifecycle: Lifecycle,
    pub write_locked: bool,
}

type NoteColumns = (String, Option<String>, String, String, Option<String>);
type FolderColumns = (String, Option<String>, String, bool);

impl TryFrom<NoteColumns> for NoteRow {
    type Error = PortError;

    fn try_from((id, parent, class, lifecycle, ability): NoteColumns) -> Result<Self, PortError> {
        Ok(Self {
            id: NoteId::parse(&id)?,
            parent: parent.as_deref().map(FolderId::parse).transpose()?,
            class: doc_class_from_db(&class)?,
            lifecycle: lifecycle_from_db(&lifecycle)?,
            ability: ability.as_deref().map(AbilityId::parse).transpose()?,
        })
    }
}

impl TryFrom<FolderColumns> for FolderRow {
    type Error = PortError;

    fn try_from((id, parent, lifecycle, write_locked): FolderColumns) -> Result<Self, PortError> {
        Ok(Self {
            id: FolderId::parse(&id)?,
            parent: parent.as_deref().map(FolderId::parse).transpose()?,
            lifecycle: lifecycle_from_db(&lifecycle)?,
            write_locked,
        })
    }
}

const NOTE_PAGE: &str = "SELECT note_id, parent_folder_id, doc_class, lifecycle_state, ability_id
    FROM note_heads WHERE space_id=$1 AND note_id>$2 AND lifecycle_state<>'purged'
    ORDER BY note_id LIMIT $3";

const FOLDER_PAGE: &str = "SELECT folder_id, parent_folder_id, lifecycle_state,
    write_lock_json IS NOT NULL FROM folder_heads WHERE space_id=$1 AND folder_id>$2
    ORDER BY folder_id LIMIT $3";

fn page_budget(budget: &CallBudget, deadline: tokio::time::Instant) -> CallBudget {
    CallBudget {
        remaining: deadline.saturating_duration_since(tokio::time::Instant::now()),
        ..budget.clone()
    }
}

async fn validate_seed(tx: &mut BackendConn<'_>, expected: &SpaceRecord) -> Result<(), PortError> {
    let actual = load_space_record(tx, &expected.space.id).await?;
    actual.scope.check(&expected.scope)?;
    if actual.last_seq != expected.last_seq
        || actual.active_epoch != expected.active_epoch
        || actual.space.lifecycle != expected.space.lifecycle
    {
        return Err(not_ready());
    }
    Ok(())
}

pub(super) async fn seed(
    store: &CanonicalStore,
    state: &mut LiveState,
    budget: &CallBudget,
    deadline: tokio::time::Instant,
) -> Result<(), PortError> {
    let mut after = String::new();
    loop {
        let expected = state.record.clone();
        let position = after;
        let budget = page_budget(budget, deadline);
        let rows: Vec<FolderColumns> = store
            .with_read_tx_budget(Some(&budget), |tx| {
                Box::pin(async move {
                    validate_seed(tx, &expected).await?;
                    let space = expected.space.id.as_str();
                    let rows = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_as(FOLDER_PAGE)
                            .bind(space)
                            .bind(position)
                            .bind(PAGE_ROWS as i64)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_live_folder_page", err.to_string())
                            })?,
                        BackendConn::Postgres(conn) => sqlx::query_as(FOLDER_PAGE)
                            .bind(space)
                            .bind(position)
                            .bind(PAGE_ROWS as i64)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| pg_read_error("pg_live_folder_page", err))?,
                    };
                    Ok(rows)
                })
            })
            .await?;
        after = rows.last().map_or_else(String::new, |r| r.0.clone());
        let complete = rows.len() < PAGE_ROWS;
        for row in rows {
            state.apply_folder(row.try_into()?)?;
        }
        if complete {
            break;
        }
    }

    let mut after = String::new();
    loop {
        let expected = state.record.clone();
        let position = after;
        let budget = page_budget(budget, deadline);
        let rows: Vec<NoteColumns> = store
            .with_read_tx_budget(Some(&budget), |tx| {
                Box::pin(async move {
                    validate_seed(tx, &expected).await?;
                    let space = expected.space.id.as_str();
                    let rows = match tx {
                        BackendConn::Sqlite(conn) => sqlx::query_as(NOTE_PAGE)
                            .bind(space)
                            .bind(position)
                            .bind(PAGE_ROWS as i64)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_live_note_page", err.to_string())
                            })?,
                        BackendConn::Postgres(conn) => sqlx::query_as(NOTE_PAGE)
                            .bind(space)
                            .bind(position)
                            .bind(PAGE_ROWS as i64)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| pg_read_error("pg_live_note_page", err))?,
                    };
                    Ok(rows)
                })
            })
            .await?;
        after = rows.last().map_or_else(String::new, |r| r.0.clone());
        let complete = rows.len() < PAGE_ROWS;
        for row in rows {
            state.apply_note(row.try_into()?)?;
        }
        if complete {
            return Ok(());
        }
    }
}

// An ability publication may attach the entrypoint without a new note
// revision. Use the command's ability key to refresh that note as well.
const NOTES_DELTA: &str = "WITH changed AS (
    SELECT entity_type, entity_id FROM change_log
    WHERE space_id=$1 AND space_seq>$2 AND space_seq<=$3 AND entity_type IN ('note','ability')
), notes AS (
    SELECT entity_id AS note_id FROM changed WHERE entity_type='note'
    UNION SELECT p.entrypoint_note_id FROM changed c JOIN ability_packages p
        ON p.space_id=$1 AND p.ability_id=c.entity_id WHERE c.entity_type='ability'
)
SELECT n.note_id, h.parent_folder_id, COALESCE(h.doc_class,'user-doc'),
       COALESCE(h.lifecycle_state,'purged'), h.ability_id
FROM notes n LEFT JOIN note_heads h ON h.space_id=$1 AND h.note_id=n.note_id";

const FOLDERS_DELTA: &str = "SELECT folder_id, parent_folder_id, lifecycle_state, write_lock_json IS NOT NULL
    FROM folder_heads WHERE space_id=$1 AND folder_id IN (
        SELECT entity_id FROM change_log WHERE space_id=$1 AND space_seq>$2 AND space_seq<=$3 AND entity_type='folder'
    )";

const ERASURES: &str = "SELECT entity_id,CAST(0 AS BIGINT),space_seq FROM change_log
    WHERE space_id=$1 AND space_seq>$2 AND space_seq<=$3 AND entity_type='note' AND op_kind='purge'
    UNION ALL
    SELECT e.thread_id,e.entry_seq,e.redacted_at_seq
    FROM change_log l JOIN chat_entries e
      ON e.space_id=l.space_id AND e.thread_id=l.entity_id AND e.redacted_at_seq=l.space_seq
    WHERE l.space_id=$1 AND l.space_seq>$2 AND l.space_seq<=$3
      AND l.entity_type='thread' AND l.op_kind='redact' AND e.redacted_at_seq IS NOT NULL";

struct Patch {
    record: SpaceRecord,
    folders: Vec<FolderColumns>,
    notes: Vec<NoteColumns>,
    erasures: ProjectionErasures,
    can_refresh: bool,
}

async fn load_erasures(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    after: SpaceSeq,
    through: SpaceSeq,
) -> Result<ProjectionErasures, PortError> {
    let sid = scope.space_id.as_str();
    let after = after.get() as i64;
    let mut erasures = ProjectionErasures {
        scope: scope.clone(),
        through,
        purged: Vec::new(),
        redacted: Vec::new(),
    };
    let rows: Vec<(String, i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(ERASURES)
            .bind(sid)
            .bind(after)
            .bind(through.get() as i64)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_projection_erasures", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(ERASURES)
            .bind(sid)
            .bind(after)
            .bind(through.get() as i64)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_projection_erasures", err))?,
    };
    for (id, entry, seq) in rows {
        if entry == 0 {
            erasures.purged.push(NoteId::parse(&id)?);
        } else {
            erasures.redacted.push(ProjectionRedactedEntry {
                thread: ChatThreadId::parse(&id)?,
                entry: ThreadEntrySeq::new(u64::try_from(entry).map_err(|_| not_ready())?)?,
                redacted_at: crate::codec::i64_to_space_seq(seq)?,
            });
        }
    }
    Ok(erasures)
}

pub(super) async fn erase_window(
    store: &CanonicalStore,
    cleanup: &dyn ProjectionVisibilityCleanup,
    window: &VisibilityWindow,
) -> Result<bool, PortError> {
    let window = window.clone();
    let budget = internal_budget();
    let erasures = store
        .with_read_tx_budget(Some(&budget), move |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &window.scope.space_id).await?;
                if record.scope != window.scope {
                    // The old history has already been revoked by restore.
                    return Ok(None);
                }
                if record.last_seq < window.through {
                    return Err(not_ready());
                }
                Ok(Some(
                    load_erasures(tx, &window.scope, window.after, window.through).await?,
                ))
            })
        })
        .await?;
    let Some(erasures) = erasures else {
        return Ok(false);
    };
    let purged = !erasures.purged.is_empty();
    if purged || !erasures.redacted.is_empty() {
        cleanup.erase_visibility(&erasures).await?;
    }
    Ok(purged)
}

pub(super) async fn receipt_window(
    store: &CanonicalStore,
    scope: &HistoryScope,
    through: SpaceSeq,
    budget: &CallBudget,
) -> Result<VisibilityWindow, PortError> {
    let scope = scope.clone();
    store
        .with_read_tx_budget(Some(budget), move |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                const SQL: &str = "SELECT first_seq FROM change_commands
                    WHERE space_id=$1 AND history_incarnation=$2 AND last_seq=$3";
                let space = scope.space_id.as_str();
                let history = scope.incarnation.as_bytes().as_slice();
                let end = through.get() as i64;
                let first: Option<i64> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(SQL)
                        .bind(space)
                        .bind(history)
                        .bind(end)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|error| {
                            internal_not_committed("sqlite_erasure_receipt", error.to_string())
                        })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(SQL)
                        .bind(space)
                        .bind(history)
                        .bind(end)
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|error| pg_read_error("pg_erasure_receipt", error))?,
                };
                let first = first.ok_or_else(not_ready)?;
                let after =
                    crate::codec::i64_to_space_seq(first.checked_sub(1).ok_or_else(not_ready)?)?;
                Ok(VisibilityWindow {
                    scope,
                    after,
                    through,
                    changes: crate::projection_fence::VisibilityChanges::all(),
                })
            })
        })
        .await
}

pub(super) enum RefreshError {
    Visibility(PortError),
    Cleanup(PortError),
}

impl From<PortError> for RefreshError {
    fn from(error: PortError) -> Self {
        Self::Visibility(error)
    }
}

pub(super) async fn refresh(
    store: &CanonicalStore,
    state: &mut LiveState,
    budget: &CallBudget,
    changes: crate::projection_fence::VisibilityChanges,
) -> Result<(), RefreshError> {
    let previous = state.record.clone();
    let cleanup = store.inner.live_visibility.cleanup();
    let read_erasures = cleanup.is_some() && changes.erasures;
    let read_folders = changes.folders;
    let read_notes = changes.notes;
    let patch = store
        .with_read_tx_budget(Some(budget), move |tx| {
            Box::pin(async move {
                let next = load_space_record(tx, &previous.space.id).await?;
                if next.scope != previous.scope || next.active_epoch != previous.active_epoch {
                    return Ok(None);
                }
                let from = previous.last_seq.get() as i64;
                let through = next.last_seq.get() as i64;
                if from > through {
                    return Err(not_ready());
                }
                let mut patch = Patch {
                    erasures: ProjectionErasures {
                        scope: next.scope.clone(),
                        through: next.last_seq,
                        purged: Vec::new(),
                        redacted: Vec::new(),
                    },
                    record: next,
                    notes: Vec::new(),
                    folders: Vec::new(),
                    can_refresh: through - from <= MAX_DELTA_NOTES as i64,
                };
                if from == through {
                    return Ok(Some(patch));
                }
                let space = patch.record.space.id.as_str();
                macro_rules! rows {
                    ($sql:expr) => {{
                        match tx {
                            BackendConn::Sqlite(conn) => sqlx::query_as($sql)
                                .bind(space)
                                .bind(from)
                                .bind(through)
                                .fetch_all(&mut **conn)
                                .await
                                .map_err(|err| {
                                    internal_not_committed(
                                        "sqlite_visibility_delta",
                                        err.to_string(),
                                    )
                                }),
                            BackendConn::Postgres(conn) => sqlx::query_as($sql)
                                .bind(space)
                                .bind(from)
                                .bind(through)
                                .fetch_all(&mut **conn)
                                .await
                                .map_err(|err| pg_read_error("pg_visibility_delta", err)),
                        }
                    }};
                }
                if read_erasures {
                    patch.erasures = load_erasures(
                        tx,
                        &patch.record.scope,
                        previous.last_seq,
                        patch.record.last_seq,
                    )
                    .await?;
                }
                if patch.can_refresh {
                    if read_folders {
                        patch.folders = rows!(FOLDERS_DELTA)?;
                    }
                    if read_notes {
                        patch.notes = rows!(NOTES_DELTA)?;
                    }
                }
                Ok(Some(patch))
            })
        })
        .await
        .map_err(|error| {
            if read_erasures {
                RefreshError::Cleanup(error)
            } else {
                RefreshError::Visibility(error)
            }
        })?
        .ok_or_else(|| RefreshError::Visibility(not_ready()))?;
    if !patch.erasures.purged.is_empty() {
        // Retire the dense lookup handle BEFORE running physical file erasure
        // so the checkpoint file is no longer pinned by LiveState.
        state.retire_lookup_before(patch.erasures.through);
    }
    if let Some(cleanup) = cleanup
        && (!patch.erasures.purged.is_empty() || !patch.erasures.redacted.is_empty())
    {
        cleanup
            .erase_visibility(&patch.erasures)
            .await
            .map_err(RefreshError::Cleanup)?;
    }
    if !patch.can_refresh {
        return Err(RefreshError::Visibility(not_ready()));
    }
    let notes = patch
        .notes
        .into_iter()
        .map(NoteRow::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    state.change_notes(patch.record.last_seq, &notes, !patch.folders.is_empty());
    for folder in patch.folders {
        state.apply_folder(folder.try_into()?)?;
    }
    for note in notes {
        state.apply_note(note)?;
    }
    state.record = patch.record;
    Ok(())
}

/// Runtime process authority is intentionally excluded from backup artifacts.
pub(crate) async fn ensure_postgres_owner_table(conn: &mut PgConnection) -> Result<(), PortError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS projection_space_owners (
            space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
            history_incarnation BYTEA NOT NULL CHECK(octet_length(history_incarnation)=16),
            active_epoch BIGINT NOT NULL CHECK(active_epoch>=0),
            process_id TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('active','draining','drained'))
        )",
    )
    .execute(conn)
    .await
    .map_err(|err| internal_not_committed("pg_projection_owner_registry", err.to_string()))?;
    Ok(())
}

struct PinnedOwner {
    history: Vec<u8>,
    epoch: i64,
    process: String,
    phase: String,
}

async fn read_owner(
    conn: &mut PgConnection,
    space: &SpaceId,
) -> Result<Option<PinnedOwner>, PortError> {
    let value: Option<(Vec<u8>, i64, String, String)> = sqlx::query_as(
        "SELECT history_incarnation, active_epoch, process_id, phase
        FROM projection_space_owners WHERE space_id=$1",
    )
    .bind(space.as_str())
    .fetch_optional(conn)
    .await
    .map_err(|err| internal_not_committed("pg_projection_read_owner", err.to_string()))?;
    Ok(value.map(|(history, epoch, process, phase)| PinnedOwner {
        history,
        epoch,
        process,
        phase,
    }))
}

async fn owner_tx<T>(
    store: &CanonicalStore,
    budget: &CallBudget,
    deadline: tokio::time::Instant,
    operation: impl for<'c> FnOnce(
        &'c mut BackendConn<'_>,
    ) -> crate::BoxFuture<'c, Result<T, PortError>>,
) -> Result<T, PortError> {
    let SqlDriverState::Postgres { pool, .. } = &store.inner.sql else {
        return Err(not_ready());
    };
    let mut pooled = budgeted(budget, deadline, pool.acquire())
        .await?
        .map_err(|err| internal_not_committed("pg_projection_owner_acquire", err.to_string()))?;
    let mut lease = PgTransactionLease::new(&mut pooled);
    let mut database = BackendConn::Postgres(lease.conn());
    let mut tx = budgeted(budget, deadline, WriteTransaction::begin(&mut database)).await??;
    let value = budgeted(budget, deadline, operation(&mut tx.conn())).await??;
    // Finishing this transaction contributes no local admission even on an
    // ambiguous commit. The same runtime may retry its durable claim/drain.
    budgeted(budget, deadline, tx.commit())
        .await
        .map_err(|error| {
            crate::codec::unknown_commit_non_idempotent(
                "pg_projection_owner_commit",
                error.to_string(),
            )
        })??;
    lease.complete();
    Ok(value)
}

pub(super) async fn claim(
    store: &CanonicalStore,
    process: &str,
    scope: &HistoryScope,
    budget: &CallBudget,
    deadline: tokio::time::Instant,
) -> Result<SpaceRecord, PortError> {
    let scope = scope.clone();
    let process = process.to_owned();
    let inner = Arc::clone(&store.inner);
    owner_tx(store, budget, deadline, move |tx| Box::pin(async move {
        let record = load_space_record_for_update_opt(tx, &scope.space_id)
            .await?.ok_or(DomainError::ResourceNotFound)?;
        record.scope.check(&scope)?;
        inner.check_writer_epoch(&scope.space_id, record.active_epoch)
            .map_err(|_| not_ready())?;
        let BackendConn::Postgres(conn) = tx else { return Err(not_ready()); };
        let epoch = record.active_epoch.get() as i64;
        if let Some(owner) = read_owner(conn, &scope.space_id).await? {
            if owner.epoch != epoch || owner.history != scope.incarnation.as_bytes().as_slice()
                || owner.process != process || owner.phase != "active"
            {
                return Err(not_ready());
            }
        } else {
            sqlx::query("INSERT INTO projection_space_owners
                (space_id,history_incarnation,active_epoch,process_id,phase) VALUES($1,$2,$3,$4,'active')")
                .bind(scope.space_id.as_str()).bind(scope.incarnation.as_bytes().as_slice())
                .bind(epoch).bind(process).execute(&mut **conn).await
                .map_err(|err| internal_not_committed("pg_projection_claim_owner", err.to_string()))?;
        }
        Ok(record)
    })).await
}

pub(super) async fn owner_space_record(
    store: &CanonicalStore,
    process: &str,
    scope: &HistoryScope,
    budget: &CallBudget,
    deadline: tokio::time::Instant,
) -> Result<SpaceRecord, PortError> {
    match &store.inner.sql {
        SqlDriverState::Postgres { .. } => claim(store, process, scope, budget, deadline).await,
        SqlDriverState::Sqlite { writer, .. } => {
            // This connection observes any previously submitted COMMIT before
            // admitting a fresh scope, including an abandoned caller's commit.
            let mut writer = budgeted(budget, deadline, writer.lock()).await?;
            let pair = writer.as_mut().ok_or_else(not_ready)?;
            let mut reader = BackendConn::Sqlite(&mut pair.sqlx_conn);
            let record = budgeted(
                budget,
                deadline,
                load_space_record(&mut reader, &scope.space_id),
            )
            .await??;
            record.scope.check(scope)?;
            Ok(record)
        }
    }
}

pub(super) async fn owner_identity(
    store: &CanonicalStore,
    scope: &HistoryScope,
    budget: &CallBudget,
    active_only: bool,
) -> Result<Option<ProjectionOwnerIdentity>, PortError> {
    let scope = scope.clone();
    store
        .with_read_tx_budget(Some(budget), move |tx| {
            Box::pin(async move {
                let record = load_space_record(tx, &scope.space_id).await?;
                record.scope.check(&scope)?;
                let BackendConn::Postgres(conn) = tx else {
                    return Ok(None);
                };
                Ok(read_owner(conn, &scope.space_id).await?.and_then(|owner| {
                    (owner.epoch == record.active_epoch.get() as i64
                        && owner.history == scope.incarnation.as_bytes().as_slice()
                        && (!active_only || owner.phase == "active"))
                        .then_some(ProjectionOwnerIdentity {
                            scope,
                            epoch: record.active_epoch,
                            process: owner.process,
                        })
                }))
            })
        })
        .await
}

pub(super) async fn set_owner_phase(
    store: &CanonicalStore,
    identity: ProjectionOwnerIdentity,
    phase: &'static str,
    budget: &CallBudget,
    deadline: tokio::time::Instant,
) -> Result<(), PortError> {
    owner_tx(store, budget, deadline, move |tx| {
        Box::pin(async move {
            let scope = identity.scope;
            let record = load_space_record_for_update_opt(tx, &scope.space_id)
                .await?
                .ok_or(DomainError::ResourceNotFound)?;
            record.scope.check(&scope)?;
            if record.active_epoch != identity.epoch {
                return Err(not_ready());
            }
            let BackendConn::Postgres(conn) = tx else {
                return Err(not_ready());
            };
            let result = sqlx::query(
                "UPDATE projection_space_owners SET phase=
            CASE WHEN phase='drained' THEN phase ELSE $5 END
            WHERE space_id=$1 AND history_incarnation=$2 AND active_epoch=$3 AND process_id=$4",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(record.active_epoch.get() as i64)
            .bind(identity.process)
            .bind(phase)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_projection_drain_owner", err.to_string()))?;
            if result.rows_affected() != 1 {
                return Err(not_ready());
            }
            Ok(())
        })
    })
    .await
}

pub(super) async fn remove_drained(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
) -> Result<(), PortError> {
    let BackendConn::Postgres(conn) = tx else {
        return Ok(());
    };
    if let Some(owner) = read_owner(conn, &scope.space_id).await? {
        if owner.phase != "drained" || owner.history != scope.incarnation.as_bytes().as_slice() {
            return Err(not_ready());
        }
        delete_owner(conn, &scope.space_id).await?;
    }
    Ok(())
}

async fn delete_owner(conn: &mut PgConnection, space: &SpaceId) -> Result<(), PortError> {
    sqlx::query("DELETE FROM projection_space_owners WHERE space_id=$1")
        .bind(space.as_str())
        .execute(conn)
        .await
        .map_err(|err| internal_not_committed("pg_projection_release_owner", err.to_string()))?;
    Ok(())
}

/// The restore caller already holds the canonical Space row lock and the
/// local write gate for every affected Space before this check.
pub(super) async fn restore(
    tx: &mut BackendConn<'_>,
    process: &str,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
) -> Result<(), PortError> {
    let BackendConn::Postgres(conn) = tx else {
        return Ok(());
    };
    if let Some(owner) = read_owner(conn, &scope.space_id).await? {
        if owner.phase == "drained" {
            return delete_owner(conn, &scope.space_id).await;
        }
        if owner.process != process || owner.phase != "active" {
            return Err(not_ready());
        }
        sqlx::query(
            "UPDATE projection_space_owners SET history_incarnation=$2, active_epoch=$3
            WHERE space_id=$1",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(epoch.get() as i64)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_projection_restore_owner", err.to_string()))?;
    }
    Ok(())
}

pub(super) fn internal_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([0; 16]),
        cancellation: Default::default(),
        remaining: Duration::from_millis(240),
    }
}

use std::collections::BTreeSet;

use notarium_core::{
    DomainError,
    auth::{ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, ContentDigest, FolderId, HistoryIncarnation, LeaseEpoch, LineageEpoch, NoteId,
        RevisionId, SpaceId,
    },
    model::{HistoryScope, Lifecycle},
    ports::{CallBudget, ServiceAuthority, ServicePurpose, SpaceContext},
};
use rusqlite::params;
use sqlx::Row;

use super::{CollabRoomState, CollabSessionSnapshot, load_collab_snapshot_tx};
use crate::{
    CanonicalStore,
    codec::{doc_class_from_db, internal_not_committed, lifecycle_from_db},
    domain::common::{
        CommandDeadline, MAX_FOLDER_DEPTH, NoteHeadRow, build_resource_facts_tx,
        load_note_head_row_tx,
    },
    runtime::{SqlDriverState, is_note_purge_fenced_tx, load_space_record, pg_read_error},
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

/// Authorized collaboration admission metadata read at a single SQL cut without
/// fetching the carrier blob from CAS/S3.
#[derive(Debug)]
pub struct NoteCollabAdmissionMeta {
    pub scope: HistoryScope,
    pub head_rev_id: RevisionId,
    pub doc_class: DocClass,
    pub slug: String,
    pub can_write: bool,
    pub carrier_digest: ContentDigest,
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

/// Single-statement recursive CTE fetching Space, note, purge fence, folder
/// ancestry (with lock aggregation) and room session lease in one atomic cut.
/// SQLite uses `?1`/`?2` numbered placeholders because `$N` in SQLite is a
/// named parameter indexed by order of first appearance.
macro_rules! room_facts_cte {
    ($p1:literal, $p2:literal) => {
        concat!(
            "WITH RECURSIVE
  base AS (
    SELECT
      s.history_incarnation,
      s.space_kind,
      s.lifecycle_state AS space_lifecycle,
      n.parent_folder_id,
      n.slug,
      n.doc_class,
      n.ability_id,
      n.head_rev_id,
      n.content_blake3,
      n.lifecycle_state AS note_lifecycle,
      CASE WHEN EXISTS(
        SELECT 1 FROM revision_purge_fences pf
        WHERE pf.space_id = s.space_id AND pf.note_id = ", $p2, "
      ) THEN 1 ELSE 0 END AS purge_fenced,
      c.lease_epoch,
      c.lineage_epoch,
      c.room_state,
      c.owner_id AS room_owner
    FROM spaces s
    LEFT JOIN note_heads n
      ON n.space_id = s.space_id AND n.note_id = ", $p2, "
    LEFT JOIN collab_sessions c
      ON c.space_id = s.space_id AND c.note_id = ", $p2, "
    WHERE s.space_id = ", $p1, "
  ),
  anc(depth, folder_id, parent_folder_id, is_root, lifecycle_state, write_lock_json) AS (
    SELECT 0, f.folder_id, f.parent_folder_id, f.is_root, f.lifecycle_state, f.write_lock_json
    FROM base b
    JOIN folder_heads f
      ON f.space_id = ", $p1, " AND f.folder_id = b.parent_folder_id
    WHERE b.parent_folder_id IS NOT NULL
    UNION ALL
    SELECT a.depth + 1, f.folder_id, f.parent_folder_id, f.is_root, f.lifecycle_state, f.write_lock_json
    FROM anc a
    JOIN folder_heads f
      ON f.space_id = ", $p1, " AND f.folder_id = a.parent_folder_id
    WHERE a.is_root = 0 AND a.parent_folder_id IS NOT NULL AND a.depth < 257
  )
SELECT
  b.history_incarnation,
  b.space_kind,
  b.space_lifecycle,
  b.slug,
  b.doc_class,
  b.ability_id,
  b.head_rev_id,
  b.content_blake3,
  b.note_lifecycle,
  b.purge_fenced,
  b.lease_epoch,
  b.lineage_epoch,
  b.room_state,
  b.room_owner,
  a.depth,
  a.folder_id,
  a.is_root,
  a.lifecycle_state AS folder_lifecycle,
  a.write_lock_json
FROM base b
LEFT JOIN anc a ON 1 = 1
ORDER BY a.depth ASC"
        )
    };
}

const ROOM_FACTS_CTE_SQLITE: &str = room_facts_cte!("?1", "?2");
const ROOM_FACTS_CTE_PG: &str = room_facts_cte!("$1", "$2");

pub(super) struct RawRoomFactsRow {
    incarnation: Vec<u8>,
    space_kind: String,
    space_lifecycle: String,
    slug: Option<String>,
    doc_class: Option<String>,
    ability_id: Option<String>,
    head_rev_id: Option<String>,
    content_blake3: Option<Vec<u8>>,
    note_lifecycle: Option<String>,
    purge_fenced: i32,
    lease_epoch: Option<i64>,
    lineage_epoch: Option<i64>,
    room_state: Option<String>,
    room_owner: Option<String>,
    depth: Option<i32>,
    folder_id: Option<String>,
    is_root: Option<i32>,
    folder_lifecycle: Option<String>,
    write_lock_json: Option<String>,
}

pub(super) struct ActiveRoomExpectation<'a> {
    lease: LeaseEpoch,
    lineage: LineageEpoch,
    owner: &'a str,
}

pub(super) fn decode_room_facts_rows(
    scope: &HistoryScope,
    rows: Vec<RawRoomFactsRow>,
    expected_room: Option<ActiveRoomExpectation<'_>>,
) -> Result<ActiveRoomFacts, PortError> {
    let Some(first) = rows.first() else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let inc_arr: [u8; 16] =
        first.incarnation.as_slice().try_into().map_err(|_| {
            internal_not_committed("corrupt_incarnation", "incarnation not 16 bytes")
        })?;
    let current_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(inc_arr),
    };
    current_scope.check(scope)?;

    let space_kind = match first.space_kind.as_str() {
        "personal" => SpaceKind::Personal,
        "shared" => SpaceKind::Shared,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_kind",
                format!("unexpected space_kind '{other}'"),
            ));
        }
    };
    let space_lifecycle = match first.space_lifecycle.as_str() {
        "active" => SpaceLifecycle::Active,
        "closing" => SpaceLifecycle::Closing,
        "archived" => SpaceLifecycle::Archived,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_lifecycle",
                format!("unexpected space lifecycle '{other}'"),
            ));
        }
    };
    let space = Space {
        id: scope.space_id.clone(),
        kind: space_kind,
        lifecycle: space_lifecycle,
    };

    if space.lifecycle != SpaceLifecycle::Active || first.purge_fenced != 0 {
        return Err(DomainError::ResourceNotFound.into());
    }
    let Some(note_lc_raw) = first.note_lifecycle.as_deref() else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if lifecycle_from_db(note_lc_raw)? != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let doc_class = doc_class_from_db(first.doc_class.as_deref().ok_or_else(|| {
        internal_not_committed("corrupt_note_class", "active note lacks doc_class")
    })?)?;
    let head_rev_id = RevisionId::parse(first.head_rev_id.as_deref().ok_or_else(|| {
        internal_not_committed("corrupt_note_rev", "active note lacks head_rev_id")
    })?)
    .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
    let slug = first
        .slug
        .clone()
        .ok_or_else(|| internal_not_committed("corrupt_note_slug", "active note lacks slug"))?;
    let ability_package = first
        .ability_id
        .as_deref()
        .map(|raw| {
            AbilityId::parse(raw)
                .map_err(|_| internal_not_committed("corrupt_ability_id", "invalid ability_id"))
        })
        .transpose()?;
    let content_digest = match first.content_blake3.as_deref() {
        Some(bytes) => {
            let arr: [u8; 32] = bytes.try_into().map_err(|_| {
                internal_not_committed("corrupt_note_digest", "content_blake3 not 32 bytes")
            })?;
            ContentDigest::from_bytes(arr)
        }
        None => {
            return Err(internal_not_committed(
                "collab_missing_carrier",
                "active note lacks content_blake3",
            ));
        }
    };

    let mut ancestors = Vec::with_capacity(rows.len());
    let mut visited = BTreeSet::new();
    let mut write_locked = false;
    let mut reached_root = false;
    for row in &rows {
        let Some(folder_raw) = row.folder_id.as_deref() else {
            return Err(DomainError::ResourceNotFound.into());
        };
        let depth = row.depth.unwrap_or(0);
        if depth as usize > MAX_FOLDER_DEPTH {
            return Err(internal_not_committed(
                "folder_depth_exceeded",
                "folder tree exceeded MAX_FOLDER_DEPTH",
            ));
        }
        let folder_id = FolderId::parse(folder_raw)
            .map_err(|_| internal_not_committed("corrupt_folder_id", "invalid folder_id"))?;
        if !visited.insert(folder_id.clone()) {
            return Err(internal_not_committed(
                "folder_cycle_detected",
                "corrupt cycle in folder_heads",
            ));
        }
        let folder_lc = lifecycle_from_db(row.folder_lifecycle.as_deref().ok_or_else(|| {
            internal_not_committed("corrupt_folder_lc", "folder lacks lifecycle_state")
        })?)?;
        if folder_lc != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if row.write_lock_json.is_some() {
            write_locked = true;
        }
        ancestors.push(folder_id);
        if row.is_root.unwrap_or(0) != 0 {
            reached_root = true;
            break;
        }
    }
    if !reached_root {
        return Err(internal_not_committed(
            "non_root_missing_parent",
            "folder ancestry terminated without reaching Space root",
        ));
    }

    if let Some(expected) = expected_room {
        let Some(state_raw) = first.room_state.as_deref() else {
            return Err(DomainError::ResourceNotFound.into());
        };
        if CollabRoomState::from_db(state_raw)? != CollabRoomState::Active {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let lease_ok = first.lease_epoch == Some(expected.lease.get() as i64)
            && first.room_owner.as_deref() == Some(expected.owner);
        if !lease_ok {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        if first.lineage_epoch != Some(expected.lineage.get() as i64) {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        if doc_class != DocClass::UserDoc {
            return Err(DomainError::ResourceNotFound.into());
        }
    }

    Ok(ActiveRoomFacts {
        resource: ResourceFacts {
            space,
            class: doc_class,
            ancestor_folders: ancestors,
            folder_write_locked: write_locked,
            ability_package,
        },
        head_rev_id,
        slug,
        content_digest,
    })
}

fn query_room_facts_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note: &NoteId,
) -> Result<Vec<RawRoomFactsRow>, PortError> {
    let mut stmt = conn
        .prepare_cached(ROOM_FACTS_CTE_SQLITE)
        .map_err(|err| internal_not_committed("sqlite_room_facts_prep", err.to_string()))?;
    let mut rows_iter = stmt
        .query(params![space_id.as_str(), note.as_str()])
        .map_err(|err| internal_not_committed("sqlite_room_facts_query", err.to_string()))?;
    let mut out = Vec::new();
    while let Some(r) = rows_iter
        .next()
        .map_err(|err| internal_not_committed("sqlite_room_facts_next", err.to_string()))?
    {
        out.push(RawRoomFactsRow {
            incarnation: r
                .get(0)
                .map_err(|e| internal_not_committed("sqlite_rf_0", e.to_string()))?,
            space_kind: r
                .get(1)
                .map_err(|e| internal_not_committed("sqlite_rf_1", e.to_string()))?,
            space_lifecycle: r
                .get(2)
                .map_err(|e| internal_not_committed("sqlite_rf_2", e.to_string()))?,
            slug: r
                .get(3)
                .map_err(|e| internal_not_committed("sqlite_rf_3", e.to_string()))?,
            doc_class: r
                .get(4)
                .map_err(|e| internal_not_committed("sqlite_rf_4", e.to_string()))?,
            ability_id: r
                .get(5)
                .map_err(|e| internal_not_committed("sqlite_rf_5", e.to_string()))?,
            head_rev_id: r
                .get(6)
                .map_err(|e| internal_not_committed("sqlite_rf_6", e.to_string()))?,
            content_blake3: r
                .get(7)
                .map_err(|e| internal_not_committed("sqlite_rf_7", e.to_string()))?,
            note_lifecycle: r
                .get(8)
                .map_err(|e| internal_not_committed("sqlite_rf_8", e.to_string()))?,
            purge_fenced: r
                .get(9)
                .map_err(|e| internal_not_committed("sqlite_rf_9", e.to_string()))?,
            lease_epoch: r
                .get(10)
                .map_err(|e| internal_not_committed("sqlite_rf_10", e.to_string()))?,
            lineage_epoch: r
                .get(11)
                .map_err(|e| internal_not_committed("sqlite_rf_11", e.to_string()))?,
            room_state: r
                .get(12)
                .map_err(|e| internal_not_committed("sqlite_rf_12", e.to_string()))?,
            room_owner: r
                .get(13)
                .map_err(|e| internal_not_committed("sqlite_rf_13", e.to_string()))?,
            depth: r
                .get(14)
                .map_err(|e| internal_not_committed("sqlite_rf_14", e.to_string()))?,
            folder_id: r
                .get(15)
                .map_err(|e| internal_not_committed("sqlite_rf_15", e.to_string()))?,
            is_root: r
                .get(16)
                .map_err(|e| internal_not_committed("sqlite_rf_16", e.to_string()))?,
            folder_lifecycle: r
                .get(17)
                .map_err(|e| internal_not_committed("sqlite_rf_17", e.to_string()))?,
            write_lock_json: r
                .get(18)
                .map_err(|e| internal_not_committed("sqlite_rf_18", e.to_string()))?,
        });
    }
    Ok(out)
}

pub(super) async fn query_room_facts_pg(
    conn: &mut sqlx::PgConnection,
    space_id: &SpaceId,
    note: &NoteId,
) -> Result<Vec<RawRoomFactsRow>, PortError> {
    let rows = sqlx::query(ROOM_FACTS_CTE_PG)
        .bind(space_id.as_str())
        .bind(note.as_str())
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| pg_read_error("pg_room_facts", err))?;
    rows.into_iter()
        .map(|r| {
            let map_col =
                |col: &'static str, err: sqlx::Error| internal_not_committed(col, err.to_string());
            Ok(RawRoomFactsRow {
                incarnation: r
                    .try_get("history_incarnation")
                    .map_err(|e| map_col("pg_rf_incarnation", e))?,
                space_kind: r
                    .try_get("space_kind")
                    .map_err(|e| map_col("pg_rf_space_kind", e))?,
                space_lifecycle: r
                    .try_get("space_lifecycle")
                    .map_err(|e| map_col("pg_rf_space_lifecycle", e))?,
                slug: r.try_get("slug").map_err(|e| map_col("pg_rf_slug", e))?,
                doc_class: r
                    .try_get("doc_class")
                    .map_err(|e| map_col("pg_rf_doc_class", e))?,
                ability_id: r
                    .try_get("ability_id")
                    .map_err(|e| map_col("pg_rf_ability_id", e))?,
                head_rev_id: r
                    .try_get("head_rev_id")
                    .map_err(|e| map_col("pg_rf_head_rev_id", e))?,
                content_blake3: r
                    .try_get("content_blake3")
                    .map_err(|e| map_col("pg_rf_content_blake3", e))?,
                note_lifecycle: r
                    .try_get("note_lifecycle")
                    .map_err(|e| map_col("pg_rf_note_lifecycle", e))?,
                purge_fenced: r
                    .try_get("purge_fenced")
                    .map_err(|e| map_col("pg_rf_purge_fenced", e))?,
                lease_epoch: r
                    .try_get("lease_epoch")
                    .map_err(|e| map_col("pg_rf_lease_epoch", e))?,
                lineage_epoch: r
                    .try_get("lineage_epoch")
                    .map_err(|e| map_col("pg_rf_lineage_epoch", e))?,
                room_state: r
                    .try_get("room_state")
                    .map_err(|e| map_col("pg_rf_room_state", e))?,
                room_owner: r
                    .try_get("room_owner")
                    .map_err(|e| map_col("pg_rf_room_owner", e))?,
                depth: r.try_get("depth").map_err(|e| map_col("pg_rf_depth", e))?,
                folder_id: r
                    .try_get("folder_id")
                    .map_err(|e| map_col("pg_rf_folder_id", e))?,
                is_root: r
                    .try_get("is_root")
                    .map_err(|e| map_col("pg_rf_is_root", e))?,
                folder_lifecycle: r
                    .try_get("folder_lifecycle")
                    .map_err(|e| map_col("pg_rf_folder_lifecycle", e))?,
                write_lock_json: r
                    .try_get("write_lock_json")
                    .map_err(|e| map_col("pg_rf_write_lock_json", e))?,
            })
        })
        .collect()
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

    /// Reads note collaboration admission metadata without loading the carrier
    /// blob from CAS/S3. Call `load_collab_carrier` only when the carrier is
    /// actually needed (e.g. cold room open after checking lineage/fenced state).
    pub async fn read_note_collab_admission_meta(
        &self,
        ctx: &SpaceContext,
        note: &NoteId,
        verify_base_rev: Option<&RevisionId>,
    ) -> Result<NoteCollabAdmissionMeta, PortError> {
        read_note_collab_admission_meta(self, ctx, note, verify_base_rev).await
    }

    /// Loads and UTF-8-decodes a verified collaboration carrier blob by digest.
    pub async fn load_collab_carrier(
        &self,
        scope: &HistoryScope,
        digest: ContentDigest,
        budget: Option<&CallBudget>,
    ) -> Result<String, PortError> {
        let bytes = self
            .read_verified_blob_with_budget(scope, digest, budget)
            .await?;
        String::from_utf8(bytes).map_err(|err| {
            internal_not_committed("collab_carrier_utf8", err.utf8_error().to_string())
        })
    }

    /// Reads the current history identifier for a trusted composition caller.
    pub async fn read_current_history_scope(
        &self,
        budget: Option<&CallBudget>,
        space: &SpaceId,
    ) -> Result<HistoryScope, PortError> {
        Ok(self.read_space_fast_or_pool(space, budget).await?.scope)
    }

    /// Reads fresh ancestry and authority facts in a single SQL cut without
    /// fetching carrier or CRDT payloads.
    pub async fn read_room_resource_facts(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<ResourceFacts, PortError> {
        self.read_room_facts_inner(budget, scope, note, None)
            .await
            .map(|facts| facts.resource)
    }

    /// Reads current note metadata and facts only while this owner still holds
    /// the requested collaboration lease and lineage, using a single SQL cut.
    pub async fn read_active_room_facts(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
        expected_lease: LeaseEpoch,
        expected_lineage: LineageEpoch,
        owner_id: &str,
    ) -> Result<ActiveRoomFacts, PortError> {
        self.read_room_facts_inner(
            budget,
            scope,
            note,
            Some((expected_lease, expected_lineage, owner_id.to_owned())),
        )
        .await
    }

    async fn read_room_facts_inner(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
        expected: Option<(LeaseEpoch, LineageEpoch, String)>,
    ) -> Result<ActiveRoomFacts, PortError> {
        if let SqlDriverState::Sqlite { fast_read_pool, .. } = &self.inner.sql {
            self.ensure_open()?;
            let wal = self.inner.wal_coord.get().ok_or_else(|| {
                internal_not_committed(
                    "sqlite_wal_coord_missing",
                    "SqliteWalCoordinator not initialized",
                )
            })?;
            let scope = scope.clone();
            let note = note.clone();
            return fast_read_pool
                .with_read_conn(wal, budget, move |conn| {
                    let rows = query_room_facts_rusqlite(conn, &scope.space_id, &note)?;
                    let expectation =
                        expected
                            .as_ref()
                            .map(|(lease, lineage, owner)| ActiveRoomExpectation {
                                lease: *lease,
                                lineage: *lineage,
                                owner: owner.as_str(),
                            });
                    decode_room_facts_rows(&scope, rows, expectation)
                })
                .await;
        }
        let scope = scope.clone();
        let note = note.clone();
        let rows = self
            .with_pg_single_read_stmt(budget, |conn| {
                let space_id = scope.space_id.clone();
                let note = note.clone();
                Box::pin(async move { query_room_facts_pg(conn, &space_id, &note).await })
            })
            .await?;
        let expectation = expected
            .as_ref()
            .map(|(lease, lineage, owner)| ActiveRoomExpectation {
                lease: *lease,
                lineage: *lineage,
                owner: owner.as_str(),
            });
        decode_room_facts_rows(&scope, rows, expectation)
    }

    /// Reads `(slug, lease_epoch)` when `collab_sessions` currently holds an
    /// active lease for `note` in `scope`, regardless of which node owns it.
    pub async fn read_active_room_pin_info(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<Option<(String, LeaseEpoch)>, PortError> {
        const SQL: &str = "SELECT n.slug, c.lease_epoch
            FROM collab_sessions c
            JOIN note_heads n
              ON n.space_id = c.space_id AND n.note_id = c.note_id
            WHERE c.space_id = $1 AND c.note_id = $2 AND c.room_state = 'active'";
        let scope = scope.clone();
        let note = note.clone();
        self.with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                let row: Option<(String, i64)> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(note.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("collab_read_active_pin", err.to_string())
                        })?,
                    BackendConn::Postgres(conn) => sqlx::query_as(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(note.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| pg_read_error("pg_collab_read_active_pin", err))?,
                };
                row.map(|(slug, lease)| {
                    let lease = u64::try_from(lease).map_err(|err| {
                        internal_not_committed("collab_active_pin_lease", err.to_string())
                    })?;
                    Ok((slug, LeaseEpoch::new(lease)?))
                })
                .transpose()
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
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(&owner_id)
                        .bind(i64::from(limit))
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("collab_list_owned_rooms", err.to_string())
                        })?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(SQL)
                        .bind(scope.space_id.as_str())
                        .bind(&owner_id)
                        .bind(i64::from(limit))
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| pg_read_error("pg_collab_list_owned_rooms", err))?,
                };
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
                    let (head, _) = load_room_note_facts_tx(tx, &srec.space, &note, false).await?;
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
    require_active_folders: bool,
) -> Result<(NoteHeadRow, ResourceFacts), PortError> {
    if space.lifecycle != SpaceLifecycle::Active
        || is_note_purge_fenced_tx(tx, &space.id, note.as_str()).await?
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    load_room_note_facts_after_purge_tx(tx, space, note, require_active_folders).await
}

/// Loads active note head and folder ancestry when purge fence has already been
/// verified by the batch writer.
pub(super) async fn load_room_note_facts_after_purge_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    note: &NoteId,
    require_active_folders: bool,
) -> Result<(NoteHeadRow, ResourceFacts), PortError> {
    if space.lifecycle != SpaceLifecycle::Active {
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
        require_active_folders,
    )
    .await?;
    Ok((head, facts))
}

async fn read_note_collab_admission_meta(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    verify_base_rev: Option<&RevisionId>,
) -> Result<NoteCollabAdmissionMeta, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let note = note.clone();
    let base = verify_base_rev.cloned();
    let (head, can_write, session, verified_base_rev_id) = store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                let (head, facts) = load_room_note_facts_tx(tx, &srec.space, &note, true).await?;
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
    let carrier_digest = note_carrier_digest(&head)?;
    Ok(NoteCollabAdmissionMeta {
        scope: ctx.scope().clone(),
        head_rev_id: head.head_rev_id,
        doc_class: head.doc_class,
        slug: head.slug,
        can_write,
        carrier_digest,
        session,
        verified_base_rev_id,
    })
}

async fn read_note_collab_admission(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    verify_base_rev: Option<&RevisionId>,
) -> Result<NoteCollabAdmission, PortError> {
    let deadline = CommandDeadline::start(&ctx.budget, "collab_admission");
    let meta = read_note_collab_admission_meta(store, ctx, note, verify_base_rev).await?;
    let mut blob_budget = ctx.budget.clone();
    blob_budget.remaining = deadline.remaining(&ctx.budget)?;
    let carrier = store
        .load_collab_carrier(&meta.scope, meta.carrier_digest, Some(&blob_budget))
        .await?;
    Ok(NoteCollabAdmission {
        scope: meta.scope,
        head_rev_id: meta.head_rev_id,
        doc_class: meta.doc_class,
        slug: meta.slug,
        can_write: meta.can_write,
        carrier,
        session: meta.session,
        verified_base_rev_id: meta.verified_base_rev_id,
    })
}

async fn collab_base_revision_exists_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    base: &RevisionId,
) -> Result<bool, PortError> {
    const SQL: &str = "SELECT EXISTS(SELECT 1 FROM revisions
        WHERE space_id = $1 AND rev_id = $2 AND entity_type = 'note' AND entity_key = $3
          AND history_incarnation = $4)";
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(SQL)
            .bind(scope.space_id.as_str())
            .bind(base.as_str())
            .bind(note.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("collab_verify_base_revision", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_scalar(SQL)
            .bind(scope.space_id.as_str())
            .bind(base.as_str())
            .bind(note.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_collab_verify_base_revision", err)),
    }
}

pub(crate) async fn list_fenced_collab_leases_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    limit: i64,
) -> Result<Vec<(NoteId, LeaseEpoch)>, PortError> {
    const SQL: &str = "SELECT note_id, lease_epoch FROM collab_sessions
        WHERE space_id = $1 AND room_state = 'fenced' ORDER BY note_id LIMIT $2";
    let notes: Vec<(String, i64)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("collab_list_fenced_notes", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(space.as_str())
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| pg_read_error("pg_collab_list_fenced_notes", err))?,
    };
    notes
        .into_iter()
        .map(|(note, epoch)| {
            let note = NoteId::parse(&note)
                .map_err(|err| internal_not_committed("collab_fenced_note_id", err.to_string()))?;
            let epoch = LeaseEpoch::new(u64::try_from(epoch).map_err(|err| {
                internal_not_committed("collab_fenced_lease_epoch", err.to_string())
            })?)?;
            Ok((note, epoch))
        })
        .collect()
}

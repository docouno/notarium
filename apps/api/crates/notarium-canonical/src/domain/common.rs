use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex as StdMutex},
};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind, ResourceFacts, Space},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, AgentRunId, ContentDigest, FolderId, LeaseEpoch, LineageEpoch, NoteId,
        PrincipalId, RevisionId, SpaceId, SpaceSeq,
    },
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        AbilityPackageRevision, BoardMoveResult, ClosedRoomReservation, Committed, GroupKey, Link,
        LinkTarget, MintAndPurgeResult, NoteRevision, Preconditions, RestoredBoardRank,
        RollbackReservation, RollbackResult, RoomFenceState, SpaceContext,
    },
    query::FieldSchema,
    receipt::{CommandIdentity, MutationReceiptToken},
    value::{Timestamp, YamlValue},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::Mutex;

use crate::{
    codec::{
        AgentRunRevisionMetadata, MAX_MSGPACK_DECODE_BYTES, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, decode_timestamp_parts, doc_class_from_db,
        encode_msgpack, encode_timestamp_parts, i64_to_space_seq, internal_not_committed,
        lifecycle_from_db, new_revision_id,
    },
    runtime::{insert_revision_row, load_folder_head_row},
    sql_exec::BackendConn,
    writer::CommandIdentitySpec,
};

#[derive(Clone, Copy)]
pub(crate) struct CommandDeadline {
    pub(crate) at: tokio::time::Instant,
    operation: &'static str,
}

impl CommandDeadline {
    pub(crate) fn start(
        budget: &notarium_core::ports::CallBudget,
        operation: &'static str,
    ) -> Self {
        let at = crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining);
        Self { at, operation }
    }

    pub(super) fn at(at: tokio::time::Instant, operation: &'static str) -> Self {
        Self { at, operation }
    }

    fn cancelled(&self) -> PortError {
        crate::codec::cancelled_not_committed(
            &format!("{}_cancelled", self.operation),
            format!("{} cancelled before commit", self.operation),
        )
    }

    fn expired(&self) -> PortError {
        crate::codec::deadline_not_committed(
            &format!("{}_deadline", self.operation),
            format!("{} deadline expired before commit", self.operation),
        )
    }

    pub(crate) fn remaining(
        &self,
        budget: &notarium_core::ports::CallBudget,
    ) -> Result<std::time::Duration, PortError> {
        if budget.cancellation.is_cancelled() {
            return Err(self.cancelled());
        }
        let remaining = self
            .at
            .saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(self.expired());
        }
        Ok(remaining)
    }

    /// Bounds read-only work or preparation whose mutation has not been admitted.
    pub(crate) async fn prepare<T, F: Future<Output = Result<T, PortError>>>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        operation: impl FnOnce() -> F,
    ) -> Result<T, PortError> {
        let result = self.wait(budget, operation).await?;
        self.remaining(budget)?;
        result
    }

    /// Restart a read-only command phase once if its short snapshot expires.
    /// Both attempts must fit the command's original deadline.
    pub(crate) async fn prepare_read<T, F: Future<Output = Result<T, PortError>>>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        mut read: impl FnMut() -> F,
    ) -> Result<T, PortError> {
        let first = self.prepare(budget, &mut read).await;
        if matches!(first, Err(PortError::DeadlineExceeded(_))) {
            return self.prepare(budget, read).await;
        }
        first
    }

    pub(crate) async fn submit<T: Serialize + serde::de::DeserializeOwned + Send + 'static>(
        &self,
        store: &crate::CanonicalStore,
        budget: &notarium_core::ports::CallBudget,
        intent: crate::writer::PreparedWriteIntent,
    ) -> Result<T, PortError> {
        store
            .submit_write_command_until(budget, self.at, intent, None, None, None)
            .await
    }

    pub(crate) async fn wait<F: Future>(
        &self,
        budget: &notarium_core::ports::CallBudget,
        operation: impl FnOnce() -> F,
    ) -> Result<F::Output, PortError> {
        self.remaining(budget)?;
        tokio::select! {
            biased;
            _ = budget.cancellation.cancelled() => Err(self.cancelled()),
            _ = tokio::time::sleep_until(self.at) => Err(self.expired()),
            result = operation() => Ok(result),
        }
    }
}

pub const MAX_FOLDER_DEPTH: usize = 256;

pub(crate) fn persisted_room_fence(
    note: NoteId,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    active: bool,
) -> Result<RoomFenceState, PortError> {
    if !active {
        return Ok(RoomFenceState::new(note, scope, epoch));
    }
    let base = LeaseEpoch::new(epoch.get().saturating_sub(1))?;
    let mut state = RoomFenceState::new(note, scope, base);
    state.open()?;
    Ok(state)
}

type RoomFenceMap = HashMap<(SpaceId, NoteId), Arc<Mutex<RoomFenceState>>>;

/// Runtime-owned table of per-`(SpaceId, NoteId)` room fences (`tokio::sync::Mutex<RoomFenceState>`).
#[derive(Default)]
pub struct RoomFenceTable {
    fences: StdMutex<RoomFenceMap>,
}

impl std::fmt::Debug for RoomFenceTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = self.fences.lock().map(|m| m.len()).unwrap_or(0);
        f.debug_struct("RoomFenceTable")
            .field("entry_count", &len)
            .finish()
    }
}

impl RoomFenceTable {
    pub fn get_or_init(&self, scope: &HistoryScope, note: &NoteId) -> Arc<Mutex<RoomFenceState>> {
        let mut map = self.fences.lock().expect("room fence table mutex");
        Arc::clone(
            map.entry((scope.space_id.clone(), note.clone()))
                .or_insert_with(|| {
                    Arc::new(Mutex::new(RoomFenceState::new(
                        note.clone(),
                        scope.clone(),
                        LeaseEpoch::ZERO,
                    )))
                }),
        )
    }

    pub async fn open_room(&self, scope: &HistoryScope, note: &NoteId) -> Result<(), PortError> {
        let lock = self.get_or_init(scope, note);
        let mut guard = lock.lock().await;
        guard.open().map_err(PortError::from)
    }

    pub async fn close_room(&self, scope: &HistoryScope, note: &NoteId) -> Result<(), PortError> {
        let lock = self.get_or_init(scope, note);
        let mut guard = lock.lock().await;
        guard.close().map_err(PortError::from)
    }

    pub async fn reserve_rollback(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: CommandIdentity,
    ) -> Result<RollbackReservation, PortError> {
        let lock = self.get_or_init(scope, note);
        let guard = lock.lock().await;
        guard.reserve(identity).map_err(PortError::from)
    }

    pub async fn is_room_active(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let mut map_opt = None;
        {
            let map = self.fences.lock().expect("room fence table mutex");
            if let Some(existing) = map.get(&(scope.space_id.clone(), note.clone())) {
                map_opt = Some(Arc::clone(existing));
            }
        }
        let Some(lock) = map_opt else {
            return Ok(false);
        };
        let probe_id = CommandIdentity {
            scope: scope.clone(),
            actor: PrincipalId::from_bytes([0u8; 16]),
            key: notarium_core::ids::CommandKey::from_bytes([0u8; 16]),
            hash: ContentDigest::from_bytes([0u8; 32]),
        };
        let guard = lock.try_lock().map_err(|_| Self::busy_fence())?;
        match guard.reserve(probe_id) {
            Ok(RollbackReservation::SkippedRoomActive) => Ok(true),
            Ok(RollbackReservation::Closed(_)) => Ok(false),
            Err(err) => Err(err.into()),
        }
    }

    /// Synchronous equivalent of `is_room_active` for `spawn_blocking` SQLite fast-path workers.
    pub fn is_room_active_blocking(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<bool, PortError> {
        let map_opt = {
            let map = self.fences.lock().expect("room fence table mutex");
            map.get(&(scope.space_id.clone(), note.clone())).cloned()
        };
        let Some(lock) = map_opt else {
            return Ok(false);
        };
        let probe_id = CommandIdentity {
            scope: scope.clone(),
            actor: PrincipalId::from_bytes([0u8; 16]),
            key: notarium_core::ids::CommandKey::from_bytes([0u8; 16]),
            hash: ContentDigest::from_bytes([0u8; 32]),
        };
        let guard = lock.try_lock().map_err(|_| Self::busy_fence())?;
        match guard.reserve(probe_id) {
            Ok(RollbackReservation::SkippedRoomActive) => Ok(true),
            Ok(RollbackReservation::Closed(_)) => Ok(false),
            Err(err) => Err(err.into()),
        }
    }

    pub fn remove_note(&self, space_id: &SpaceId, note: &NoteId) {
        let mut map = self.fences.lock().expect("room fence table mutex");
        map.remove(&(space_id.clone(), note.clone()));
    }

    pub fn remove_space(&self, space_id: &SpaceId) {
        let mut map = self.fences.lock().expect("room fence table mutex");
        map.retain(|(sid, _), _| sid != space_id);
    }

    pub(crate) fn replace_restored_spaces(
        &self,
        spaces: &BTreeSet<&SpaceId>,
        restored: RoomFenceTable,
    ) {
        let mut fences = self.fences.lock().expect("room fence table mutex");
        fences.retain(|(id, _), _| !spaces.contains(id));
        fences.extend(
            restored
                .fences
                .into_inner()
                .expect("restored room fence table"),
        );
    }

    /// Writer transactions must never wait for a room guard retained by an earlier
    /// item in their own batch. A busy fence can be retried after the batch commits.
    pub(crate) fn lock_for_write(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        self.get_or_init(scope, note)
            .try_lock_owned()
            .map_err(|_| Self::busy_fence())
    }

    fn busy_fence() -> PortError {
        crate::codec::unavailable_retryable(
            "collab_fence_busy",
            "another operation holds the room fence",
            std::time::Duration::from_millis(5),
        )
    }

    pub async fn consume_reservation(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        reservation: ClosedRoomReservation,
        identity: &CommandIdentity,
    ) -> Result<tokio::sync::OwnedMutexGuard<RoomFenceState>, PortError> {
        let mut guard = self.lock_for_write(scope, note)?;
        guard.consume(reservation, identity)?;
        Ok(guard)
    }

    /// Locks the per-note fence in ascending order and reserves a closed-room permit without mutating
    /// the fence epoch until all pre-write validations pass and `guard.consume(...)` is invoked.
    pub async fn try_lock_closed_for_rollback(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Result<
        Option<(
            tokio::sync::OwnedMutexGuard<RoomFenceState>,
            ClosedRoomReservation,
        )>,
        PortError,
    > {
        let guard = self.lock_for_write(scope, note)?;
        match guard.reserve(identity.clone())? {
            RollbackReservation::SkippedRoomActive => Ok(None),
            RollbackReservation::Closed(res) => Ok(Some((guard, res))),
        }
    }

    /// Synchronous equivalent of `try_lock_closed_for_rollback` for `spawn_blocking` SQLite fast-path workers.
    pub fn try_lock_closed_for_rollback_blocking(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        identity: &CommandIdentity,
    ) -> Result<
        Option<(
            tokio::sync::OwnedMutexGuard<RoomFenceState>,
            ClosedRoomReservation,
        )>,
        PortError,
    > {
        let guard = self.lock_for_write(scope, note)?;
        match guard.reserve(identity.clone())? {
            RollbackReservation::SkippedRoomActive => Ok(None),
            RollbackReservation::Closed(res) => Ok(Some((guard, res))),
        }
    }

    /// Non-blocking batch lock + reservation in ascending `NoteId` order using a single map critical section.
    /// Returns `Ok(None)` on any per-note mutex contention so the caller can fall back to async locking.
    #[allow(clippy::type_complexity)]
    pub fn try_lock_batch_for_rollback_sync(
        &self,
        scope: &HistoryScope,
        sorted_notes: &[&NoteId],
        identity: &CommandIdentity,
    ) -> Result<
        Option<
            Vec<
                Option<(
                    tokio::sync::OwnedMutexGuard<RoomFenceState>,
                    ClosedRoomReservation,
                )>,
            >,
        >,
        PortError,
    > {
        let mut locks = Vec::with_capacity(sorted_notes.len());
        {
            let mut map = self.fences.lock().expect("room fence table mutex");
            for &note in sorted_notes {
                let arc = Arc::clone(
                    map.entry((scope.space_id.clone(), note.clone()))
                        .or_insert_with(|| {
                            Arc::new(Mutex::new(RoomFenceState::new(
                                note.clone(),
                                scope.clone(),
                                LeaseEpoch::ZERO,
                            )))
                        }),
                );
                locks.push(arc);
            }
        }

        let mut out = Vec::with_capacity(locks.len());
        for lock in locks {
            let Ok(guard) = lock.try_lock_owned() else {
                return Ok(None);
            };
            match guard.reserve(identity.clone())? {
                RollbackReservation::SkippedRoomActive => out.push(None),
                RollbackReservation::Closed(res) => out.push(Some((guard, res))),
            }
        }
        Ok(Some(out))
    }

    pub async fn seed_persisted_room(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
        epoch: LeaseEpoch,
        active: bool,
    ) -> Result<(), PortError> {
        let state = persisted_room_fence(note.clone(), scope.clone(), epoch, active)?;
        let existing = {
            let mut map = self.fences.lock().expect("room fence table mutex");
            match map.entry((scope.space_id.clone(), note.clone())) {
                std::collections::hash_map::Entry::Occupied(entry) => Arc::clone(entry.get()),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(Arc::new(Mutex::new(state)));
                    return Ok(());
                }
            }
        };
        *existing.lock().await = state;
        Ok(())
    }
}

/// Atomic canonical Space field schema update input.
#[derive(Clone, Debug)]
pub struct UpdateSpaceSchema {
    pub schema_note: NoteId,
    pub parent: Option<FolderId>,
    pub slug: String,
    pub carrier: String,
    pub schema: BTreeMap<String, FieldSchema>,
    pub expected_schema_revision: Option<RevisionId>,
}

/// Committed Space field schema revision summary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpaceSchemaRevision {
    pub schema_revision: RevisionId,
    pub schema_note: NoteId,
    pub note_revision: RevisionId,
    pub descriptor_fingerprint: ContentDigest,
}

pub(crate) fn validate_mutation_identity(
    ctx: &SpaceContext,
    identity: &CommandIdentity,
) -> Result<(), PortError> {
    ctx.scope().check(&identity.scope)?;
    if identity.actor != *ctx.auth().principal() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(())
}

/// These commands create an identity or carry their own typed predicates.
pub(crate) fn require_empty_preconditions(pre: &Preconditions) -> Result<(), PortError> {
    if pre != &Preconditions::default() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

/// Folders and chat threads have revisions, but do not own a collaborative note room.
pub(crate) fn require_revision_only(pre: &Preconditions) -> Result<(), PortError> {
    if pre.lease.is_some() || pre.lineage.is_some() {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    Ok(())
}

/// Derives a forged-hash-safe internal command hash binding `command_kind`, caller `identity.hash`,
/// and the canonicalized mutation input fingerprint. Even if two requests share a forged `identity.hash`
/// with the same `CommandKey`, distinct inputs produce distinct `CommandIdentitySpec.command_hash` values
/// and trigger `DomainError::IdempotencyKeyReused`.
pub(crate) fn derive_command_identity_spec(
    identity: &CommandIdentity,
    command_kind: &str,
    canonical_payload_fingerprint: &[u8],
) -> crate::writer::replay::UnboundCommand {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-cmd-v1:");
    hasher.update(command_kind.as_bytes());
    hasher.update(&[0]);
    hasher.update(identity.hash.as_bytes());
    hasher.update(&[0]);
    hasher.update(canonical_payload_fingerprint);
    crate::writer::replay::UnboundCommand(CommandIdentitySpec::new(
        identity.actor.clone(),
        identity.key.clone(),
        ContentDigest::from_bytes(*hasher.finalize().as_bytes()),
    ))
}

pub(crate) fn extract_agent_run_from_auth(auth: &EngineAuthContext) -> Option<AgentRunId> {
    match auth.kind() {
        PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => Some(run.clone()),
        PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. } => None,
    }
}

pub(crate) fn note_rank_version_digest(
    note_rev: &RevisionId,
    rank_extra: Option<&str>,
) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-overlay-row-v1:");
    hasher.update(note_rev.as_str().as_bytes());
    if let Some(extra) = rank_extra {
        hasher.update(&[0]);
        hasher.update(extra.as_bytes());
    }
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

pub(crate) fn schema_descriptor_bytes_and_fingerprint(
    schema: &BTreeMap<String, FieldSchema>,
) -> Result<(Vec<u8>, ContentDigest), PortError> {
    let bytes = encode_msgpack(schema)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-space-schema-v1:");
    hasher.update(&bytes);
    let fp = ContentDigest::from_bytes(*hasher.finalize().as_bytes());
    Ok((bytes, fp))
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct NoteHeadRow {
    pub note_id: NoteId,
    pub parent_folder_id: FolderId,
    pub slug: String,
    pub slug_fold: String,
    pub title: String,
    pub title_fold: String,
    pub doc_class: DocClass,
    pub ability_id: Option<AbilityId>,
    pub head_rev_id: RevisionId,
    pub content_digest: Option<ContentDigest>,
    pub byte_size: u64,
    pub lifecycle: Lifecycle,
    pub visibility_mask: i32,
    pub settlement_successor_id: Option<NoteId>,
    pub created_seq: SpaceSeq,
    pub updated_seq: SpaceSeq,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_actor_id: PrincipalId,
}

// Optional projections omit inaccessible or unavailable values. A cancelled or
// expired request must still interrupt the enclosing page, even in a last slot.
pub(super) fn optional_read<T>(result: Result<T, PortError>) -> Result<Option<T>, PortError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(err @ (PortError::DeadlineExceeded(_) | PortError::Cancelled(_))) => Err(err),
        Err(_) => Ok(None),
    }
}

#[allow(clippy::type_complexity)]
pub(crate) async fn load_note_head_row_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Option<NoteHeadRow>, PortError> {
    let raw: Option<(
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<Vec<u8>>,
        i64,
        String,
        i32,
        Option<String>,
        i64,
        i64,
        i64,
        i32,
        i64,
        i32,
        String,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                        ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                        visibility_mask, settlement_successor_id, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                 FROM note_heads WHERE space_id = ? AND note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_note_head", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("parent_folder_id"),
                    r.get("slug"),
                    r.get("slug_fold"),
                    r.get("title"),
                    r.get("title_fold"),
                    r.get("doc_class"),
                    r.get("ability_id"),
                    r.get("head_rev_id"),
                    r.get("content_blake3"),
                    r.get("byte_size"),
                    r.get("lifecycle_state"),
                    r.get::<i64, _>("visibility_mask") as i32,
                    r.get("settlement_successor_id"),
                    r.get("created_seq"),
                    r.get("updated_seq"),
                    r.get("created_at_sec"),
                    r.get::<i64, _>("created_at_nsec") as i32,
                    r.get("updated_at_sec"),
                    r.get::<i64, _>("updated_at_nsec") as i32,
                    r.get("last_actor_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                        ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                        visibility_mask, settlement_successor_id, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                 FROM note_heads WHERE space_id = $1 AND note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_note_head", err))?;
            row.map(|r| {
                (
                    r.get("parent_folder_id"),
                    r.get("slug"),
                    r.get("slug_fold"),
                    r.get("title"),
                    r.get("title_fold"),
                    r.get("doc_class"),
                    r.get("ability_id"),
                    r.get("head_rev_id"),
                    r.get("content_blake3"),
                    r.get("byte_size"),
                    r.get("lifecycle_state"),
                    r.get("visibility_mask"),
                    r.get("settlement_successor_id"),
                    r.get("created_seq"),
                    r.get("updated_seq"),
                    r.get("created_at_sec"),
                    r.get("created_at_nsec"),
                    r.get("updated_at_sec"),
                    r.get("updated_at_nsec"),
                    r.get("last_actor_id"),
                )
            })
        }
    };

    let Some((
        parent_raw,
        slug,
        slug_fold,
        title,
        title_fold,
        class_raw,
        ability_raw,
        head_rev_raw,
        digest_raw,
        byte_size_raw,
        lc_raw,
        visibility_mask,
        succ_raw,
        created_seq_raw,
        updated_seq_raw,
        c_sec,
        c_nsec,
        u_sec,
        u_nsec,
        actor_raw,
    )) = raw
    else {
        return Ok(None);
    };

    let parent_folder_id = FolderId::parse(&parent_raw)
        .map_err(|_| internal_not_committed("corrupt_note_parent", "invalid parent_folder_id"))?;
    let doc_class = doc_class_from_db(&class_raw)?;
    let ability_id = match ability_raw {
        Some(s) => Some(
            AbilityId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_ability_id", "invalid ability_id"))?,
        ),
        None => None,
    };
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
    let content_digest = match digest_raw {
        Some(b) => {
            let arr: [u8; 32] = b.try_into().map_err(|_| {
                internal_not_committed("corrupt_note_digest", "content_blake3 != 32B")
            })?;
            Some(ContentDigest::from_bytes(arr))
        }
        None => None,
    };
    let byte_size = u64::try_from(byte_size_raw)
        .map_err(|_| internal_not_committed("corrupt_byte_size", "negative byte_size"))?;
    let lifecycle = lifecycle_from_db(&lc_raw)?;
    let settlement_successor_id = match succ_raw {
        Some(s) => Some(
            NoteId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_successor_id", "invalid successor"))?,
        ),
        None => None,
    };
    let created_seq = i64_to_space_seq(created_seq_raw)?;
    let updated_seq = i64_to_space_seq(updated_seq_raw)?;
    let created_at = decode_timestamp_parts(c_sec, c_nsec)?;
    let updated_at = decode_timestamp_parts(u_sec, u_nsec)?;
    let last_actor_id = PrincipalId::parse(&actor_raw)
        .map_err(|_| internal_not_committed("corrupt_last_actor", "invalid last_actor_id"))?;

    Ok(Some(NoteHeadRow {
        note_id: note_id.clone(),
        parent_folder_id,
        slug,
        slug_fold,
        title,
        title_fold,
        doc_class,
        ability_id,
        head_rev_id,
        content_digest,
        byte_size,
        lifecycle,
        visibility_mask,
        settlement_successor_id,
        created_seq,
        updated_seq,
        created_at,
        updated_at,
        last_actor_id,
    }))
}

pub(crate) async fn load_note_head_row_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteHeadRow, PortError> {
    load_note_head_row_opt_tx(tx, space_id, note_id)
        .await?
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

#[allow(clippy::type_complexity)]
pub(crate) async fn load_note_heads_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_ids: &[NoteId],
) -> Result<BTreeMap<NoteId, NoteHeadRow>, PortError> {
    let mut out = BTreeMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    type RawBatchTuple = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<Vec<u8>>,
        i64,
        String,
        i32,
        Option<String>,
        i64,
        i64,
        i64,
        i32,
        i64,
        i32,
        String,
    );
    for chunk in note_ids.chunks(200) {
        let rows: Vec<RawBatchTuple> = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT note_id, parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                            ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                            visibility_mask, settlement_successor_id, created_seq, updated_seq,
                            created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                     FROM note_heads WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str()).push(" AND note_id IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(")");
                let fetched = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_load_note_heads_batch", err.to_string())
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("note_id"),
                            r.get("parent_folder_id"),
                            r.get("slug"),
                            r.get("slug_fold"),
                            r.get("title"),
                            r.get("title_fold"),
                            r.get("doc_class"),
                            r.get("ability_id"),
                            r.get("head_rev_id"),
                            r.get("content_blake3"),
                            r.get("byte_size"),
                            r.get("lifecycle_state"),
                            r.get::<i64, _>("visibility_mask") as i32,
                            r.get("settlement_successor_id"),
                            r.get("created_seq"),
                            r.get("updated_seq"),
                            r.get("created_at_sec"),
                            r.get::<i64, _>("created_at_nsec") as i32,
                            r.get("updated_at_sec"),
                            r.get::<i64, _>("updated_at_nsec") as i32,
                            r.get("last_actor_id"),
                        )
                    })
                    .collect()
            }
            BackendConn::Postgres(conn) => {
                let note_strs: Vec<&str> = chunk.iter().map(NoteId::as_str).collect();
                let fetched = sqlx::query(
                    "SELECT note_id, parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                            ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                            visibility_mask, settlement_successor_id, created_seq, updated_seq,
                            created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                     FROM note_heads WHERE space_id = $1 AND note_id = ANY($2)",
                )
                .bind(space_id.as_str())
                .bind(note_strs)
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| {
                    crate::runtime::pg_read_error("pg_load_note_heads_batch", err)
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("note_id"),
                            r.get("parent_folder_id"),
                            r.get("slug"),
                            r.get("slug_fold"),
                            r.get("title"),
                            r.get("title_fold"),
                            r.get("doc_class"),
                            r.get("ability_id"),
                            r.get("head_rev_id"),
                            r.get("content_blake3"),
                            r.get("byte_size"),
                            r.get("lifecycle_state"),
                            r.get("visibility_mask"),
                            r.get("settlement_successor_id"),
                            r.get("created_seq"),
                            r.get("updated_seq"),
                            r.get("created_at_sec"),
                            r.get("created_at_nsec"),
                            r.get("updated_at_sec"),
                            r.get("updated_at_nsec"),
                            r.get("last_actor_id"),
                        )
                    })
                    .collect()
            }
        };
        for (
            nid_raw,
            parent_raw,
            slug,
            slug_fold,
            title,
            title_fold,
            class_raw,
            ability_raw,
            head_rev_raw,
            digest_raw,
            byte_size_raw,
            lc_raw,
            visibility_mask,
            succ_raw,
            created_seq_raw,
            updated_seq_raw,
            c_sec,
            c_nsec,
            u_sec,
            u_nsec,
            actor_raw,
        ) in rows
        {
            let nid = NoteId::parse(&nid_raw)
                .map_err(|_| internal_not_committed("corrupt_note_id", "invalid note_id"))?;
            let parent_folder_id = FolderId::parse(&parent_raw).map_err(|_| {
                internal_not_committed("corrupt_note_parent", "invalid parent_folder_id")
            })?;
            let doc_class = doc_class_from_db(&class_raw)?;
            let ability_id = match ability_raw {
                Some(s) => Some(AbilityId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_ability_id", "invalid ability_id")
                })?),
                None => None,
            };
            let head_rev_id = RevisionId::parse(&head_rev_raw)
                .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
            let content_digest = match digest_raw {
                Some(b) => {
                    let arr: [u8; 32] = b.try_into().map_err(|_| {
                        internal_not_committed("corrupt_note_digest", "content_blake3 != 32B")
                    })?;
                    Some(ContentDigest::from_bytes(arr))
                }
                None => None,
            };
            let byte_size = u64::try_from(byte_size_raw)
                .map_err(|_| internal_not_committed("corrupt_byte_size", "negative byte_size"))?;
            let lifecycle = lifecycle_from_db(&lc_raw)?;
            let settlement_successor_id = match succ_raw {
                Some(s) => Some(NoteId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_successor_id", "invalid successor")
                })?),
                None => None,
            };
            let created_seq = i64_to_space_seq(created_seq_raw)?;
            let updated_seq = i64_to_space_seq(updated_seq_raw)?;
            let created_at = decode_timestamp_parts(c_sec, c_nsec)?;
            let updated_at = decode_timestamp_parts(u_sec, u_nsec)?;
            let last_actor_id = PrincipalId::parse(&actor_raw).map_err(|_| {
                internal_not_committed("corrupt_last_actor", "invalid last_actor_id")
            })?;
            out.insert(
                nid.clone(),
                NoteHeadRow {
                    note_id: nid,
                    parent_folder_id,
                    slug,
                    slug_fold,
                    title,
                    title_fold,
                    doc_class,
                    ability_id,
                    head_rev_id,
                    content_digest,
                    byte_size,
                    lifecycle,
                    visibility_mask,
                    settlement_successor_id,
                    created_seq,
                    updated_seq,
                    created_at,
                    updated_at,
                    last_actor_id,
                },
            );
        }
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub(crate) struct FolderAncestryFacts {
    pub ancestors: Vec<FolderId>,
    pub write_locked: bool,
    /// Whether a note placed directly in this folder is a logical root child.
    pub is_root_child: bool,
    pub folder_path: String,
    pub project: Option<FolderId>,
    pub cover_note: Option<NoteId>,
}

impl FolderAncestryFacts {
    pub(crate) fn note_provenance(
        &self,
        note: &NoteId,
        slug: &str,
        title: String,
        principal: PrincipalId,
        modified_at: Timestamp,
    ) -> notarium_core::ports::NoteProvenance {
        let path = if self.folder_path.is_empty() {
            format!("{slug}.md")
        } else {
            format!("{}/{slug}.md", self.folder_path)
        };
        notarium_core::ports::NoteProvenance {
            title,
            path,
            project: self.project.clone(),
            principal,
            modified_at,
            folder_page: self.cover_note.as_ref() == Some(note),
        }
    }
}

/// Transaction-scoped memoization cache for `folder_heads` rows and computed `FolderAncestryFacts`
/// so multi-item read transactions (`recent_activity`, `read_changes`, `hydrate_cards`, `ChangeSeed`)
/// resolve 256-deep folder chains in `O(unique folders)` instead of `O(items * depth)` SQL queries.
#[derive(Default)]
pub(crate) struct FolderAncestryCache {
    rows: HashMap<FolderId, AncestryRow>,
    snapshot: Option<(HistoryScope, SpaceSeq)>,
    resolved: HashMap<(FolderId, bool), FolderAncestryFacts>,
}

#[derive(Clone)]
struct AncestryRow {
    folder_id: FolderId,
    parent_folder_id: Option<FolderId>,
    is_root: bool,
    slug: String,
    write_locked: bool,
    lifecycle: Lifecycle,
    is_project: bool,
    cover_note: Option<NoteId>,
}

impl From<crate::runtime::FolderHeadRow> for AncestryRow {
    fn from(row: crate::runtime::FolderHeadRow) -> Self {
        Self {
            folder_id: row.folder_id,
            parent_folder_id: row.parent_folder_id,
            is_root: row.is_root,
            slug: row.slug,
            write_locked: row.write_locked,
            lifecycle: row.lifecycle,
            is_project: row.is_project,
            cover_note: row.cover_note_id,
        }
    }
}

impl FolderAncestryCache {
    pub(crate) fn at_cut(scope: &HistoryScope, cutoff: SpaceSeq) -> Self {
        Self {
            snapshot: Some((scope.clone(), cutoff)),
            ..Self::default()
        }
    }

    pub(crate) fn insert_preloaded_row(&mut self, row: crate::runtime::FolderHeadRow) {
        self.rows.insert(row.folder_id.clone(), row.into());
    }

    async fn load_row(
        &self,
        tx: &mut BackendConn<'_>,
        space: &SpaceId,
        folder: &FolderId,
    ) -> Result<AncestryRow, PortError> {
        let Some((scope, cutoff)) = &self.snapshot else {
            return Ok(load_folder_head_row(tx, space, folder).await?.into());
        };
        let rev = crate::runtime::read_immutable_revision_tx(
            tx,
            scope,
            "folder",
            folder.as_str(),
            *cutoff,
        )
        .await?
        .ok_or_else(|| DomainError::validation(ValidationReason::CursorStale))?;
        let RevisionMetadataPayload::Folder(row) = rev.metadata.payload else {
            return Err(internal_not_committed(
                "corrupt_folder_revision",
                "expected folder metadata",
            ));
        };
        Ok(AncestryRow {
            folder_id: row.folder_id,
            parent_folder_id: row.parent_folder_id,
            is_root: row.is_root,
            slug: row.slug,
            write_locked: row.write_locked,
            lifecycle: row.lifecycle,
            is_project: row.is_project,
            cover_note: row.cover_note_id,
        })
    }

    pub(crate) async fn load_ancestry_tx(
        &mut self,
        tx: &mut BackendConn<'_>,
        space_id: &SpaceId,
        folder_id: &FolderId,
        require_all_active: bool,
    ) -> Result<FolderAncestryFacts, PortError> {
        if let Some(cached) = self.resolved.get(&(folder_id.clone(), require_all_active)) {
            return Ok(cached.clone());
        }

        let mut chain: Vec<AncestryRow> = Vec::new();
        let mut visited = BTreeSet::new();
        let mut current = folder_id.clone();

        let mut acc = loop {
            if chain.len() > MAX_FOLDER_DEPTH {
                return Err(internal_not_committed(
                    "folder_depth_exceeded",
                    "folder tree exceeded MAX_FOLDER_DEPTH",
                ));
            }
            if let Some(cached) = self.resolved.get(&(current.clone(), require_all_active)) {
                break cached.clone();
            }
            if !visited.insert(current.clone()) {
                return Err(internal_not_committed(
                    "folder_cycle_detected",
                    "corrupt cycle in folder_heads",
                ));
            }

            let row = if let Some(existing) = self.rows.get(&current) {
                existing.clone()
            } else {
                let fetched = self.load_row(tx, space_id, &current).await?;
                self.rows.insert(current.clone(), fetched.clone());
                fetched
            };

            if require_all_active && row.lifecycle != Lifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }

            if row.is_root {
                let root_facts = FolderAncestryFacts {
                    ancestors: vec![row.folder_id.clone()],
                    write_locked: row.write_locked,
                    is_root_child: true,
                    folder_path: String::new(),
                    project: None,
                    cover_note: row.cover_note,
                };
                self.resolved.insert(
                    (row.folder_id.clone(), require_all_active),
                    root_facts.clone(),
                );
                break root_facts;
            }

            let next_parent = row.parent_folder_id.clone().ok_or_else(|| {
                internal_not_committed(
                    "non_root_missing_parent",
                    "non-root folder missing parent_folder_id",
                )
            })?;
            chain.push(row);
            current = next_parent;
        };

        for child_row in chain.into_iter().rev() {
            if acc.ancestors.len() > MAX_FOLDER_DEPTH {
                return Err(internal_not_committed(
                    "folder_depth_exceeded",
                    "folder tree exceeded MAX_FOLDER_DEPTH",
                ));
            }
            if acc.ancestors.contains(&child_row.folder_id) {
                return Err(internal_not_committed(
                    "folder_cycle_detected",
                    "corrupt cycle in folder_heads",
                ));
            }
            let mut next_anc = Vec::with_capacity(acc.ancestors.len() + 1);
            next_anc.push(child_row.folder_id.clone());
            next_anc.extend_from_slice(&acc.ancestors);
            let next_locked = child_row.write_locked || acc.write_locked;
            let next_path = if acc.folder_path.is_empty() {
                child_row.slug.clone()
            } else {
                format!("{}/{}", acc.folder_path, child_row.slug)
            };
            acc = FolderAncestryFacts {
                ancestors: next_anc,
                write_locked: next_locked,
                is_root_child: false,
                folder_path: next_path,
                project: if child_row.is_project {
                    Some(child_row.folder_id.clone())
                } else {
                    acc.project
                },
                cover_note: child_row.cover_note,
            };
            self.resolved
                .insert((child_row.folder_id, require_all_active), acc.clone());
        }

        Ok(acc)
    }

    pub(crate) async fn live_note_facts(
        &mut self,
        tx: &mut BackendConn<'_>,
        space: &Space,
        note: &NoteId,
        active_only: bool,
    ) -> Result<Option<(ResourceFacts, Lifecycle)>, PortError> {
        if crate::runtime::is_note_purge_fenced_tx(tx, &space.id, note.as_str()).await? {
            return Ok(None);
        }
        let Some(head) = load_note_head_row_opt_tx(tx, &space.id, note).await? else {
            return Ok(None);
        };
        if head.lifecycle == Lifecycle::Purged
            || (active_only && head.lifecycle != Lifecycle::Active)
        {
            return Ok(None);
        }
        let (facts, _) = self
            .build_resource_facts_tx(
                tx,
                space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id,
                active_only,
            )
            .await?;
        Ok(Some((facts, head.lifecycle)))
    }

    pub(crate) async fn build_resource_facts_tx(
        &mut self,
        tx: &mut BackendConn<'_>,
        space: &Space,
        parent_folder_id: &FolderId,
        class: DocClass,
        ability_package: Option<AbilityId>,
        require_active_folders: bool,
    ) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
        let anc = self
            .load_ancestry_tx(tx, &space.id, parent_folder_id, require_active_folders)
            .await?;
        let facts = ResourceFacts {
            space: space.clone(),
            class,
            ancestor_folders: anc.ancestors.clone(),
            folder_write_locked: anc.write_locked,
            ability_package,
        };
        Ok((facts, anc))
    }
}

/// Walks `folder_heads` from `folder_id` up to the Space root (`O(depth)`), returning
/// `[folder_id, parent, ..., root]`, aggregated `write_locked`, and normalized path prefix.
pub(crate) async fn load_folder_ancestry_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    folder_id: &FolderId,
    require_all_active: bool,
) -> Result<FolderAncestryFacts, PortError> {
    let mut ancestors = Vec::new();
    let mut segments_rev = Vec::new();
    let mut visited = BTreeSet::new();
    let mut write_locked = false;
    let mut current = folder_id.clone();
    let mut project = None;
    let mut cover_note = None;

    for _depth in 0..=MAX_FOLDER_DEPTH {
        if !visited.insert(current.clone()) {
            return Err(internal_not_committed(
                "folder_cycle_detected",
                "corrupt cycle in folder_heads",
            ));
        }
        let row = load_folder_head_row(tx, space_id, &current).await?;
        if require_all_active && row.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if row.write_locked {
            write_locked = true;
        }
        if ancestors.is_empty() {
            cover_note = row.cover_note_id;
        }
        if row.is_project && project.is_none() {
            project = Some(row.folder_id.clone());
        }
        ancestors.push(row.folder_id.clone());
        if row.is_root {
            segments_rev.reverse();
            let folder_path = if segments_rev.is_empty() {
                String::new()
            } else {
                segments_rev.join("/")
            };
            let is_root_child = ancestors.len() == 1;
            return Ok(FolderAncestryFacts {
                ancestors,
                write_locked,
                is_root_child,
                folder_path,
                project,
                cover_note,
            });
        }
        segments_rev.push(row.slug);
        current = row.parent_folder_id.ok_or_else(|| {
            internal_not_committed(
                "non_root_missing_parent",
                "non-root folder missing parent_folder_id",
            )
        })?;
    }

    Err(internal_not_committed(
        "folder_depth_exceeded",
        "folder tree exceeded MAX_FOLDER_DEPTH",
    ))
}

pub(crate) async fn build_resource_facts_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    parent_folder_id: &FolderId,
    class: DocClass,
    ability_package: Option<AbilityId>,
    require_active_folders: bool,
) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
    let anc =
        load_folder_ancestry_tx(tx, &space.id, parent_folder_id, require_active_folders).await?;
    let facts = ResourceFacts {
        space: space.clone(),
        class,
        ancestor_folders: anc.ancestors.clone(),
        folder_write_locked: anc.write_locked,
        ability_package,
    };
    Ok((facts, anc))
}

pub(crate) async fn authorized_collision_revision_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &notarium_core::auth::EngineAuthContext,
    note: &NoteId,
) -> Result<Option<RevisionId>, PortError> {
    let Some(head) = load_note_head_row_opt_tx(tx, &space.id, note).await? else {
        return Ok(None);
    };
    if head.lifecycle == Lifecycle::Purged {
        return Err(DomainError::ResourceNotFound.into());
    }
    let (facts, _) = build_resource_facts_tx(
        tx,
        space,
        &head.parent_folder_id,
        head.doc_class,
        head.ability_id,
        false,
    )
    .await?;
    auth.authorize_direct_write(&facts, &facts)?;
    Ok(Some(head.head_rev_id))
}

pub(crate) async fn active_note_sibling_exists_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
    exclude_note_id: Option<&NoteId>,
) -> Result<bool, PortError> {
    let excl = exclude_note_id.map(NoteId::as_str).unwrap_or("");
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM note_heads
             WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ?
               AND lifecycle_state = 'active' AND note_id <> ?
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .bind(excl)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_note_sibling_check", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM note_heads
             WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3
               AND lifecycle_state = 'active' AND note_id <> $4
             LIMIT 1",
        )
        .bind(space_id.as_str())
        .bind(parent_folder_id.as_str())
        .bind(slug_fold)
        .bind(excl)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_note_sibling_check", err.to_string()))?,
    };
    Ok(found.is_some())
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct CurrentSpaceSchema {
    pub schema_revision: RevisionId,
    pub schema_note_id: NoteId,
    pub descriptor_fingerprint: ContentDigest,
    pub fields: BTreeMap<String, FieldSchema>,
}

pub(crate) async fn load_current_space_schema_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<Option<CurrentSpaceSchema>, PortError> {
    let raw: Option<(String, String, Vec<u8>, Vec<u8>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = ? AND is_current = 1
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_space_schema", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
                 FROM space_field_schemas
                 WHERE space_id = $1 AND is_current = 1
                 LIMIT 1",
            )
            .bind(space_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_space_schema", err))?;
            row.map(|r| {
                (
                    r.get("schema_rev_id"),
                    r.get("schema_note_id"),
                    r.get("descriptor_msgpack"),
                    r.get("descriptor_fingerprint"),
                )
            })
        }
    };

    let Some((rev_raw, note_raw, msgpack, fp_bytes)) = raw else {
        return Ok(None);
    };
    let schema_revision = RevisionId::parse(&rev_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_rev", "invalid schema_rev_id"))?;
    let schema_note_id = NoteId::parse(&note_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_note", "invalid schema_note_id"))?;
    let arr: [u8; 32] = fp_bytes.try_into().map_err(|_| {
        internal_not_committed("corrupt_schema_fp", "descriptor_fingerprint != 32B")
    })?;
    let fields: BTreeMap<String, FieldSchema> =
        decode_msgpack_bounded(&msgpack, MAX_MSGPACK_DECODE_BYTES)?;

    Ok(Some(CurrentSpaceSchema {
        schema_revision,
        schema_note_id,
        descriptor_fingerprint: ContentDigest::from_bytes(arr),
        fields,
    }))
}

pub(crate) fn extract_note_title(
    carrier: &str,
    slug: &str,
    class: DocClass,
    raw_fields: Option<&BTreeMap<String, YamlValue>>,
    headings: &[notarium_core::document::Heading],
) -> String {
    if class == DocClass::EncryptedNote {
        return slug.to_owned();
    }
    if let Some(fields) = raw_fields
        && let Some(YamlValue::String(s)) = fields.get("title")
    {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    if let Some(h1) = headings.iter().find(|h| h.level == 1) {
        let trimmed = h1.title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    let _ = carrier;
    slug.to_owned()
}

pub(crate) fn extract_note_preview(carrier: &str, class: DocClass) -> String {
    if class == DocClass::EncryptedNote {
        return String::new();
    }
    let body = match notarium_syntax::frontmatter::analyze(carrier, class) {
        Ok(hdr) => hdr.carrier.body.slice(carrier).unwrap_or(carrier),
        Err(_) => carrier,
    };
    let mut out = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("```") {
            continue;
        }
        let cleaned = trimmed.trim_start_matches('#').trim();
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(cleaned);
        if out.len() >= 180 {
            break;
        }
    }
    if out.chars().count() > 160 {
        out.chars().take(160).collect()
    } else {
        out
    }
}

pub(crate) async fn upsert_agent_run_head_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    actor_id: &PrincipalId,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    now_ts: Timestamp,
) -> Result<RevisionId, PortError> {
    let run_rev = new_revision_id()?;
    let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
        AgentRunRevisionMetadata {
            run_id: run_id.clone(),
            last_seq: visibility_seq,
        },
    ))
    .encode()?;
    insert_revision_row(
        tx,
        scope,
        &run_rev,
        "agent_run",
        run_id.as_str(),
        space_seq,
        visibility_seq,
        None,
        None,
        None,
        &meta,
        actor_id,
        Some(run_id),
        now_ts,
    )
    .await?;

    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let last_i64 = visibility_seq.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = excluded.history_incarnation,
                    run_revision = excluded.run_revision,
                    last_seq = excluded.last_seq,
                    updated_at_sec = excluded.updated_at_sec,
                    updated_at_nsec = excluded.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = EXCLUDED.history_incarnation,
                    run_revision = EXCLUDED.run_revision,
                    last_seq = EXCLUDED.last_seq,
                    updated_at_sec = EXCLUDED.updated_at_sec,
                    updated_at_nsec = EXCLUDED.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_upsert_agent_run", err.to_string()))?;
        }
    }
    Ok(run_rev)
}

pub(crate) async fn check_collab_preconditions_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    preconditions: &Preconditions,
) -> Result<(), PortError> {
    if preconditions.lease.is_none() && preconditions.lineage.is_none() {
        return Ok(());
    }
    let session_opt: Option<(i64, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT lease_epoch, lineage_epoch FROM collab_sessions
                 WHERE space_id = ? AND note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_collab_prec", err.to_string()))?;
            row.map(|r| (r.get("lease_epoch"), r.get("lineage_epoch")))
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT lease_epoch, lineage_epoch FROM collab_sessions
                 WHERE space_id = $1 AND note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_check_collab_prec", err))?;
            row.map(|r| (r.get("lease_epoch"), r.get("lineage_epoch")))
        }
    };

    let (actual_lease, actual_lineage) = match session_opt {
        Some((le, li)) => (
            LeaseEpoch::new(u64::try_from(le).unwrap_or(0))?,
            LineageEpoch::new(u64::try_from(li).unwrap_or(0))?,
        ),
        None => (LeaseEpoch::ZERO, LineageEpoch::ZERO),
    };

    if let Some(expected_lease) = preconditions.lease
        && expected_lease != actual_lease
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if let Some(expected_lineage) = preconditions.lineage
        && expected_lineage != actual_lineage
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NoteRoomDirectWriteState {
    NoSessionRow,
    ClosedSessionRow,
    NeedsSettlement,
    ActiveOrFenced,
}

impl NoteRoomDirectWriteState {
    pub(crate) fn from_row(row: Option<(String, i64)>) -> Self {
        match row {
            None => Self::NoSessionRow,
            Some((state, dirty)) if state == "closed" => {
                if dirty == 0 {
                    Self::ClosedSessionRow
                } else {
                    Self::NeedsSettlement
                }
            }
            Some(_) => Self::ActiveOrFenced,
        }
    }

    /// Returns whether a closed lineage must be advanced with the carrier.
    pub(crate) fn require_writable(self) -> Result<bool, PortError> {
        match self {
            Self::NoSessionRow => Ok(false),
            Self::ClosedSessionRow => Ok(true),
            Self::NeedsSettlement => Err(crate::codec::unavailable_retryable(
                "collab_carrier_needs_settlement",
                "reconcile the closed room snapshot and remaining updates before replacing its carrier",
                std::time::Duration::from_millis(50),
            )),
            Self::ActiveOrFenced => Err(crate::codec::unavailable_retryable(
                "collab_room_not_closed",
                "note collaborative session is active or fenced awaiting recovery",
                std::time::Duration::from_millis(50),
            )),
        }
    }
}

pub(crate) async fn check_note_room_direct_write_tx(
    tx: &mut BackendConn<'_>,
    room_fences: &RoomFenceTable,
    scope: &HistoryScope,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    if room_fences.is_room_active(scope, note_id).await? {
        return Ok(NoteRoomDirectWriteState::ActiveOrFenced);
    }
    durable_note_room_state_tx(tx, &scope.space_id, note_id).await
}

pub(crate) async fn durable_note_room_state_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    let row = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as::<_, (String, i64)>(
            "SELECT room_state, COALESCE(carrier_dirty, 0) FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
             WHERE space_id = ? AND note_id = ?",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await,
        BackendConn::Postgres(conn) => sqlx::query_as::<_, (String, i64)>(
            "SELECT room_state, COALESCE(carrier_dirty, 0) FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
             WHERE space_id = $1 AND note_id = $2",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await,
    }.map_err(|err| internal_not_committed("check_durable_room", err.to_string()))?;
    Ok(NoteRoomDirectWriteState::from_row(row))
}

pub(crate) async fn is_note_room_active_tx(
    tx: &mut BackendConn<'_>,
    room_fences: &RoomFenceTable,
    scope: &HistoryScope,
    note_id: &NoteId,
) -> Result<bool, PortError> {
    Ok(matches!(
        check_note_room_direct_write_tx(tx, room_fences, scope, note_id).await?,
        NoteRoomDirectWriteState::ActiveOrFenced
    ))
}

pub(crate) async fn sync_closed_collab_session_on_direct_write_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    new_carrier_rev: &RevisionId,
    updated_seq: SpaceSeq,
) -> Result<(), PortError> {
    if !durable_note_room_state_tx(tx, space_id, note_id)
        .await?
        .require_writable()?
    {
        return Ok(());
    }
    let seq_i64 = updated_seq.get() as i64;
    let affected = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query("DELETE FROM collab_checkpoints WHERE space_id = ? AND note_id = ?")
                .bind(space_id.as_str())
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_sync_clear_collab_checkpoint", err.to_string())
                })?;
            sqlx::query(
                "UPDATE collab_sessions
                 SET lineage_epoch = lineage_epoch + 1,
                     carrier_rev_id = ?,
                     yrs_snapshot_blob = NULL,
                     yrs_snapshot_blake3 = NULL,
                     updated_seq = ?
                 WHERE space_id = ? AND note_id = ? AND room_state = 'closed'",
            )
            .bind(new_carrier_rev.as_str())
            .bind(seq_i64)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_sync_collab_lineage", err.to_string()))?
            .rows_affected()
        }
        BackendConn::Postgres(conn) => {
            sqlx::query("DELETE FROM collab_checkpoints WHERE space_id = $1 AND note_id = $2")
                .bind(space_id.as_str())
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_sync_clear_collab_checkpoint", err.to_string())
                })?;
            sqlx::query(
                "UPDATE collab_sessions
                 SET lineage_epoch = lineage_epoch + 1,
                     carrier_rev_id = $1,
                     yrs_snapshot_blob = NULL,
                     yrs_snapshot_blake3 = NULL,
                     updated_seq = $2
                 WHERE space_id = $3 AND note_id = $4 AND room_state = 'closed'",
            )
            .bind(new_carrier_rev.as_str())
            .bind(seq_i64)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_sync_collab_lineage", err.to_string()))?
            .rows_affected()
        }
    };
    if affected > 0 {
        let _ = crate::blobs::release_owner_blob_refs_tx(
            tx,
            space_id,
            crate::blobs::BlobOwnerKind::CollabSnapshot,
            note_id.as_str(),
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn insert_note_alias_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    old_parent_folder_id: &FolderId,
    old_slug_fold: &str,
    old_title_norm: &str,
    target_note_id: &NoteId,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT OR IGNORE INTO note_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, old_title_norm, target_note_id, created_seq
                 ) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(old_title_norm)
            .bind(target_note_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_note_alias", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO note_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, old_title_norm, target_note_id, created_seq
                 ) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(old_title_norm)
            .bind(target_note_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_note_alias", err.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) async fn insert_folder_alias_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    old_parent_folder_id: &FolderId,
    old_slug_fold: &str,
    target_folder_id: &FolderId,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT OR IGNORE INTO folder_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, target_folder_id, created_seq
                 ) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(target_folder_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_folder_alias", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO folder_aliases (
                    space_id, old_parent_folder_id, old_slug_fold, target_folder_id, created_seq
                 ) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING",
            )
            .bind(space_id.as_str())
            .bind(old_parent_folder_id.as_str())
            .bind(old_slug_fold)
            .bind(target_folder_id.as_str())
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_folder_alias", err.to_string()))?;
        }
    }
    Ok(())
}

// ============================================================================
// Serializable Receipt Wire Envelopes (MessagePack-safe, adjacently tagged)
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedNoteRevV1 {
    pub value: NoteRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedNoteRevV1 {
    pub fn into_committed(self) -> Committed<NoteRevision> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedFolderRefV1 {
    pub value: FolderRef,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedFolderRefV1 {
    pub fn into_committed(self) -> Committed<FolderRef> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "target_kind",
    content = "target_data",
    rename_all = "snake_case"
)]
pub(crate) enum StoredLinkTargetV1 {
    Note(NoteId),
    Folder(FolderId),
    AuthoredName(String),
}

impl From<&LinkTarget> for StoredLinkTargetV1 {
    fn from(value: &LinkTarget) -> Self {
        match value {
            LinkTarget::Note(id) => Self::Note(id.clone()),
            LinkTarget::Folder(id) => Self::Folder(id.clone()),
            LinkTarget::AuthoredName(name) => Self::AuthoredName(name.clone()),
        }
    }
}

impl From<StoredLinkTargetV1> for LinkTarget {
    fn from(value: StoredLinkTargetV1) -> Self {
        match value {
            StoredLinkTargetV1::Note(id) => Self::Note(id),
            StoredLinkTargetV1::Folder(id) => Self::Folder(id),
            StoredLinkTargetV1::AuthoredName(name) => Self::AuthoredName(name),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedLinkV1 {
    pub source: NoteId,
    pub target: StoredLinkTargetV1,
    pub relation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedLinkV1 {
    pub fn from_link(link: &Link, receipt: MutationReceiptToken) -> Self {
        Self {
            source: link.source.clone(),
            target: StoredLinkTargetV1::from(&link.target),
            relation: link.relation.clone(),
            target_title: link.target_title.clone(),
            receipt,
        }
    }

    pub fn into_committed(self) -> Committed<Link> {
        Committed {
            value: Link {
                source: self.source,
                target: self.target.into(),
                relation: self.relation,
                target_title: self.target_title,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedAbilityRevV1 {
    pub ability: AbilityId,
    pub revision: RevisionId,
    pub manifest: BTreeMap<String, ContentDigest>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedAbilityRevV1 {
    pub fn into_committed(self) -> Committed<AbilityPackageRevision> {
        Committed {
            value: AbilityPackageRevision {
                ability: self.ability,
                revision: self.revision,
                manifest: self.manifest,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedMintAndPurgeV1 {
    pub old_note: NoteId,
    pub new_note: NoteRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedMintAndPurgeV1 {
    pub fn into_committed(self) -> Committed<MintAndPurgeResult> {
        Committed {
            value: MintAndPurgeResult {
                old_note: self.old_note,
                new_note: self.new_note,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedBoardMoveV1 {
    pub revision: NoteRevision,
    pub rank_revision: RevisionId,
    pub group: GroupKey,
    pub rank: String,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedBoardMoveV1 {
    pub fn into_committed(self) -> Committed<BoardMoveResult> {
        Committed {
            value: BoardMoveResult {
                revision: self.revision,
                rank_revision: self.rank_revision,
                group: self.group,
                rank: self.rank,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedRollbackV1 {
    pub restored: Vec<NoteRevision>,
    pub trashed: Vec<NoteRevision>,
    pub restored_ranks: Vec<RestoredBoardRank>,
    pub skipped_manual_edits: Vec<NoteId>,
    pub skipped_room_active: Vec<NoteId>,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedRollbackV1 {
    pub fn into_committed(self) -> Committed<RollbackResult> {
        Committed {
            value: RollbackResult {
                restored: self.restored,
                trashed: self.trashed,
                restored_ranks: self.restored_ranks,
                skipped_manual_edits: self.skipped_manual_edits,
                skipped_room_active: self.skipped_room_active,
            },
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredCommittedSchemaRevV1 {
    pub value: SpaceSchemaRevision,
    pub receipt: MutationReceiptToken,
}

impl StoredCommittedSchemaRevV1 {
    pub fn into_committed(self) -> Committed<SpaceSchemaRevision> {
        Committed {
            value: self.value,
            receipt: self.receipt,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "outcome", content = "data", rename_all = "snake_case")]
pub(crate) enum StoredExternalObsOutcomeV1 {
    Committed {
        #[serde(flatten)]
        result: StoredCommittedNoteRevV1,
        // Older receipts retain value and receipt without a validated plan.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        verified_plan: Option<ContentDigest>,
    },
    NoChange {
        revision: RevisionId,
    },
    Conflict {
        current: RevisionId,
    },
}

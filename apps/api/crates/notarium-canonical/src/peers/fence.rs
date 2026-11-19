use notarium_core::{
    error::PortError,
    ids::{LeaseEpoch, NoteId},
    model::HistoryScope,
    ports::RoomFenceState,
};
use tokio::sync::OwnedMutexGuard;

use super::{CollabRoomState, CollabSessionRecord};
use crate::{CanonicalStore, runtime::load_space_record_for_update_opt, sql_exec::BackendConn};

/// Retain the original room lock until COMMIT is acknowledged or a fresh
/// transaction has established which lease actually became durable.
pub(super) struct RoomTransition {
    store: CanonicalStore,
    scope: HistoryScope,
    note: NoteId,
    pending: Option<(OwnedMutexGuard<RoomFenceState>, RoomFenceState)>,
}

impl RoomTransition {
    pub(super) fn new(
        store: CanonicalStore,
        scope: &HistoryScope,
        guard: OwnedMutexGuard<RoomFenceState>,
        record: &CollabSessionRecord,
    ) -> Result<Self, PortError> {
        let state = crate::domain::common::persisted_room_fence(
            record.note.clone(),
            scope.clone(),
            record.lease_epoch,
            record.room_state == CollabRoomState::Active,
        )?;
        Ok(Self {
            store,
            scope: scope.clone(),
            note: record.note.clone(),
            pending: Some((guard, state)),
        })
    }

    pub(super) fn prepare(
        store: CanonicalStore,
        scope: &HistoryScope,
        guard: OwnedMutexGuard<RoomFenceState>,
        record: CollabSessionRecord,
    ) -> Result<(CollabSessionRecord, Self), PortError> {
        let transition = Self::new(store, scope, guard, &record)?;
        Ok((record, transition))
    }

    pub(super) fn confirmed(
        (record, transition): (CollabSessionRecord, Self),
    ) -> Result<CollabSessionRecord, PortError> {
        transition.publish();
        Ok(record)
    }

    pub(super) fn publish(mut self) {
        if let Some((mut guard, next)) = self.pending.take() {
            *guard = next;
        }
    }
}

impl Drop for RoomTransition {
    fn drop(&mut self) {
        let Some((mut guard, next)) = self.pending.take() else {
            return;
        };
        let store = self.store.clone();
        let scope = self.scope.clone();
        let note = self.note.clone();
        let task = self.store.inner.backup_executor.spawn(async move {
            let mut delay = std::time::Duration::from_millis(25);
            loop {
                let query = read_durable_fence(&store, &scope, &note, next.epoch());
                let result = tokio::select! {
                    biased;
                    () = store.inner.backup_shutdown.cancelled() => return,
                    result = query => result,
                };
                match result {
                    Ok(Some(state)) => {
                        *guard = state;
                        return;
                    }
                    Ok(None) => return, // The attempted transition rolled back.
                    Err(err) => tracing::warn!(?err, "retrying uncertain room commit"),
                }
                tokio::select! {
                    () = store.inner.backup_shutdown.cancelled() => return,
                    () = tokio::time::sleep(delay) => {},
                }
                delay = (delay * 2).min(std::time::Duration::from_secs(2));
            }
        });
        crate::backup::register_cleanup_task(&self.store.inner, task);
    }
}

async fn read_durable_fence(
    store: &CanonicalStore,
    scope: &HistoryScope,
    note: &NoteId,
    minimum: LeaseEpoch,
) -> Result<Option<RoomFenceState>, PortError> {
    let scope = scope.clone();
    let note = note.clone();
    store
        .with_write_tx(move |tx| {
            Box::pin(async move {
                // The Space lock orders this read after the original transaction,
                // even when its connection died before delivering the COMMIT reply.
                let space = load_space_record_for_update_opt(tx, &scope.space_id).await?;
                if !space.is_some_and(|space| space.scope == scope) {
                    return Ok(None);
                }
                const SQL: &str = "SELECT lease_epoch, room_state FROM collab_sessions
                               WHERE space_id = $1 AND note_id = $2";
                let row = match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query_as::<_, (i64, String)>(SQL)
                            .bind(scope.space_id.as_str())
                            .bind(note.as_str())
                            .fetch_optional(&mut **conn)
                            .await
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query_as::<_, (i64, String)>(SQL)
                            .bind(scope.space_id.as_str())
                            .bind(note.as_str())
                            .fetch_optional(&mut **conn)
                            .await
                    }
                }
                .map_err(|err| {
                    crate::codec::internal_not_committed("resolve_room_commit", err.to_string())
                })?;
                let Some((epoch, state)) = row else {
                    return Ok(None);
                };
                let epoch = u64::try_from(epoch).map_err(|err| {
                    crate::codec::internal_not_committed("corrupt_room_epoch", err.to_string())
                })?;
                let epoch = LeaseEpoch::new(epoch)?;
                if epoch < minimum {
                    return Ok(None);
                }
                let active = CollabRoomState::from_db(&state)? == CollabRoomState::Active;
                crate::domain::common::persisted_room_fence(note, scope, epoch, active).map(Some)
            })
        })
        .await
}

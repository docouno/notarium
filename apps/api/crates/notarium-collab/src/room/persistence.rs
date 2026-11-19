use std::sync::{Arc, atomic::Ordering};

use notarium_canonical::{
    AppendCollabUpdates, CanonicalStore, CheckpointCollabSession, CloseCollabSession,
    CollabCarrierSettlement, CollabSessionRecord, CollabSessionSnapshot, CollabSettlementActor,
    FenceCollabSession, NoteCollabAdmission,
};
use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    error::{CommitEffect, PortError, ValidationReason},
    ids::{ContentDigest, NoteId, RevisionId},
    model::HistoryScope,
    ports::{CallBudget, ServiceAuthority, ServicePurpose},
};
use tokio::time::Instant;

use crate::{
    carrier::RoomCarrierState,
    crdt::{TwinDoc, replay_for_recovery},
    hub::{operation_error, unknown},
    wire::PolicyRejectReason,
};

use super::{Room, RoomLease};

const SETTLE_CONFLICT_RETRIES: usize = 3;

pub(crate) struct PreparedRoom {
    pub twin: TwinDoc,
    pub carrier: RoomCarrierState,
}

impl Room {
    pub fn prepare(admission: &NoteCollabAdmission) -> Result<PreparedRoom, PortError> {
        let (mut carrier, base_body) = RoomCarrierState::from_carrier(
            admission.head_rev_id.clone(),
            digest(&admission.carrier),
            &admission.carrier,
        )?;
        let twin = restore(&mut carrier, base_body, admission.session.as_ref())?;
        Ok(PreparedRoom { twin, carrier })
    }

    pub fn mark_dirty(&mut self) {
        let now = Instant::now();
        self.first_dirty.get_or_insert(now);
        self.last_dirty = Some(now);
    }

    pub fn settled(&mut self) {
        self.first_dirty = None;
        self.last_dirty = None;
        self.updates_since_checkpoint = 0;
        self.carrier.last_writer_auth = None;
        self.carrier.last_writer_peer = None;
    }

    pub async fn checkpoint(&mut self, budget: &CallBudget) -> Result<(), PortError> {
        if self.first_dirty.is_none() {
            return Ok(());
        }
        self.settle(budget, false).await
    }

    pub async fn close(&mut self, budget: &CallBudget) -> Result<(), PortError> {
        self.settle(budget, true).await
    }

    async fn settle(&mut self, budget: &CallBudget, close: bool) -> Result<(), PortError> {
        // Metadata-only commits (rename/move/tags) can advance `head_rev_id`
        // without changing the carrier bytes. Retry boundedly on RevisionConflict
        // after refreshing metadata so the room does not needlessly fence.
        let fm = self.twin.live_overrides().map_err(invalid_state)?;
        let body = self.twin.live_body();
        let final_carrier = self.carrier.materialize(&body, &fm)?;
        let final_digest = digest(&final_carrier);
        let same = final_digest == self.carrier.carrier_blob_blake3;
        let mut snapshot = Some(self.twin.live_snapshot());

        let mut last_err = None;
        for attempt in 0..SETTLE_CONFLICT_RETRIES {
            self.refresh_metadata(budget).await?;
            let can_fallback_actor = !same && self.carrier.last_writer_auth.is_some();
            let may_retry_conflict = attempt + 1 < SETTLE_CONFLICT_RETRIES;
            let keep_snapshot = can_fallback_actor || may_retry_conflict;
            let actor = self
                .carrier
                .last_writer_auth
                .clone()
                .map_or_else(recovery, CollabSettlementActor::writer);
            let settlement = (!same).then(|| CollabCarrierSettlement {
                actor,
                carrier: final_carrier.clone(),
            });
            let snap_for_call = if keep_snapshot {
                snapshot.as_ref().expect("retained snapshot").clone()
            } else {
                snapshot.take().expect("retained snapshot")
            };
            let applied = self
                .commit_checkpoint(budget, close, snap_for_call, same, settlement)
                .await;
            let applied = match applied {
                Err(PortError::Domain(DomainError::AccessDenied | DomainError::SpaceReadOnly))
                    if can_fallback_actor =>
                {
                    let fallback = (!same).then(|| CollabCarrierSettlement {
                        actor: recovery(),
                        carrier: final_carrier.clone(),
                    });
                    let fallback_snap = if may_retry_conflict {
                        snapshot.as_ref().expect("retained snapshot").clone()
                    } else {
                        snapshot.take().expect("retained snapshot")
                    };
                    self.commit_checkpoint(budget, close, fallback_snap, false, fallback)
                        .await
                }
                result => result,
            };
            match applied {
                Ok(applied) => {
                    self.last_self_seq
                        .store(applied.updated_seq.get(), Ordering::Release);
                    self.carrier.advance(
                        applied.carrier_rev_id,
                        final_digest,
                        &final_carrier,
                        fm,
                    )?;
                    self.settled();
                    return Ok(());
                }
                Err(PortError::Domain(DomainError::RevisionConflict { .. }))
                    if may_retry_conflict =>
                {
                    last_err = Some(PortError::Domain(DomainError::RevisionConflict {
                        current: self.carrier.carrier_rev_id.clone(),
                        lineage: Some(self.lease.lineage),
                    }));
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_err.expect("at least one attempt ran"))
    }

    async fn commit_checkpoint(
        &self,
        budget: &CallBudget,
        close: bool,
        snapshot: Vec<u8>,
        unchanged: bool,
        settlement: Option<CollabCarrierSettlement>,
    ) -> Result<CollabSessionRecord, PortError> {
        let scope = self.lease.scope.clone();
        let note = self.lease.note.clone();
        let owner_id = self.lease.owner.to_string();
        let expected_lease = self.lease.epoch;
        let expected_lineage = self.lease.lineage;
        let compacted_through_update_seq = Some(self.last_seq);
        let unchanged_carrier_digest = unchanged.then_some(self.carrier.carrier_blob_blake3);
        if close {
            self.store
                .close_collab_session(
                    budget,
                    CloseCollabSession {
                        scope,
                        note,
                        owner_id: Some(owner_id),
                        expected_lease,
                        expected_lineage,
                        final_yrs_snapshot: Some(snapshot),
                        compacted_through_update_seq,
                        carrier_settlement: settlement,
                        unchanged_carrier_digest,
                    },
                )
                .await
        } else {
            self.store
                .checkpoint_collab_session(
                    budget,
                    CheckpointCollabSession {
                        scope,
                        note,
                        owner_id,
                        expected_lease,
                        expected_lineage,
                        yrs_snapshot: snapshot,
                        compacted_through_update_seq,
                        carrier_settlement: settlement,
                        unchanged_carrier_digest,
                    },
                )
                .await
        }
    }

    pub async fn refresh_metadata(
        &mut self,
        budget: &CallBudget,
    ) -> Result<notarium_core::auth::ResourceFacts, PortError> {
        let facts = self
            .store
            .read_active_room_facts(
                Some(budget),
                &self.lease.scope,
                &self.lease.note,
                self.lease.epoch,
                self.lease.lineage,
                &self.lease.owner,
            )
            .await?;
        if facts.content_digest != self.carrier.carrier_blob_blake3 {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        self.carrier.carrier_rev_id = facts.head_rev_id;
        self.slug.send_if_modified(|slug| {
            if *slug == facts.slug {
                return false;
            }
            *slug = facts.slug;
            true
        });
        Ok(facts.resource)
    }

    pub(super) async fn append(
        &self,
        budget: &CallBudget,
        writes: &[PendingUpdate],
    ) -> Result<u64, PortError> {
        let build_spec = || -> Result<AppendCollabUpdates, PortError> {
            Ok(AppendCollabUpdates {
                scope: self.lease.scope.clone(),
                note: self.lease.note.clone(),
                owner_id: self.lease.owner.to_string(),
                expected_lease: self.lease.epoch,
                expected_lineage: self.lease.lineage,
                updates: self.wal_entries(writes)?,
            })
        };
        let mut authors: Vec<_> = writes.iter().map(|write| write.peer).collect();
        authors.sort_unstable();
        authors.dedup();
        // The writer has already reserved capacity. Hold the live
        // registrations only through the synchronous mailbox send.
        let admit = |enqueue: &mut dyn FnMut()| {
            let mut registrations = Vec::with_capacity(authors.len());
            for author in &authors {
                let peer = self.peers.get(author).ok_or(DomainError::AccessDenied)?;
                registrations.push(
                    peer.outbound
                        .guard
                        .hold_admission()
                        .map_err(|_| DomainError::AccessDenied)?,
                );
            }
            // Sample after all registration checks. Cancellation is one-way,
            // so a still-valid signal also held at this common instant.
            let now = Instant::now();
            if !registrations
                .iter()
                .all(|registration| registration.valid_at(now))
            {
                return Err(DomainError::AccessDenied.into());
            }
            enqueue();
            Ok(())
        };
        let first = self
            .store
            .append_collab_updates_with_admission(budget, build_spec()?, &admit)
            .await;
        if first.as_ref().err().is_none_or(|error| !unknown(error)) {
            return first;
        }
        // The exact replay must enter the same ordered writer as the first
        // submission. A snapshot read can run ahead of an unresolved commit.
        self.store
            .append_collab_updates_with_admission(&self.budget(), build_spec()?, &admit)
            .await
            .map_err(|error| {
                // A rejected retry does not certify the first write was rejected.
                if unknown(&error) {
                    error
                } else {
                    operation_error(b"collab_append_unresolved", CommitEffect::Unknown)
                }
            })
    }

    pub async fn fence(&self) -> Result<(), PortError> {
        fence(&self.store, &self.budget(), &self.lease).await
    }

    pub async fn fence_record(
        store: &CanonicalStore,
        budget: &CallBudget,
        scope: &HistoryScope,
        record: &CollabSessionRecord,
        owner: &Arc<str>,
    ) -> Result<(), PortError> {
        let lease = RoomLease {
            scope: scope.clone(),
            note: record.note.clone(),
            epoch: record.lease_epoch,
            lineage: record.lineage_epoch,
            owner: owner.clone(),
        };
        fence(store, budget, &lease).await
    }
}

async fn fence(
    store: &CanonicalStore,
    budget: &CallBudget,
    lease: &RoomLease,
) -> Result<(), PortError> {
    store
        .fence_collab_session(
            budget,
            FenceCollabSession {
                scope: lease.scope.clone(),
                note: lease.note.clone(),
                owner_id: lease.owner.to_string(),
                expected_lease: lease.epoch,
                expected_lineage: lease.lineage,
            },
        )
        .await
        .map(|_| ())
}

pub(crate) async fn recover_fenced(
    store: &CanonicalStore,
    budget: &CallBudget,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<bool, PortError> {
    let authority = ServiceAuthority::admit(ServicePurpose::CollabRecovery);
    let Some(input) = store
        .read_fenced_collab_recovery(Some(budget), scope, note, &authority)
        .await?
    else {
        return Ok(false);
    };
    let collab = input.session;
    let (mut carrier, base_body) =
        RoomCarrierState::from_carrier(input.head_rev_id, digest(&input.carrier), &input.carrier)?;
    let updates: Vec<&[u8]> = collab
        .updates
        .iter()
        .map(|entry| entry.update_bytes.as_slice())
        .collect();
    let replay = replay_for_recovery(
        base_body,
        collab.session.yrs_snapshot_blob.as_deref(),
        &updates,
    )
    .map_err(|_| {
        if collab.session.yrs_snapshot_blob.is_none() && !updates.is_empty() {
            DomainError::validation(ValidationReason::NotReady).into()
        } else {
            invalid_state(PolicyRejectReason::MalformedUpdate)
        }
    })?;
    if collab.session.yrs_snapshot_blob.is_some() {
        carrier.restore_applied_fm(&replay.snapshot_overrides, collab.session.carrier_dirty);
    }
    let final_carrier = carrier.materialize(&replay.final_body, &replay.final_overrides)?;
    let same = carrier.matches_base(&final_carrier);
    store
        .close_collab_session(
            budget,
            CloseCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: None,
                expected_lease: collab.session.lease_epoch,
                expected_lineage: collab.session.lineage_epoch,
                final_yrs_snapshot: Some(replay.final_snapshot),
                compacted_through_update_seq: Some(0),
                carrier_settlement: (!same).then(|| CollabCarrierSettlement {
                    actor: recovery(),
                    carrier: final_carrier,
                }),
                unchanged_carrier_digest: same.then_some(carrier.carrier_blob_blake3),
            },
        )
        .await?;
    Ok(true)
}

fn restore(
    carrier: &mut RoomCarrierState,
    base_body: &str,
    session: Option<&CollabSessionSnapshot>,
) -> Result<TwinDoc, PortError> {
    let Some(session) = session else {
        return TwinDoc::seed(base_body).map_err(invalid_state);
    };
    let Some(snapshot) = &session.session.yrs_snapshot_blob else {
        if !session.updates.is_empty() {
            return Err(DomainError::validation(ValidationReason::NotReady).into());
        }
        return TwinDoc::seed(base_body).map_err(invalid_state);
    };
    let mut twin = TwinDoc::restore(snapshot).map_err(invalid_state)?;
    carrier.restore_applied_fm(
        &twin.live_overrides().map_err(invalid_state)?,
        session.session.carrier_dirty,
    );
    if !session.updates.is_empty() {
        let updates: Vec<&[u8]> = session
            .updates
            .iter()
            .map(|entry| entry.update_bytes.as_slice())
            .collect();
        twin.replay_batch(&updates).map_err(invalid_state)?;
    }
    Ok(twin)
}

fn recovery() -> CollabSettlementActor {
    CollabSettlementActor::Recovery {
        authority: ServiceAuthority::admit(ServicePurpose::CollabRecovery),
    }
}

pub(super) fn digest(text: &str) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
}

pub(super) fn invalid_state(_: PolicyRejectReason) -> PortError {
    DomainError::validation(ValidationReason::InvalidState).into()
}

pub(super) fn revision_conflict(revision: RevisionId, lease: &RoomLease) -> DomainError {
    DomainError::RevisionConflict {
        current: revision,
        lineage: Some(lease.lineage),
    }
}

pub(super) struct PendingUpdate {
    pub peer: u64,
    pub peer_seq: u64,
    pub auth: EngineAuthContext,
    pub original: Vec<u8>,
    pub staged: Vec<u8>,
}

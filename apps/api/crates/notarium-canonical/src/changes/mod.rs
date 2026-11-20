use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
};

use notarium_core::{
    DomainError, DomainResult,
    auth::ResourceFacts,
    classes::{ClassifiedDocument, DocClass},
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, ChatThreadId, ContentDigest, FolderId, HistoryIncarnation, JobId, NoteId,
        RevisionId, SpaceId, SpaceSeq,
    },
    model::{HistoryScope, Lifecycle, NoteRef},
    ports::{
        Change, ChangeBroadcast, ChangeKind, ChangeNotice, ChangePage, ChangeRead,
        ChangeReadResult, ChangeSeed, ChangeSubscription, ChatThread, CommandSeqRange, EntityId,
        MaintenanceContext, NoteSnapshot, PageLimit, PortFuture, SeedCursor, SeedPosition,
        ServiceAuthority, ServicePurpose, SpaceContext,
    },
    query::{FieldObservation, FieldValue},
    receipt::{
        AcknowledgedCursor, AwaitReason, ChangeCursor, MutationEffect, MutationReceiptToken,
        OverlayRowVersion, ReceiptSet, TrustedMutationEffect,
    },
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::sync::broadcast;

use crate::{
    codec::{
        EFFECT_MAX_NOTES, EFFECT_PAYLOAD_BUDGET_BYTES, MAX_MSGPACK_DECODE_BYTES,
        NoteRevisionMetadata, RevisionMetadataPayload, ThreadRevisionMetadata,
        decode_msgpack_bounded, doc_class_from_db, encode_msgpack, i64_to_space_seq,
        internal_not_committed, lifecycle_from_db,
    },
    runtime::{
        CanonicalStore, load_space_record, read_immutable_revision_tx, validate_snapshot_cutoff_tx,
    },
    sql_exec::BackendConn,
    writer::ChangePayloadDraft,
};

pub const EFFECT_CODEC_V1: &str = "effect_v1";
pub const DEFAULT_BROADCAST_CAPACITY: usize = 1024;
const PG_CHANGE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[cfg(feature = "test-support")]
mod test_support;
#[cfg(feature = "test-support")]
pub use test_support::SyntheticNoteSpec;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChangedNoteSummaryV1 {
    pub note_id: NoteId,
    pub revision: RevisionId,
    pub rank_version: ContentDigest,
    pub lifecycle: Lifecycle,
    pub doc_class: DocClass,
    pub changed_fields: BTreeMap<String, FieldObservation<FieldValue>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredAwaitReasonV1 {
    Bulk,
    Structural,
    UnknownEffect,
    UnavailableVersion,
    TooManyNotes,
    PayloadBudget,
}

impl StoredAwaitReasonV1 {
    pub fn to_core(self) -> AwaitReason {
        match self {
            Self::Bulk => AwaitReason::Bulk,
            Self::Structural => AwaitReason::Structural,
            Self::UnknownEffect => AwaitReason::UnknownEffect,
            Self::UnavailableVersion => AwaitReason::UnavailableVersion,
            Self::TooManyNotes => AwaitReason::TooManyNotes,
            Self::PayloadBudget => AwaitReason::PayloadBudget,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "data", rename_all = "snake_case")]
pub enum EffectBodyV1 {
    NoRelevantEffect,
    Notes { notes: Vec<ChangedNoteSummaryV1> },
    AwaitProjection { reason: StoredAwaitReasonV1 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EffectEnvelopeV1 {
    pub version: u8,
    pub scope: HistoryScope,
    pub command_range: CommandSeqRange,
    pub command_kind: String,
    pub body: EffectBodyV1,
}

impl EffectEnvelopeV1 {
    pub const VERSION: u8 = 1;

    pub fn decode(bytes: &[u8]) -> Result<Self, PortError> {
        let env: Self = decode_msgpack_bounded(bytes, MAX_MSGPACK_DECODE_BYTES)?;
        if env.version != Self::VERSION {
            return Err(internal_not_committed(
                "unsupported_effect_version",
                format!("unsupported EffectEnvelopeV1 version {}", env.version),
            ));
        }
        Ok(env)
    }

    pub fn to_mutation_effect(&self, encoded_len: usize) -> MutationEffect {
        match &self.body {
            EffectBodyV1::NoRelevantEffect => MutationEffect::NoRelevantEffect,
            EffectBodyV1::AwaitProjection { reason } => MutationEffect::AwaitProjection {
                reason: reason.to_core(),
            },
            EffectBodyV1::Notes { notes } => {
                if notes.is_empty() {
                    return MutationEffect::NoRelevantEffect;
                }
                if notes.len() > EFFECT_MAX_NOTES {
                    return MutationEffect::AwaitProjection {
                        reason: AwaitReason::TooManyNotes,
                    };
                }
                if encoded_len > EFFECT_PAYLOAD_BUDGET_BYTES {
                    return MutationEffect::AwaitProjection {
                        reason: AwaitReason::PayloadBudget,
                    };
                }
                let versions = notes
                    .iter()
                    .map(|n| OverlayRowVersion {
                        note_id: n.note_id.clone(),
                        revision: n.revision.clone(),
                        rank_version: n.rank_version,
                    })
                    .collect();
                MutationEffect::Notes {
                    versions,
                    payload_bytes: encoded_len,
                }
            }
        }
    }
}

#[derive(Default)]
struct EffectBuffer {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl std::io::Write for EffectBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > EFFECT_PAYLOAD_BUDGET_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        let required = self.bytes.len() + bytes.len();
        if required > self.bytes.capacity() {
            let capacity = required
                .max(self.bytes.capacity() * 2)
                .clamp(32, EFFECT_PAYLOAD_BUDGET_BYTES);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Builds a bounded `ChangePayloadDraft` (`<= 64 KiB`, `<= 8` distinct notes), degrading oversized
/// or >8-note summaries into `AwaitProjection` while preserving all `owner_note_ids` for purge erasure.
pub fn build_effect_payload_draft(
    payload_id: String,
    scope: HistoryScope,
    command_range: CommandSeqRange,
    command_kind: impl Into<String>,
    candidate_body: EffectBodyV1,
    mut owner_note_ids: Vec<NoteId>,
) -> Result<ChangePayloadDraft, PortError> {
    let command_kind = command_kind.into();

    if let EffectBodyV1::Notes { notes } = &candidate_body {
        for n in notes {
            if !owner_note_ids.contains(&n.note_id) {
                owner_note_ids.push(n.note_id.clone());
            }
        }
    }

    let normalized_body = match candidate_body {
        EffectBodyV1::Notes { notes } => {
            // Deduplicate by note_id keeping the final revision in command order.
            let mut dedup: BTreeMap<NoteId, ChangedNoteSummaryV1> = BTreeMap::new();
            for n in notes {
                dedup.insert(n.note_id.clone(), n);
            }
            if dedup.is_empty() {
                EffectBodyV1::NoRelevantEffect
            } else if dedup.len() > EFFECT_MAX_NOTES {
                EffectBodyV1::AwaitProjection {
                    reason: StoredAwaitReasonV1::TooManyNotes,
                }
            } else {
                EffectBodyV1::Notes {
                    notes: dedup.into_values().collect(),
                }
            }
        }
        other => other,
    };

    let mut env = EffectEnvelopeV1 {
        version: EffectEnvelopeV1::VERSION,
        scope,
        command_range,
        command_kind,
        body: normalized_body,
    };

    let mut buffer = EffectBuffer::default();
    let encoded = match rmp_serde::encode::write_named(&mut buffer, &env) {
        Ok(()) => buffer.bytes,
        Err(_) if buffer.exceeded => {
            env.body = EffectBodyV1::AwaitProjection {
                reason: StoredAwaitReasonV1::PayloadBudget,
            };
            encode_msgpack(&env)?
        }
        Err(err) => {
            return Err(internal_not_committed(
                "msgpack_encode_effect",
                err.to_string(),
            ));
        }
    };

    Ok(ChangePayloadDraft {
        payload_id,
        codec: EFFECT_CODEC_V1.to_owned(),
        effect_msgpack: encoded,
        owner_note_ids,
    })
}

#[derive(Clone, Debug)]
pub(crate) enum BroadcastSignal {
    CatalogChanged {
        scope: HistoryScope,
    },
    Committed {
        scope: HistoryScope,
        new_last_seq: SpaceSeq,
    },
    Purged {
        scope: HistoryScope,
        purged_through_seq: SpaceSeq,
        current_safe_cut: SpaceSeq,
    },
    IncarnationChanged {
        new_scope: HistoryScope,
        ceiling: SpaceSeq,
    },
}

/// Wakeups for projection-space discovery. The catalog remains authoritative
/// after a lagged notification or an incarnation change.
pub struct ProjectionCatalogSubscription {
    receiver: broadcast::Receiver<BroadcastSignal>,
}

impl ProjectionCatalogSubscription {
    pub async fn next(&mut self) -> Option<Option<HistoryScope>> {
        loop {
            match self.receiver.recv().await {
                Ok(BroadcastSignal::CatalogChanged { scope }) => return Some(Some(scope)),
                Ok(BroadcastSignal::IncarnationChanged { new_scope, .. }) => {
                    return Some(Some(new_scope));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => return Some(None),
                Err(broadcast::error::RecvError::Closed) => return None,
                Ok(BroadcastSignal::Committed { .. } | BroadcastSignal::Purged { .. }) => {}
            }
        }
    }
}

pub(crate) struct BroadcastHub {
    sender: StdMutex<broadcast::Sender<BroadcastSignal>>,
    next_sub_id: AtomicU64,
    watermarks: StdMutex<HashMap<u64, AcknowledgedCursor>>,
}

impl BroadcastHub {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        Self {
            sender: StdMutex::new(tx),
            next_sub_id: AtomicU64::new(1),
            watermarks: StdMutex::new(HashMap::new()),
        }
    }

    pub fn publish(&self, signal: BroadcastSignal) {
        let tx = self.sender.lock().expect("broadcast hub mutex").clone();
        let _ = tx.send(signal);
    }

    pub fn subscribe_raw(&self) -> broadcast::Receiver<BroadcastSignal> {
        self.sender.lock().expect("broadcast hub mutex").subscribe()
    }

    #[cfg(feature = "test-support")]
    pub fn reconfigure_capacity(&self, capacity: usize) {
        let (tx, _) = broadcast::channel(capacity.max(1));
        *self.sender.lock().expect("broadcast hub mutex") = tx;
    }

    pub fn register_subscriber(&self, initial: AcknowledgedCursor) -> u64 {
        let id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        self.watermarks
            .lock()
            .expect("watermarks mutex")
            .insert(id, initial);
        id
    }

    pub fn update_subscriber(&self, id: u64, ack: AcknowledgedCursor) {
        self.watermarks
            .lock()
            .expect("watermarks mutex")
            .insert(id, ack);
    }

    pub fn unregister_subscriber(&self, id: u64) {
        self.watermarks
            .lock()
            .expect("watermarks mutex")
            .remove(&id);
    }

    pub fn min_acknowledged_watermark(
        &self,
        space_id: &SpaceId,
        incarnation: &HistoryIncarnation,
    ) -> Option<SpaceSeq> {
        let map = self.watermarks.lock().expect("watermarks mutex");
        map.values()
            .filter(|c| &c.scope.space_id == space_id && &c.scope.incarnation == incarnation)
            .map(|c| c.seq)
            .min()
    }

    pub fn rebind_and_clamp_watermarks(&self, new_scope: &HistoryScope, ceiling: SpaceSeq) {
        let mut map = self.watermarks.lock().expect("watermarks mutex");
        for cursor in map.values_mut() {
            if cursor.scope.space_id == new_scope.space_id
                && let Ok(restored) = cursor.restore(new_scope.clone(), ceiling)
            {
                *cursor = restored;
            }
        }
    }
}

pub(crate) fn check_change_consumer_authority(auth: &ServiceAuthority) -> DomainResult<()> {
    if auth.require(ServicePurpose::Projection).is_ok()
        || auth.require(ServicePurpose::Search).is_ok()
        || auth.require(ServicePurpose::EventPublication).is_ok()
    {
        Ok(())
    } else {
        Err(DomainError::validation(ValidationReason::InvalidAuthority))
    }
}

struct CanonicalChangeSubscription {
    store: CanonicalStore,
    sub_id: u64,
    processed: ChangeCursor,
    delivered_complete_command_end: SpaceSeq,
    pending_initial: Option<ChangeNotice>,
    rx: broadcast::Receiver<BroadcastSignal>,
    next_durable_poll: tokio::time::Instant,
    durable_checked_through: SpaceSeq,
}

impl CanonicalChangeSubscription {
    async fn durable_notice(&mut self, lagged: bool) -> Result<Option<ChangeNotice>, PortError> {
        let processed = self.processed.clone();
        let delivered = self.delivered_complete_command_end;
        // A local broadcast can announce a later head without having seen a remote purge.
        // Only a database read can advance this watermark.
        let checked = self.durable_checked_through;
        let (head, must_reseed) = self.store.with_read_tx(|tx| {
            Box::pin(async move {
                let rec = load_space_record(tx, &processed.scope.space_id).await?;
                let start = if lagged { processed.after } else { processed.after.max(checked) };
                let must_reseed = if rec.scope == processed.scope && rec.last_seq > start {
                    match tx {
                        BackendConn::Postgres(conn) => sqlx::query_scalar::<_, bool>(
                            "SELECT EXISTS (SELECT 1 FROM change_log WHERE space_id=$1
                             AND history_incarnation=$2 AND space_seq>$3 AND space_seq<=$4 AND op_kind='purge')",
                        ).bind(rec.scope.space_id.as_str()).bind(rec.scope.incarnation.as_bytes().as_slice())
                         .bind(start.get() as i64).bind(rec.last_seq.get() as i64)
                         .fetch_one(&mut **conn).await.map_err(|e| crate::runtime::pg_read_error("pg_poll_purge_notice", e))?,
                        BackendConn::Sqlite(_) => has_erased_change_payload_in_range_tx(tx, &rec.scope, start, rec.last_seq).await?,
                    }
                } else {
                    false
                };
                Ok((ChangeCursor {scope: rec.scope, after: rec.last_seq}, must_reseed))
            })
        }).await?;

        if head.scope != self.processed.scope {
            return Ok(Some(ChangeNotice::Resync { scope: head.scope }));
        }
        self.delivered_complete_command_end = delivered.max(head.after);
        self.durable_checked_through = head.after;
        if must_reseed {
            return Ok(Some(ChangeNotice::PurgeResync { cutoff: head }));
        }
        if lagged {
            return Ok(Some(ChangeNotice::Lagged {
                resume: self.processed.clone(),
            }));
        }
        Ok((head.after > delivered).then_some(ChangeNotice::Advanced(head)))
    }
}

impl Drop for CanonicalChangeSubscription {
    fn drop(&mut self) {
        self.store
            .inner
            .broadcast_hub
            .unregister_subscriber(self.sub_id);
    }
}

impl ChangeSubscription for CanonicalChangeSubscription {
    fn processed(&self) -> &ChangeCursor {
        &self.processed
    }

    fn next(&mut self) -> PortFuture<'_, Option<ChangeNotice>> {
        Box::pin(async move {
            if let Some(initial) = self.pending_initial.take() {
                return Ok(Some(initial));
            }

            // The broadcast ring is process-local. Check durable PostgreSQL state while
            // a consumer waits, even when other Spaces keep the local ring busy.
            loop {
                let signal = if self.store.is_postgres() {
                    tokio::select! {
                        biased;
                        () = tokio::time::sleep_until(self.next_durable_poll) => {
                            let notice = self.durable_notice(false).await?;
                            self.next_durable_poll = tokio::time::Instant::now() + PG_CHANGE_POLL_INTERVAL;
                            if notice.is_some() {
                                return Ok(notice);
                            }
                            continue;
                        }
                        signal = self.rx.recv() => signal,
                    }
                } else {
                    self.rx.recv().await
                };
                match signal {
                    Ok(BroadcastSignal::CatalogChanged { .. }) => continue,
                    Ok(BroadcastSignal::IncarnationChanged { new_scope, ceiling }) => {
                        if new_scope.space_id == self.processed.scope.space_id {
                            self.delivered_complete_command_end = ceiling;
                            return Ok(Some(ChangeNotice::Resync { scope: new_scope }));
                        }
                    }
                    Ok(BroadcastSignal::Purged {
                        scope,
                        purged_through_seq,
                        current_safe_cut,
                    }) => {
                        if scope.space_id != self.processed.scope.space_id {
                            continue;
                        }
                        if scope.incarnation != self.processed.scope.incarnation {
                            return Ok(Some(ChangeNotice::Resync { scope }));
                        }
                        if self.processed.after < purged_through_seq {
                            self.delivered_complete_command_end =
                                self.delivered_complete_command_end.max(current_safe_cut);
                            return Ok(Some(ChangeNotice::PurgeResync {
                                cutoff: ChangeCursor {
                                    scope,
                                    after: current_safe_cut,
                                },
                            }));
                        }
                    }
                    Ok(BroadcastSignal::Committed {
                        scope,
                        new_last_seq,
                    }) => {
                        if scope.space_id != self.processed.scope.space_id {
                            continue;
                        }
                        if scope.incarnation != self.processed.scope.incarnation {
                            return Ok(Some(ChangeNotice::Resync { scope }));
                        }
                        if new_last_seq > self.delivered_complete_command_end {
                            self.delivered_complete_command_end = new_last_seq;
                            return Ok(Some(ChangeNotice::Advanced(ChangeCursor {
                                scope,
                                after: new_last_seq,
                            })));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return self.durable_notice(true).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Ok(None);
                    }
                }
            }
        })
    }

    fn acknowledge(&mut self, processed: ChangeCursor) -> PortFuture<'_, ()> {
        Box::pin(async move {
            // 1. Must match subscription HistoryScope (Space + HistoryIncarnation).
            self.processed.scope.check(&processed.scope)?;

            // 2. Monotonicity: cannot move backwards.
            if processed.after < self.processed.after {
                return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
            }

            // 3. Cannot acknowledge beyond `delivered_complete_command_end`.
            if processed.after > self.delivered_complete_command_end {
                return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
            }

            // 4. Verify `processed.after` is `0` or an exact complete command-end (`change_commands.last_seq`).
            let scope_cl = processed.scope.clone();
            let target_seq = processed.after;
            self.store
                .with_read_tx(|tx| {
                    Box::pin(async move {
                        let _ =
                            validate_snapshot_cutoff_tx(tx, &scope_cl, Some(target_seq)).await?;
                        Ok(())
                    })
                })
                .await?;

            self.processed = processed.clone();
            self.store.inner.broadcast_hub.update_subscriber(
                self.sub_id,
                AcknowledgedCursor {
                    scope: processed.scope,
                    seq: processed.after,
                },
            );
            Ok(())
        })
    }
}

impl ChangeBroadcast for CanonicalStore {
    fn subscribe(
        &self,
        ctx: MaintenanceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn ChangeSubscription>> {
        let store = self.clone();
        Box::pin(async move {
            check_change_consumer_authority(&ctx.authority)?;

            // Subscribe to broadcast channel BEFORE reading DB state so zero post-read commits are missed!
            let rx = store.inner.broadcast_hub.subscribe_raw();
            let after_cl = after.clone();

            let (space_rec, has_erased) = store
                .with_read_tx_budget(Some(&ctx.budget), |tx| {
                    Box::pin(async move {
                        let rec = load_space_record(tx, &after_cl.scope.space_id).await?;
                        // History mismatch must yield `ChangeNotice::Resync` BEFORE comparing any SpaceSeq!
                        if rec.scope.incarnation != after_cl.scope.incarnation {
                            return Ok((rec, false));
                        }
                        if after_cl.after > SpaceSeq::ZERO {
                            let _ =
                                validate_snapshot_cutoff_tx(tx, &rec.scope, Some(after_cl.after))
                                    .await?;
                        }
                        let erased =
                            if after_cl.after > SpaceSeq::ZERO && rec.last_seq > after_cl.after {
                                has_erased_change_payload_in_range_tx(
                                    tx,
                                    &rec.scope,
                                    after_cl.after,
                                    rec.last_seq,
                                )
                                .await?
                            } else {
                                false
                            };
                        Ok((rec, erased))
                    })
                })
                .await?;

            let (pending_initial, delivered_end) =
                if space_rec.scope.incarnation != after.scope.incarnation {
                    (
                        Some(ChangeNotice::Resync {
                            scope: space_rec.scope.clone(),
                        }),
                        SpaceSeq::ZERO,
                    )
                } else if after.after == SpaceSeq::ZERO {
                    (
                        Some(ChangeNotice::SeedRequired {
                            cutoff: ChangeCursor {
                                scope: space_rec.scope.clone(),
                                after: space_rec.last_seq,
                            },
                        }),
                        space_rec.last_seq,
                    )
                } else if has_erased {
                    (
                        Some(ChangeNotice::PurgeResync {
                            cutoff: ChangeCursor {
                                scope: space_rec.scope.clone(),
                                after: space_rec.last_seq,
                            },
                        }),
                        space_rec.last_seq,
                    )
                } else if space_rec.last_seq > after.after {
                    (
                        Some(ChangeNotice::Advanced(ChangeCursor {
                            scope: space_rec.scope.clone(),
                            after: space_rec.last_seq,
                        })),
                        space_rec.last_seq,
                    )
                } else {
                    (None, after.after)
                };

            let sub_id = store
                .inner
                .broadcast_hub
                .register_subscriber(AcknowledgedCursor {
                    scope: after.scope.clone(),
                    seq: after.after,
                });

            Ok(Box::new(CanonicalChangeSubscription {
                store,
                sub_id,
                processed: after,
                delivered_complete_command_end: delivered_end,
                pending_initial,
                rx,
                next_durable_poll: tokio::time::Instant::now() + PG_CHANGE_POLL_INTERVAL,
                durable_checked_through: space_rec.last_seq,
            }) as Box<dyn ChangeSubscription>)
        })
    }

    fn catch_up(
        &self,
        ctx: MaintenanceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        let store = self.clone();
        Box::pin(async move {
            check_change_consumer_authority(&ctx.authority)?;
            store
                .execute_change_read(ChangeCaller::Maintenance(&ctx), request)
                .await
        })
    }
}

#[allow(dead_code)]
pub(crate) enum ChangeCaller<'a> {
    Maintenance(&'a MaintenanceContext),
    Space(&'a SpaceContext),
}

impl<'a> ChangeCaller<'a> {
    fn budget(&self) -> &'a notarium_core::ports::CallBudget {
        match self {
            Self::Maintenance(ctx) => &ctx.budget,
            Self::Space(ctx) => &ctx.budget,
        }
    }

    fn enforce_space_scope(&self, target_scope: &HistoryScope) -> DomainResult<()> {
        if let Self::Space(sctx) = self {
            if sctx.scope().space_id != target_scope.space_id {
                return Err(DomainError::ResourceNotFound);
            }
            sctx.scope().check(target_scope)?;
        }
        Ok(())
    }
}

impl CanonicalStore {
    pub fn subscribe_projection_catalog(
        &self,
        ctx: &MaintenanceContext,
    ) -> Result<ProjectionCatalogSubscription, PortError> {
        ctx.authority.require(ServicePurpose::Projection)?;
        Ok(ProjectionCatalogSubscription {
            receiver: self.inner.broadcast_hub.subscribe_raw(),
        })
    }

    #[cfg(feature = "test-support")]
    pub fn reconfigure_broadcast_capacity_for_test(&self, capacity: usize) {
        self.inner.broadcast_hub.reconfigure_capacity(capacity);
    }

    pub fn min_consumer_watermark(
        &self,
        space_id: &SpaceId,
        incarnation: &HistoryIncarnation,
    ) -> Option<SpaceSeq> {
        self.inner
            .broadcast_hub
            .min_acknowledged_watermark(space_id, incarnation)
    }

    /// Resolves `TrustedMutationEffect` facts from durable canonical `change_commands` and `change_payloads`
    /// for causal overlay planning (`notarium_core::receipt::plan_overlay`).
    pub async fn resolve_receipt_effects(
        &self,
        scope: &HistoryScope,
        receipts: &ReceiptSet,
    ) -> Result<Vec<TrustedMutationEffect>, PortError> {
        let relevant: Vec<MutationReceiptToken> =
            receipts.for_scope(scope)?.into_iter().cloned().collect();
        let scope_cl = scope.clone();

        self.with_read_tx(|tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                space_rec.scope.check(&scope_cl)?;

                let mut out = Vec::with_capacity(relevant.len());
                for token in relevant {
                    let (_, effect) = resolve_receipt_effect_tx(tx, &scope_cl, token.seq()).await?;
                    out.push(TrustedMutationEffect {
                        receipt: token,
                        effect,
                    });
                }
                Ok(out)
            })
        })
        .await
    }

    pub(crate) async fn execute_change_read(
        &self,
        caller: ChangeCaller<'_>,
        request: ChangeRead,
    ) -> Result<ChangeReadResult, PortError> {
        let budget = caller.budget();
        crate::domain::common::CommandDeadline::start(budget, "read_changes")
            .prepare(budget, || self.read_change_page(caller, request))
            .await
    }

    async fn read_change_page(
        &self,
        caller: ChangeCaller<'_>,
        request: ChangeRead,
    ) -> Result<ChangeReadResult, PortError> {
        match request {
            ChangeRead::Log {
                after,
                through,
                limit,
            } => {
                caller.enforce_space_scope(&after.scope)?;
                let page = self
                    .read_change_log_page(&caller, after, through, limit)
                    .await?;
                Ok(ChangeReadResult::Log(page))
            }
            ChangeRead::Seed {
                scope,
                cutoff,
                limit,
            } => {
                caller.enforce_space_scope(&scope)?;
                let seed = self
                    .read_seed_page(&caller, scope, cutoff, None, limit)
                    .await?;
                Ok(ChangeReadResult::Seed(seed))
            }
            ChangeRead::ContinueSeed { cursor } => {
                caller.enforce_space_scope(&cursor.cutoff.scope)?;
                let seed = self
                    .read_seed_page(
                        &caller,
                        cursor.cutoff.scope,
                        Some(cursor.cutoff.after),
                        Some(cursor.after),
                        cursor.limit,
                    )
                    .await?;
                Ok(ChangeReadResult::Seed(seed))
            }
        }
    }

    async fn read_change_log_page(
        &self,
        caller: &ChangeCaller<'_>,
        after: ChangeCursor,
        through: SpaceSeq,
        limit: PageLimit,
    ) -> Result<ChangePage, PortError> {
        let budget = caller.budget();
        let space_auth = match caller {
            ChangeCaller::Space(ctx) => Some(ctx.auth().clone()),
            ChangeCaller::Maintenance(_) => None,
        };

        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let space_rec = load_space_record(tx, &after.scope.space_id).await?;
                // History check BEFORE comparing any SpaceSeq!
                space_rec.scope.check(&after.scope)?;
                if space_auth.is_some()
                    && space_rec.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active
                {
                    return Err(DomainError::ResourceNotFound.into());
                }

                if after.after > space_rec.last_seq {
                    return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                }
                // `Log.through` MUST be `0` or an exact complete command-end (`change_commands.last_seq`), never mid-range!
                let validated_through =
                    validate_snapshot_cutoff_tx(tx, &after.scope, Some(through)).await?;
                if validated_through < after.after {
                    return Err(DomainError::validation(ValidationReason::InvalidRange).into());
                }

                if after.after == validated_through {
                    let safe_ack = last_complete_command_end_at_or_below_tx(
                        tx,
                        &after.scope,
                        after.after,
                    )
                    .await?;
                    return Ok(ChangePage {
                        changes: Vec::new(),
                        next: after,
                        safe_ack_end: safe_ack,
                        cutoff: validated_through,
                        complete: true,
                    });
                }

                // Fetch up to `limit + 1` rows so we know deterministically whether `complete` is true.
                let fetch_cap = i64::from(limit.get()) + 1;
                let after_i64 = after.after.get() as i64;
                let through_i64 = validated_through.get() as i64;

                let raw_rows: Vec<RawChangeLogRow> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let rows = sqlx::query(
                            "SELECT space_seq, command_first_seq, command_last_seq, entity_type,
                                    entity_id, op_kind, rev_id, lifecycle_state, doc_class, payload_id
                             FROM change_log
                             WHERE space_id = ? AND history_incarnation = ?
                               AND space_seq > ? AND space_seq <= ?
                             ORDER BY space_seq ASC
                             LIMIT ?",
                        )
                        .bind(after.scope.space_id.as_str())
                        .bind(after.scope.incarnation.as_bytes().as_slice())
                        .bind(after_i64)
                        .bind(through_i64)
                        .bind(fetch_cap)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_read_change_log", err.to_string())
                        })?;

                        rows.into_iter()
                            .map(|r| RawChangeLogRow {
                                space_seq: r.get("space_seq"),
                                command_first_seq: r.get("command_first_seq"),
                                command_last_seq: r.get("command_last_seq"),
                                entity_type: r.get("entity_type"),
                                entity_id: r.get("entity_id"),
                                op_kind: r.get("op_kind"),
                                rev_id: r.get("rev_id"),
                                lifecycle_state: r.get("lifecycle_state"),
                                doc_class: r.get("doc_class"),
                                payload_id: r.get("payload_id"),
                            })
                            .collect()
                    }
                    BackendConn::Postgres(conn) => {
                        let rows = sqlx::query(
                            "SELECT space_seq, command_first_seq, command_last_seq, entity_type,
                                    entity_id, op_kind, rev_id, lifecycle_state, doc_class, payload_id
                             FROM change_log
                             WHERE space_id = $1 AND history_incarnation = $2
                               AND space_seq > $3 AND space_seq <= $4
                             ORDER BY space_seq ASC
                             LIMIT $5",
                        )
                        .bind(after.scope.space_id.as_str())
                        .bind(after.scope.incarnation.as_bytes().as_slice())
                        .bind(after_i64)
                        .bind(through_i64)
                        .bind(fetch_cap)
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            crate::runtime::pg_read_error("pg_read_change_log", err)
                        })?;

                        rows.into_iter()
                            .map(|r| RawChangeLogRow {
                                space_seq: r.get("space_seq"),
                                command_first_seq: r.get("command_first_seq"),
                                command_last_seq: r.get("command_last_seq"),
                                entity_type: r.get("entity_type"),
                                entity_id: r.get("entity_id"),
                                op_kind: r.get("op_kind"),
                                rev_id: r.get("rev_id"),
                                lifecycle_state: r.get("lifecycle_state"),
                                doc_class: r.get("doc_class"),
                                payload_id: r.get("payload_id"),
                            })
                            .collect()
                    }
                };

                let has_more = raw_rows.len() > usize::from(limit.get());
                let page_rows = if has_more {
                    &raw_rows[..usize::from(limit.get())]
                } else {
                    &raw_rows[..]
                };

                let mut access = space_auth.as_ref().map(|auth|
                    crate::domain::change_visibility::ChangeVisibility::new(&space_rec, auth));
                let mut payload_cache: HashMap<String, MutationEffect> = HashMap::new();
                let mut changes = Vec::with_capacity(page_rows.len());
                let mut latest_complete_in_page: Option<SpaceSeq> = None;

                for row in page_rows {
                    let seq = i64_to_space_seq(row.space_seq)?;
                    let first_seq = i64_to_space_seq(row.command_first_seq)?;
                    let last_seq = i64_to_space_seq(row.command_last_seq)?;
                    let command_range = CommandSeqRange::new(first_seq, last_seq)?;

                    if seq == last_seq {
                        latest_complete_in_page = Some(seq);
                    }

                    let entity = parse_change_entity(&row.entity_type, &row.entity_id)?;
                    let kind = parse_change_kind(&row.op_kind)?;
                    let revision = RevisionId::parse(&row.rev_id).map_err(|_| {
                        internal_not_committed("corrupt_change_rev", "invalid rev_id in change_log")
                    })?;
                    let lifecycle = lifecycle_from_db(&row.lifecycle_state)?;
                    let class = match &row.doc_class {
                        Some(s) => Some(doc_class_from_db(s)?),
                        None => None,
                    };

                    let effect = match &row.payload_id {
                        None => default_effect_for_op(&row.op_kind),
                        Some(pid) => {
                            if let Some(cached) = payload_cache.get(pid) {
                                cached.clone()
                            } else {
                                let loaded =
                                    load_decoded_effect_tx(tx, &after.scope, pid, command_range, None).await?;
                                payload_cache.insert(pid.clone(), loaded.clone());
                                loaded
                            }
                        }
                    };

                    let mut change = Change {
                        cursor: ChangeCursor {
                            scope: after.scope.clone(),
                            after: seq,
                        },
                        command_range,
                        entity,
                        kind,
                        revision,
                        lifecycle,
                        class,
                        effect,
                    };
                    if let Some(access) = &mut access && !access.filter(tx, &mut change).await? {
                        continue;
                    }
                    changes.push(change);
                }

                let complete = !has_more;
                let next_seq = if complete {
                    validated_through
                } else {
                    i64_to_space_seq(page_rows.last().expect("nonempty limited page").space_seq)?
                };

                let safe_ack_end = match latest_complete_in_page {
                    Some(end_seq) => end_seq,
                    None => {
                        last_complete_command_end_at_or_below_tx(tx, &after.scope, next_seq).await?
                    }
                };

                Ok(ChangePage {
                    changes,
                    next: ChangeCursor {
                        scope: after.scope,
                        after: next_seq,
                    },
                    safe_ack_end,
                    cutoff: validated_through,
                    complete,
                })
            })
        })
        .await
    }

    async fn read_seed_page(
        &self,
        caller: &ChangeCaller<'_>,
        scope: HistoryScope,
        requested_cutoff: Option<SpaceSeq>,
        resume_after: Option<SeedPosition>,
        limit: PageLimit,
    ) -> Result<ChangeSeed, PortError> {
        let budget = caller.budget();
        let space_auth = match caller {
            ChangeCaller::Space(sctx) => Some(sctx.auth().clone()),
            ChangeCaller::Maintenance(_) => None,
        };
        let store_cl = self.clone();

        // Execute metadata/revision/fence scan inside bounded short read transaction;
        // then load immutable verified CAS blobs outside SQL lock!
        let (pinned_cutoff, note_items, thread_items, next_cursor) = self
            .with_read_tx_budget(Some(budget), |tx| {
                let scope_in = scope.clone();
                let auth_in = space_auth.clone();
                Box::pin(async move {
                    let space_rec = load_space_record(tx, &scope_in.space_id).await?;
                    space_rec.scope.check(&scope_in)?;
                    if auth_in.is_some()
                        && space_rec.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }

                    let valid_cutoff =
                        validate_snapshot_cutoff_tx(tx, &scope_in, requested_cutoff).await?;
                    let pinned = ChangeCursor {
                        scope: scope_in.clone(),
                        after: valid_cutoff,
                    };

                    if valid_cutoff == SpaceSeq::ZERO {
                        return Ok((pinned, Vec::new(), Vec::new(), None));
                    }

                    // If any note that existed at or before `valid_cutoff` was purged AFTER `valid_cutoff`,
                    // this seed cursor/cut is stale regardless of retention!
                    if has_post_cutoff_purge_of_prior_note_tx(
                        tx,
                        &scope_in,
                        valid_cutoff,
                        space_rec.last_seq,
                    )
                    .await?
                    {
                        return Err(DomainError::validation(ValidationReason::CursorStale).into());
                    }

                    let max_items = usize::from(limit.get());
                    let mut collected_notes: Vec<PendingSeedNote> = Vec::new();
                    let mut collected_threads: Vec<ChatThread> = Vec::new();

                    let (in_notes_phase, mut note_cursor_after, mut thread_cursor_after) =
                        match resume_after {
                            None => (true, None, None),
                            Some(SeedPosition::NotesAfter(nid)) => {
                                (true, Some(nid.as_str().to_owned()), None)
                            }
                            Some(SeedPosition::ThreadsAfter(tid)) => {
                                (false, None, Some(tid.as_str().to_owned()))
                            }
                        };

                    let mut next_seed_pos: Option<SeedPosition> = None;
                    let mut folder_cache = crate::domain::common::FolderAncestryCache::default();
                    let mut historical =
                        crate::domain::common::FolderAncestryCache::at_cut(&scope_in, valid_cutoff);

                    if in_notes_phase {
                        let batch_size = (max_items + 16) as i64;
                        'notes_scan: loop {
                            let candidates = list_note_keys_at_or_below_cutoff_tx(
                                tx,
                                &scope_in,
                                valid_cutoff,
                                note_cursor_after.as_deref(),
                                batch_size,
                            )
                            .await?;
                            if candidates.is_empty() {
                                break 'notes_scan;
                            }

                            for note_key in &candidates {
                                note_cursor_after = Some(note_key.clone());

                                // Skip notes already purged at or before `valid_cutoff`.
                                if crate::runtime::is_note_purge_fenced_tx(
                                    tx,
                                    &scope_in.space_id,
                                    note_key,
                                )
                                .await?
                                {
                                    continue;
                                }

                                // Load immutable revision at `valid_cutoff`; missing retained version => CursorStale!
                                let Some(rev_rec) = read_immutable_revision_tx(
                                    tx,
                                    &scope_in,
                                    "note",
                                    note_key,
                                    valid_cutoff,
                                )
                                .await?
                                else {
                                    return Err(DomainError::validation(
                                        ValidationReason::CursorStale,
                                    )
                                    .into());
                                };

                                let RevisionMetadataPayload::Note(note_meta) =
                                    rev_rec.metadata.payload
                                else {
                                    return Err(internal_not_committed(
                                        "corrupt_seed_note_meta",
                                        "non-note metadata on note revision",
                                    ));
                                };

                                if note_meta.lifecycle == Lifecycle::Purged {
                                    continue;
                                }

                                // Current live fence check: if currently purged -> CursorStale;
                                // if SpaceContext caller, enforce BOTH current live fence AND snapshot facts!
                                let Some((live_facts, _)) = folder_cache
                                    .live_note_facts(
                                        tx,
                                        &space_rec.space,
                                        &note_meta.note_id,
                                        false,
                                    )
                                    .await?
                                else {
                                    return Err(DomainError::validation(
                                        ValidationReason::CursorStale,
                                    )
                                    .into());
                                };
                                let (snap_facts, _) = historical
                                    .build_resource_facts_tx(
                                        tx,
                                        &space_rec.space,
                                        &note_meta.parent_folder_id,
                                        note_meta.doc_class,
                                        note_meta.ability_id.clone(),
                                        false,
                                    )
                                    .await?;

                                if let Some(auth) = &auth_in
                                    && (auth.authorize_read(&live_facts).is_err()
                                        || auth.authorize_read(&snap_facts).is_err())
                                {
                                    continue;
                                }

                                if collected_notes.len() == max_items {
                                    let last_id = collected_notes
                                        .last()
                                        .expect("non-empty notes")
                                        .note_id
                                        .clone();
                                    next_seed_pos = Some(SeedPosition::NotesAfter(last_id));
                                    break 'notes_scan;
                                }

                                let digest = note_meta
                                    .content_digest
                                    .or(rev_rec.content_digest)
                                    .ok_or_else(|| {
                                        DomainError::validation(ValidationReason::CursorStale)
                                    })?;

                                collected_notes.push(PendingSeedNote {
                                    note_id: note_meta.note_id.clone(),
                                    revision_id: rev_rec.revision_id,
                                    parent: (note_meta.parent_folder_id
                                        != space_rec.root_folder_id)
                                        .then(|| note_meta.parent_folder_id.clone()),
                                    facts: snap_facts,
                                    meta: note_meta,
                                    digest,
                                });
                            }
                            if (candidates.len() as i64) < batch_size {
                                break 'notes_scan;
                            }
                        }
                    }

                    // Only an authorized next row warrants a continuation, including
                    // at the boundary between the note and thread phases.
                    let remaining_slots = max_items - collected_notes.len();
                    if next_seed_pos.is_none() {
                        let batch_size = (remaining_slots + 16) as i64;
                        'threads_scan: loop {
                            let candidates = list_thread_keys_at_or_below_cutoff_tx(
                                tx,
                                &scope_in,
                                valid_cutoff,
                                thread_cursor_after.as_deref(),
                                batch_size,
                            )
                            .await?;
                            if candidates.is_empty() {
                                break 'threads_scan;
                            }

                            for thread_key in &candidates {
                                thread_cursor_after = Some(thread_key.clone());

                                let Some(rev_rec) = read_immutable_revision_tx(
                                    tx,
                                    &scope_in,
                                    "thread",
                                    thread_key,
                                    valid_cutoff,
                                )
                                .await?
                                else {
                                    return Err(DomainError::validation(
                                        ValidationReason::CursorStale,
                                    )
                                    .into());
                                };

                                let RevisionMetadataPayload::Thread(ThreadRevisionMetadata {
                                    thread_id,
                                    kind,
                                    owner_id,
                                    project_folder_id,
                                    title: _,
                                    head_leaf_seq,
                                    tainted,
                                }) = rev_rec.metadata.payload
                                else {
                                    return Err(internal_not_committed(
                                        "corrupt_seed_thread_meta",
                                        "non-thread metadata on thread revision",
                                    ));
                                };

                                if let Some(auth) = &auth_in
                                    && (crate::domain::change_visibility::authorize_thread_owner(
                                        auth, kind, &owner_id,
                                    )
                                    .is_err()
                                        || auth
                                            .authorize_chat_read(
                                                &space_rec.space,
                                                project_folder_id.as_ref(),
                                                tainted,
                                            )
                                            .is_err())
                                {
                                    continue;
                                }

                                if collected_threads.len() == remaining_slots {
                                    next_seed_pos = collected_threads
                                        .last()
                                        .map(|thread| SeedPosition::ThreadsAfter(thread.id.clone()))
                                        .or_else(|| {
                                            collected_notes.last().map(|note| {
                                                SeedPosition::NotesAfter(note.note_id.clone())
                                            })
                                        });
                                    break 'threads_scan;
                                }
                                collected_threads.push(ChatThread {
                                    id: thread_id,
                                    space: scope_in.space_id.clone(),
                                    kind,
                                    owner: owner_id,
                                    project_folder: project_folder_id,
                                    head: head_leaf_seq,
                                    revision: rev_rec.revision_id,
                                    tainted,
                                });
                            }

                            if (candidates.len() as i64) < batch_size {
                                break 'threads_scan;
                            }
                        }
                    }

                    let next = next_seed_pos.map(|after| SeedCursor {
                        cutoff: pinned.clone(),
                        after,
                        limit,
                    });

                    Ok((pinned, collected_notes, collected_threads, next))
                })
            })
            .await?;

        // Hydrate verified CAS carriers outside the SQL read transaction!
        let mut hydrated_notes = Vec::with_capacity(note_items.len());
        for pending in note_items {
            let raw_bytes = match store_cl
                .read_verified_blob(&pinned_cutoff.scope, pending.digest)
                .await
            {
                Ok(b) => b,
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                    return Err(DomainError::validation(ValidationReason::CursorStale).into());
                }
                Err(other) => return Err(other),
            };
            let carrier = String::from_utf8(raw_bytes).map_err(|_| {
                internal_not_committed("corrupt_utf8_note_blob", "note CAS blob is not UTF-8")
            })?;

            let doc = ClassifiedDocument::from_canonical(
                NoteRef {
                    space_id: pinned_cutoff.scope.space_id.clone(),
                    note_id: pending.note_id,
                },
                pending.revision_id,
                pending.facts,
                pending.meta.lifecycle,
                carrier,
                pending.digest,
            )?;

            hydrated_notes.push(NoteSnapshot {
                document: doc,
                parent: pending.parent,
                byte_size: pending.meta.byte_size,
                fields: pending.meta.evaluated_fields,
                diagnostics: pending.meta.diagnostics,
            });
        }

        let cutoff = pinned_cutoff.clone();
        self.with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &cutoff.scope.space_id).await?;
                space.scope.check(&cutoff.scope)?;
                if space_auth.is_some()
                    && space.space.lifecycle != notarium_core::auth::SpaceLifecycle::Active
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if has_post_cutoff_purge_of_prior_note_tx(
                    tx,
                    &cutoff.scope,
                    cutoff.after,
                    space.last_seq,
                )
                .await?
                {
                    return Err(DomainError::validation(ValidationReason::CursorStale).into());
                }
                let mut current = crate::domain::common::FolderAncestryCache::default();
                for note in &mut hydrated_notes {
                    let (facts, lifecycle) = current
                        .live_note_facts(
                            tx,
                            &space.space,
                            &note.document.reference().note_id,
                            false,
                        )
                        .await?
                        .ok_or_else(|| DomainError::validation(ValidationReason::CursorStale))?;
                    if let Some(auth) = &space_auth {
                        auth.authorize_read(&facts)?;
                    }
                    note.document.bind_current(facts, lifecycle)?;
                }
                if let Some(auth) = &space_auth {
                    for thread in &thread_items {
                        let (project, tainted) = crate::domain::lookup_thread_visibility_tx(
                            tx,
                            &space.space.id,
                            thread.id.as_str(),
                        )
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                        auth.authorize_chat_read(&space.space, project.as_ref(), tainted)?;
                    }
                }
                Ok(ChangeSeed {
                    notes: hydrated_notes,
                    threads: thread_items,
                    cutoff: pinned_cutoff,
                    next: next_cursor,
                })
            })
        })
        .await
    }
}

struct PendingSeedNote {
    parent: Option<FolderId>,
    note_id: NoteId,
    revision_id: RevisionId,
    facts: ResourceFacts,
    meta: NoteRevisionMetadata,
    digest: ContentDigest,
}

struct RawChangeLogRow {
    space_seq: i64,
    command_first_seq: i64,
    command_last_seq: i64,
    entity_type: String,
    entity_id: String,
    op_kind: String,
    rev_id: String,
    lifecycle_state: String,
    doc_class: Option<String>,
    payload_id: Option<String>,
}

fn parse_change_entity(entity_type: &str, entity_id: &str) -> Result<EntityId, PortError> {
    match entity_type {
        "note" => Ok(EntityId::Note(NoteId::parse(entity_id).map_err(|_| {
            internal_not_committed("corrupt_change_note_id", "invalid NoteId in change_log")
        })?)),
        "folder" => Ok(EntityId::Folder(FolderId::parse(entity_id).map_err(
            |_| internal_not_committed("corrupt_change_folder_id", "invalid FolderId"),
        )?)),
        "thread" => Ok(EntityId::Thread(ChatThreadId::parse(entity_id).map_err(
            |_| internal_not_committed("corrupt_change_thread_id", "invalid ChatThreadId"),
        )?)),
        "job" => Ok(EntityId::Job(JobId::parse(entity_id).map_err(|_| {
            internal_not_committed("corrupt_change_job_id", "invalid JobId")
        })?)),
        "ability" => Ok(EntityId::Ability(AbilityId::parse(entity_id).map_err(
            |_| internal_not_committed("corrupt_change_ability_id", "invalid AbilityId"),
        )?)),
        other => Err(internal_not_committed(
            "corrupt_change_entity_type",
            format!("unexpected entity_type '{other}'"),
        )),
    }
}

fn parse_change_kind(op_kind: &str) -> Result<ChangeKind, PortError> {
    match op_kind {
        "create" => Ok(ChangeKind::Create),
        "edit" => Ok(ChangeKind::Edit),
        "move" => Ok(ChangeKind::Move),
        "rename" => Ok(ChangeKind::Rename),
        "trash" => Ok(ChangeKind::Trash),
        "restore" => Ok(ChangeKind::Restore),
        "purge" => Ok(ChangeKind::Purge),
        "redact" => Ok(ChangeKind::Redact),
        other => Err(internal_not_committed(
            "corrupt_change_op_kind",
            format!("unexpected op_kind '{other}'"),
        )),
    }
}

fn default_effect_for_op(op_kind: &str) -> MutationEffect {
    match op_kind {
        "purge" | "move" | "rename" => MutationEffect::AwaitProjection {
            reason: AwaitReason::Structural,
        },
        _ => MutationEffect::NoRelevantEffect,
    }
}

fn default_effect_without_payload(command_kind: &str) -> MutationEffect {
    match command_kind {
        "move_folder" | "rename_folder" | "rename_project" | "purge_note" | "mint_and_purge" => {
            MutationEffect::AwaitProjection {
                reason: AwaitReason::Structural,
            }
        }
        "rollback_agent_run" => MutationEffect::AwaitProjection {
            reason: AwaitReason::Bulk,
        },
        _ => MutationEffect::NoRelevantEffect,
    }
}

async fn load_decoded_effect_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    payload_id: &str,
    command_range: CommandSeqRange,
    command_kind: Option<&str>,
) -> Result<MutationEffect, PortError> {
    let space_id = &scope.space_id;
    let raw: Option<(String, i32, Option<Vec<u8>>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT codec, erased_by_purge, effect_msgpack FROM change_payloads
                 WHERE space_id = ? AND payload_id = ?",
            )
            .bind(space_id.as_str())
            .bind(payload_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_change_pay", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("codec"),
                    row.get::<i64, _>("erased_by_purge") as i32,
                    row.get("effect_msgpack"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT codec, erased_by_purge, effect_msgpack FROM change_payloads
                 WHERE space_id = $1 AND payload_id = $2",
            )
            .bind(space_id.as_str())
            .bind(payload_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_change_pay", err))?;
            r.map(|row| {
                (
                    row.get("codec"),
                    row.get("erased_by_purge"),
                    row.get("effect_msgpack"),
                )
            })
        }
    };

    let Some((codec, erased, bytes_opt)) = raw else {
        return Err(internal_not_committed(
            "missing_change_payload",
            format!("change_payload '{payload_id}' missing"),
        ));
    };

    // Erased payload => mandatory `PurgeResync` with zero sequence holes in `change_log`!
    if erased != 0 {
        return Err(DomainError::validation(ValidationReason::PurgeResync).into());
    }
    let Some(bytes) = bytes_opt else {
        return Err(DomainError::validation(ValidationReason::PurgeResync).into());
    };

    if codec != EFFECT_CODEC_V1 {
        return Err(internal_not_committed(
            "unexpected_change_payload_codec",
            format!("expected {EFFECT_CODEC_V1}, got {codec}"),
        ));
    }

    let env = EffectEnvelopeV1::decode(&bytes)?;
    // Restores rebind the enclosing journal to a new history without rewriting
    // preserved immutable payloads. The command lookup already checks that history.
    if env.scope.space_id != scope.space_id
        || env.command_range != command_range
        || command_kind.is_some_and(|kind| kind != env.command_kind)
    {
        return Err(internal_not_committed(
            "corrupt_change_payload_scope",
            "change effect does not match its command",
        ));
    }
    Ok(env.to_mutation_effect(bytes.len()))
}

pub(crate) async fn resolve_receipt_effect_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    command_end: SpaceSeq,
) -> Result<(Option<String>, MutationEffect), PortError> {
    let seq_i64 = command_end.get() as i64;
    let cmd_row: Option<(String, i64, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT command_kind, first_seq, payload_id FROM change_commands
                 WHERE space_id = ? AND history_incarnation = ? AND last_seq = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(seq_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_resolve_rcpt_cmd", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("command_kind"),
                    row.get("first_seq"),
                    row.get("payload_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT command_kind, first_seq, payload_id FROM change_commands
                 WHERE space_id = $1 AND history_incarnation = $2 AND last_seq = $3",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(seq_i64)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_resolve_rcpt_cmd", err))?;
            r.map(|row| {
                (
                    row.get("command_kind"),
                    row.get("first_seq"),
                    row.get("payload_id"),
                )
            })
        }
    };

    let Some((command_kind, first_seq, payload_id_opt)) = cmd_row else {
        return Ok((
            None,
            MutationEffect::AwaitProjection {
                reason: AwaitReason::UnknownEffect,
            },
        ));
    };

    let range = CommandSeqRange::new(i64_to_space_seq(first_seq)?, command_end)?;
    let effect = match payload_id_opt {
        None => default_effect_without_payload(&command_kind),
        Some(pid) => {
            match load_decoded_effect_tx(tx, scope, &pid, range, Some(&command_kind)).await {
                Ok(eff) => {
                    verify_overlay_versions_retained_tx(tx, scope, command_end, &command_kind, eff)
                        .await?
                }
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::PurgeResync =>
                {
                    MutationEffect::AwaitProjection {
                        reason: AwaitReason::UnavailableVersion,
                    }
                }
                Err(other) => return Err(other),
            }
        }
    };

    Ok((Some(command_kind), effect))
}

async fn verify_overlay_versions_retained_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    command_end_seq: SpaceSeq,
    command_kind: &str,
    effect: MutationEffect,
) -> Result<MutationEffect, PortError> {
    let MutationEffect::Notes {
        versions,
        payload_bytes,
    } = effect
    else {
        return Ok(effect);
    };

    if command_kind == "move_board_card" {
        // Each affected card has one rank event. An overlay requires every exact rank
        // revision retained at this cut, including materialized and rebalanced neighbors.
        let count: i64 = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query_scalar(
                    "SELECT count(*) FROM change_commands c JOIN change_log e
                 ON e.space_id=c.space_id AND e.space_seq BETWEEN c.first_seq AND c.last_seq
                 JOIN revisions r ON r.space_id=e.space_id AND r.rev_id=e.rev_id
                 WHERE c.space_id=? AND c.history_incarnation=? AND c.last_seq=?
                   AND e.op_kind='move' AND r.entity_type='rank' AND r.visibility_seq=c.last_seq",
                )
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(command_end_seq.get() as i64)
                .fetch_one(&mut **conn)
                .await
            }
            BackendConn::Postgres(conn) => {
                sqlx::query_scalar(
                    "SELECT count(*) FROM change_commands c JOIN change_log e
                 ON e.space_id=c.space_id AND e.space_seq BETWEEN c.first_seq AND c.last_seq
                 JOIN revisions r ON r.space_id=e.space_id AND r.rev_id=e.rev_id
                 WHERE c.space_id=$1 AND c.history_incarnation=$2 AND c.last_seq=$3
                   AND e.op_kind='move' AND r.entity_type='rank' AND r.visibility_seq=c.last_seq",
                )
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(command_end_seq.get() as i64)
                .fetch_one(&mut **conn)
                .await
            }
        }
        .map_err(|err| crate::runtime::pg_read_error("read_retained_board_ranks", err))?;
        if count != versions.len() as i64 {
            return Ok(MutationEffect::AwaitProjection {
                reason: AwaitReason::UnavailableVersion,
            });
        }
    }
    for ver in &versions {
        if crate::runtime::is_note_purge_fenced_tx(tx, &scope.space_id, ver.note_id.as_str())
            .await?
        {
            return Ok(MutationEffect::AwaitProjection {
                reason: AwaitReason::UnavailableVersion,
            });
        }
        let exists: Option<i64> = match tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar(
                "SELECT 1 FROM revisions
                 WHERE space_id = ? AND history_incarnation = ?
                   AND entity_type = 'note' AND entity_key = ? AND rev_id = ?
                 LIMIT 1",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(ver.note_id.as_str())
            .bind(ver.revision.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_overlay_rev", err.to_string()))?,
            BackendConn::Postgres(conn) => sqlx::query_scalar(
                "SELECT 1::BIGINT FROM revisions
                 WHERE space_id = $1 AND history_incarnation = $2
                   AND entity_type = 'note' AND entity_key = $3 AND rev_id = $4
                 LIMIT 1",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(ver.note_id.as_str())
            .bind(ver.revision.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_check_overlay_rev", err))?,
        };
        if exists.is_none() {
            return Ok(MutationEffect::AwaitProjection {
                reason: AwaitReason::UnavailableVersion,
            });
        }
    }

    Ok(MutationEffect::Notes {
        versions,
        payload_bytes,
    })
}

async fn last_complete_command_end_at_or_below_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    at_or_below: SpaceSeq,
) -> Result<SpaceSeq, PortError> {
    if at_or_below == SpaceSeq::ZERO {
        return Ok(SpaceSeq::ZERO);
    }
    let bound_i64 = at_or_below.get() as i64;
    let raw_max: i64 = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT COALESCE(MAX(last_seq), 0) FROM change_commands
             WHERE space_id = ? AND history_incarnation = ? AND last_seq <= ?",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(bound_i64)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_max_complete_cmd", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT COALESCE(MAX(last_seq), 0)::BIGINT FROM change_commands
             WHERE space_id = $1 AND history_incarnation = $2 AND last_seq <= $3",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(bound_i64)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_max_complete_cmd", err))?,
    };
    Ok(i64_to_space_seq(raw_max)?)
}

async fn has_erased_change_payload_in_range_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    after_seq: SpaceSeq,
    through_seq: SpaceSeq,
) -> Result<bool, PortError> {
    let after_i64 = after_seq.get() as i64;
    let through_i64 = through_seq.get() as i64;
    let found: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT 1 FROM change_commands cc
             INNER JOIN change_payloads cp
               ON cp.space_id = cc.space_id AND cp.payload_id = cc.payload_id
             WHERE cc.space_id = ? AND cc.history_incarnation = ?
               AND cc.last_seq > ? AND cc.first_seq <= ?
               AND cp.erased_by_purge = 1
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(after_i64)
        .bind(through_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_erased_range", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT 1::BIGINT FROM change_commands cc
             INNER JOIN change_payloads cp
               ON cp.space_id = cc.space_id AND cp.payload_id = cc.payload_id
             WHERE cc.space_id = $1 AND cc.history_incarnation = $2
               AND cc.last_seq > $3 AND cc.first_seq <= $4
               AND cp.erased_by_purge = 1
             LIMIT 1",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(after_i64)
        .bind(through_i64)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_check_erased_range", err))?,
    };
    Ok(found.is_some())
}

pub(crate) async fn has_post_cutoff_purge_of_prior_note_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    valid_cutoff: SpaceSeq,
    snapshot_head: SpaceSeq,
) -> Result<bool, PortError> {
    if valid_cutoff == snapshot_head {
        return Ok(false);
    }
    // Even a purged identity retains its head and original creation sequence.
    const STALE: &str = "SELECT EXISTS (
        SELECT 1 FROM revision_purge_fences f
        WHERE f.space_id = $1 AND f.history_incarnation = $2 AND f.purge_seq > $3
          AND (SELECT n.created_seq FROM note_heads n
               WHERE n.space_id = f.space_id AND n.note_id = f.note_id) <= $3
    )";
    let cut = valid_cutoff.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(STALE)
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(cut)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_check_post_cutoff_purge", err.to_string())
            }),
        BackendConn::Postgres(conn) => sqlx::query_scalar(STALE)
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(cut)
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_check_post_cutoff_purge", err)),
    }
}

async fn list_note_keys_at_or_below_cutoff_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    after_key: Option<&str>,
    limit: i64,
) -> Result<Vec<String>, PortError> {
    // The enclosing snapshot has checked the space incarnation. Head identity and
    // creation sequence survive edits, trash and purge; revisions supply the state at the cut.
    const PAGE: &str = "SELECT note_id FROM note_heads
        WHERE space_id = $1 AND note_id > $2 AND created_seq <= $3
        ORDER BY note_id LIMIT $4";
    let after = after_key.unwrap_or(""); // All NoteIds are nonempty.
    let cut = cutoff.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(PAGE)
            .bind(scope.space_id.as_str())
            .bind(after)
            .bind(cut)
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_seed_note_keys", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_scalar(PAGE)
            .bind(scope.space_id.as_str())
            .bind(after)
            .bind(cut)
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_seed_note_keys", err)),
    }
}

pub(crate) async fn list_thread_keys_at_or_below_cutoff_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    after_key: Option<&str>,
    limit: i64,
) -> Result<Vec<String>, PortError> {
    const PAGE: &str = "SELECT thread_id FROM chat_threads
        WHERE space_id = $1 AND thread_id > $2 AND created_seq <= $3 AND history_incarnation = $4
        ORDER BY thread_id LIMIT $5";
    let after = after_key.unwrap_or(""); // All ChatThreadIds are nonempty.
    let cut = cutoff.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(PAGE)
            .bind(scope.space_id.as_str())
            .bind(after)
            .bind(cut)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_seed_thread_keys", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_scalar(PAGE)
            .bind(scope.space_id.as_str())
            .bind(after)
            .bind(cut)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_seed_thread_keys", err)),
    }
}

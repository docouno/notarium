use super::ControlService;
use crate::{
    auth::token::random,
    error::{invalid, unavailable},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::{RevocationEventsRow, TargetRecord},
    },
};
use notarium_core::{
    error::{CommitEffect, PortError, ValidationReason},
    ids::RequestId,
    ports::*,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const MAX_TRACKED_DELIVERED_EVENTS: usize = 16_384;
const BACKGROUND_REVOKE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct DeliveryState {
    pending_ack: HashSet<RequestId>,
    delivered: HashSet<RequestId>,
    order: VecDeque<RequestId>,
    next_token: u64,
    in_flight: HashMap<RequestId, (u64, watch::Receiver<bool>)>,
}

impl DeliveryState {
    fn is_delivered(&self, id: &RequestId) -> bool {
        self.pending_ack.contains(id) || self.delivered.contains(id)
    }

    fn record_delivered(&mut self, id: RequestId) {
        if !self.delivered.contains(&id) {
            self.pending_ack.insert(id);
        }
    }

    fn mark_acked(&mut self, id: &RequestId) {
        self.pending_ack.remove(id);
        if self.delivered.insert(id.clone()) {
            self.order.push_back(id.clone());
            while self.order.len() > MAX_TRACKED_DELIVERED_EVENTS {
                if let Some(oldest) = self.order.pop_front() {
                    self.delivered.remove(&oldest);
                }
            }
        }
    }
}

#[derive(Default)]
pub(super) struct RevocationDeliveryTracker {
    state: Mutex<DeliveryState>,
}

enum DeliverySlot<'a> {
    AlreadyDelivered,
    Claimed(InFlightGuard<'a>),
}

struct InFlightGuard<'a> {
    tracker: &'a RevocationDeliveryTracker,
    id: RequestId,
    token: u64,
    done: watch::Sender<bool>,
    delivered: bool,
}

impl InFlightGuard<'_> {
    fn mark_delivered(mut self) {
        self.delivered = true;
    }
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        let mut state = self
            .tracker
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if self.delivered {
            state.record_delivered(self.id.clone());
        }
        if state
            .in_flight
            .get(&self.id)
            .is_some_and(|(token, _)| *token == self.token)
        {
            state.in_flight.remove(&self.id);
        }
        drop(state);
        let _ = self.done.send(true);
    }
}

struct OwnedInFlightGuard {
    tracker: Arc<RevocationDeliveryTracker>,
    id: RequestId,
    token: u64,
    done: watch::Sender<bool>,
    delivered: bool,
}

impl OwnedInFlightGuard {
    fn mark_delivered(&mut self) {
        self.delivered = true;
    }
}

impl Drop for OwnedInFlightGuard {
    fn drop(&mut self) {
        let mut state = self
            .tracker
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if self.delivered {
            state.record_delivered(self.id.clone());
        }
        if state
            .in_flight
            .get(&self.id)
            .is_some_and(|(token, _)| *token == self.token)
        {
            state.in_flight.remove(&self.id);
        }
        drop(state);
        let _ = self.done.send(true);
    }
}

impl RevocationDeliveryTracker {
    fn is_delivered(&self, id: &RequestId) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_delivered(id)
    }

    fn mark_acked(&self, id: &RequestId) {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .mark_acked(id);
    }

    async fn begin_owned(self: &Arc<Self>, id: RequestId) -> Option<OwnedInFlightGuard> {
        loop {
            let mut waiter = {
                let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
                if state.is_delivered(&id) {
                    return None;
                }
                if let Some((_, existing)) = state.in_flight.get(&id) {
                    existing.clone()
                } else {
                    state.next_token = state.next_token.wrapping_add(1);
                    let token = state.next_token;
                    let (done, rx) = watch::channel(false);
                    state.in_flight.insert(id.clone(), (token, rx));
                    return Some(OwnedInFlightGuard {
                        tracker: Arc::clone(self),
                        id,
                        token,
                        done,
                        delivered: false,
                    });
                }
            };
            let _ = waiter.wait_for(|&done| done).await;
        }
    }

    async fn begin<'a>(&'a self, id: &RequestId) -> DeliverySlot<'a> {
        loop {
            let mut waiter = {
                let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
                if state.is_delivered(id) {
                    return DeliverySlot::AlreadyDelivered;
                }
                if let Some((_, existing)) = state.in_flight.get(id) {
                    existing.clone()
                } else {
                    state.next_token = state.next_token.wrapping_add(1);
                    let token = state.next_token;
                    let (done, rx) = watch::channel(false);
                    state.in_flight.insert(id.clone(), (token, rx));
                    return DeliverySlot::Claimed(InFlightGuard {
                        tracker: self,
                        id: id.clone(),
                        token,
                        done,
                        delivered: false,
                    });
                }
            };
            let _ = waiter.wait_for(|&done| done).await;
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectorEnvelope {
    version: u8,
    selector: RevocationSelector,
}
pub(super) async fn pending(
    tx: &mut Transaction,
    selector: RevocationSelector,
) -> Result<Vec<RequestId>, PortError> {
    let selector = serde_json::to_string(&SelectorEnvelope {
        version: 1,
        selector,
    })
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let events = rows!(tx,(String,),fetch_all,
        "SELECT event_id FROM revocation_events WHERE selector=$1 AND delivered_at IS NULL ORDER BY event_id LIMIT 201",
        "SELECT event_id FROM v1_control.revocation_events WHERE selector=$1 AND delivered_at IS NULL ORDER BY event_id LIMIT 201";&selector)?;
    if events.len() > 200 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    events
        .into_iter()
        .map(|(id,)| RequestId::parse(&id).map_err(Into::into))
        .collect()
}
pub(super) async fn enqueue(
    tx: &mut Transaction,
    selector: RevocationSelector,
    reason: RevocationReason,
    version: i64,
    now: i64,
) -> Result<RequestId, PortError> {
    let id = RequestId::from_bytes(random()?);
    enqueue_at(tx, id, selector, reason, version, now).await
}
pub(super) async fn enqueue_at(
    tx: &mut Transaction,
    id: RequestId,
    selector: RevocationSelector,
    reason: RevocationReason,
    version: i64,
    now: i64,
) -> Result<RequestId, PortError> {
    let selector = serde_json::to_string(&SelectorEnvelope {
        version: 1,
        selector,
    })
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let reason = match reason {
        RevocationReason::Logout => "logout",
        RevocationReason::Expired => "expired",
        RevocationReason::PermissionChanged => "permission_changed",
        RevocationReason::SpaceClosed => "space_closed",
        RevocationReason::CredentialRemoved => "credential_removed",
    };
    let record = TargetRecord::from(RevocationEventsRow {
        event_id: id.to_string(),
        selector,
        reason: reason.into(),
        authority_version: version,
        committed_at: now,
        delivered_at: None,
        attempts: 0,
    });
    record.validate()?;
    record.insert(tx).await?;
    Ok(id)
}
impl ControlService {
    /// SQL authority locks precede registry leases on both dispatch and mutation
    /// paths. Calls release their registration before starting settlement SQL.
    /// Only revocation events newly enqueued by `tx` should be passed here;
    /// replayed receipts and pre-existing pending events resume via
    /// `flush_event` without re-fencing already-authorized work.
    pub(super) async fn commit_revocations(
        &self,
        mut tx: crate::store::WriteTransaction,
        budget: &OperationBudget,
        events: &[RequestId],
    ) -> Result<(), PortError> {
        if events.is_empty() {
            return budget.commit_tx(tx).await;
        }
        const MAX_FENCE_SELECTORS: usize = 512;
        let mut unique = std::collections::BTreeSet::new();
        let mut to_revoke = Vec::new();
        let mut already_delivered = Vec::new();
        for id in events {
            let event = budget
                .run(
                    async {
                        rows!(tx.inner_mut(),RevocationEventsRow,fetch_one,
                    "SELECT * FROM revocation_events WHERE event_id=$1",
                    "SELECT * FROM v1_control.revocation_events WHERE event_id=$1";id.as_str())
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            if event.delivered_at.is_none() {
                let envelope: SelectorEnvelope = serde_json::from_str(&event.selector)
                    .map_err(|_| invalid(ValidationReason::InvalidState))?;
                if envelope.version != 1 {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                let reason: RevocationReason =
                    serde_json::from_value(serde_json::Value::String(event.reason))
                        .map_err(|_| invalid(ValidationReason::InvalidState))?;
                let request = RequestId::parse(&event.event_id)?;
                if self.revocation_tracker.is_delivered(&request) {
                    already_delivered.push((event.event_id, request));
                } else {
                    unique.insert(envelope.selector.clone());
                    to_revoke.push((event.event_id, request, envelope.selector, reason));
                }
            }
        }
        let selectors: Vec<_> = unique.into_iter().collect();
        for chunk in selectors.chunks(MAX_FENCE_SELECTORS) {
            let fence = budget
                .run(
                    self.revoker.fence_provider(
                        MaintenanceContext {
                            authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                            budget: budget.context(events[0].clone()),
                        },
                        chunk.to_vec(),
                    ),
                    CommitEffect::NotCommitted,
                )
                .await?;
            fence.check()?;
            tx.hold_revocation_fence(fence);
        }
        budget.check(CommitEffect::NotCommitted)?;
        // Run COMMIT -> revoke -> release fences -> persist durable ACK inside
        // one spawned task so caller cancellation after COMMIT starts cannot
        // drop provider fences before every newly committed revocation event is
        // attempted or lose the durable `delivered_at` ACK.
        let revoker = Arc::clone(&self.revoker);
        let tracker = Arc::clone(&self.revocation_tracker);
        let store = self.store.clone();
        let clock = Arc::clone(&self.clock);
        let ack_request_id = events
            .first()
            .cloned()
            .unwrap_or_else(|| RequestId::from_bytes([0; 16]));
        let settle_handle = tokio::spawn(async move {
            let fences = tx.commit_keeping_fences().await?;
            let mut delivered_ids = already_delivered;
            delivered_ids.reserve(to_revoke.len());
            let mut first_error: Option<PortError> = None;
            for (event_id, request, selector, reason) in to_revoke {
                let step_result = tokio::time::timeout(BACKGROUND_REVOKE_TIMEOUT, async {
                    let Some(mut guard) = tracker.begin_owned(request.clone()).await else {
                        return Ok(true);
                    };
                    revoker
                        .revoke(
                            MaintenanceContext {
                                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                                budget: CallBudget {
                                    request: request.clone(),
                                    remaining: BACKGROUND_REVOKE_TIMEOUT,
                                    cancellation: Cancellation::default(),
                                },
                            },
                            selector,
                            reason,
                        )
                        .await
                        .map_err(|_| {
                            unavailable("control revocation delivery", CommitEffect::Unknown)
                        })?;
                    guard.mark_delivered();
                    Ok::<bool, PortError>(true)
                })
                .await;
                match step_result {
                    Ok(Ok(true)) => delivered_ids.push((event_id, request)),
                    Ok(Ok(false)) => {}
                    Ok(Err(error)) => {
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                    Err(_) => {
                        if first_error.is_none() {
                            first_error = Some(unavailable(
                                "control revocation delivery timeout",
                                CommitEffect::Unknown,
                            ));
                        }
                    }
                }
            }
            drop(fences);
            if !delivered_ids.is_empty() {
                let ack_budget = OperationBudget::new(CallBudget {
                    request: ack_request_id,
                    remaining: BACKGROUND_REVOKE_TIMEOUT,
                    cancellation: Cancellation::default(),
                });
                let mark_delivered: Result<(), PortError> = async {
                    let mut mark_tx = store.write(ack_budget.clone()).await?;
                    let now = clock.now_ms()?;
                    ack_budget
                        .run(
                            async {
                                for (event_id, _) in &delivered_ids {
                                    execute!(
                                        mark_tx.inner_mut(),
                                        "UPDATE revocation_events SET attempts=attempts+1, delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL",
                                        "UPDATE v1_control.revocation_events SET attempts=attempts+1, delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL";
                                        now,
                                        event_id
                                    )?;
                                }
                                Ok(())
                            },
                            CommitEffect::Unknown,
                        )
                        .await?;
                    ack_budget.commit_tx(mark_tx).await
                }
                .await;
                if mark_delivered.is_ok() {
                    for (_, request) in &delivered_ids {
                        tracker.mark_acked(request);
                    }
                }
            }
            if let Some(error) = first_error {
                return Err(error);
            }
            Ok::<(), PortError>(())
        });
        budget
            .await_spawned(settle_handle, "control commit revocation worker")
            .await?;
        Ok(())
    }
    pub(super) async fn flush_event(
        &self,
        budget: &OperationBudget,
        id: &RequestId,
    ) -> Result<(), PortError> {
        let result=async {
            let event=budget.run(async {read_rows!(&self.store.backend,RevocationEventsRow,fetch_one,
                "SELECT * FROM revocation_events WHERE event_id=$1","SELECT * FROM v1_control.revocation_events WHERE event_id=$1";id.as_str())
            },CommitEffect::Unknown).await?;
            if event.delivered_at.is_none() {self.deliver_revocation(budget,event).await?;}
            Ok(())
        }.await;
        result.map_err(|_: PortError| {
            unavailable(
                "control committed revocation pending",
                CommitEffect::Unknown,
            )
        })
    }
    pub async fn drain_revocations(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> Result<RevocationDrain, PortError> {
        ctx.authority.require(ServicePurpose::Revocation)?;
        if !(1..=200).contains(&limit) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let budget = OperationBudget::new(ctx.budget);
        let rows=budget.run(async {read_rows!(&self.store.backend,RevocationEventsRow,fetch_all,
            "SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM revocation_events WHERE delivered_at IS NULL ORDER BY committed_at,event_id LIMIT $1",
            "SELECT event_id,selector,reason,authority_version,committed_at,delivered_at,attempts FROM v1_control.revocation_events WHERE delivered_at IS NULL ORDER BY committed_at,event_id LIMIT $1"; i64::from(limit)+1)
        },CommitEffect::NotCommitted).await?;
        let has_more = rows.len() > usize::from(limit);
        let mut delivered = 0;
        for event in rows.into_iter().take(usize::from(limit)) {
            self.deliver_revocation(&budget, event)
                .await
                .map_err(|err| {
                    if delivered > 0 {
                        unknown_after_revocation(err, "control revocation drain")
                    } else {
                        err
                    }
                })?;
            delivered += 1;
        }
        Ok(RevocationDrain {
            delivered,
            has_more,
        })
    }
    async fn deliver_revocation(
        &self,
        budget: &OperationBudget,
        event: RevocationEventsRow,
    ) -> Result<(), PortError> {
        let request = RequestId::parse(&event.event_id)?;
        let envelope: SelectorEnvelope = serde_json::from_str(&event.selector)
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        if envelope.version != 1 {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let reason: RevocationReason =
            serde_json::from_value(serde_json::Value::String(event.reason))
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
        let slot = budget
            .run(
                async { Ok(self.revocation_tracker.begin(&request).await) },
                CommitEffect::NotCommitted,
            )
            .await?;
        if let DeliverySlot::Claimed(guard) = slot {
            let mut tx = self.store.write(budget.clone()).await?;
            let changed=budget.run(async {execute!(tx.inner_mut(),
                "UPDATE revocation_events SET attempts=attempts+1 WHERE event_id=$1 AND delivered_at IS NULL",
                "UPDATE v1_control.revocation_events SET attempts=attempts+1 WHERE event_id=$1 AND delivered_at IS NULL"; &event.event_id)
            },CommitEffect::NotCommitted).await?;
            budget.commit_tx(tx).await?;
            if changed == 0 {
                return Ok(());
            }
            budget
                .run(
                    self.revoker.revoke(
                        MaintenanceContext {
                            authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                            budget: budget.context(request.clone()),
                        },
                        envelope.selector,
                        reason,
                    ),
                    CommitEffect::Unknown,
                )
                .await
                .map_err(|_| unavailable("control revocation delivery", CommitEffect::Unknown))?;
            guard.mark_delivered();
        }
        async {
            let mut tx = self.store.write(budget.clone()).await?;
            let now = self.clock.now_ms()?;
            budget.run(async {execute!(tx.inner_mut(),
                "UPDATE revocation_events SET delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL",
                "UPDATE v1_control.revocation_events SET delivered_at=$1 WHERE event_id=$2 AND delivered_at IS NULL"; now,&event.event_id)
            },CommitEffect::Unknown).await?;
            budget.commit_tx(tx).await
        }
        .await
        .map_err(|err| unknown_after_revocation(err, "control revocation mark delivered"))?;
        self.revocation_tracker.mark_acked(&request);
        Ok(())
    }
}

fn unknown_after_revocation(error: PortError, label: &'static str) -> PortError {
    let make = || {
        notarium_core::error::OperationalFailure::new(
            notarium_core::ids::ContentDigest::from_bytes(
                *blake3::hash(label.as_bytes()).as_bytes(),
            ),
            CommitEffect::Unknown,
            notarium_core::error::RetryAdvice::Never,
            false,
        )
        .expect("non-retryable failure")
    };
    match error {
        PortError::Cancelled(f) if f.effect() == CommitEffect::Unknown => PortError::Cancelled(f),
        PortError::DeadlineExceeded(f) if f.effect() == CommitEffect::Unknown => {
            PortError::DeadlineExceeded(f)
        }
        PortError::Unavailable(f) if f.effect() == CommitEffect::Unknown => {
            PortError::Unavailable(f)
        }
        PortError::Internal(f) if f.effect() == CommitEffect::Unknown => PortError::Internal(f),
        PortError::Cancelled(_) => PortError::Cancelled(make()),
        PortError::DeadlineExceeded(_) => PortError::DeadlineExceeded(make()),
        PortError::Unavailable(_) => PortError::Unavailable(make()),
        PortError::Internal(_) => PortError::Internal(make()),
        PortError::Domain(_) => unavailable(label, CommitEffect::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivery_tracker_watch_waiters_never_lose_wakeup() {
        let tracker = Arc::new(RevocationDeliveryTracker::default());
        for i in 0u8..64 {
            let id = RequestId::from_bytes([i; 16]);
            let mut holder = tracker
                .begin_owned(id.clone())
                .await
                .expect("first caller claims event");
            let t1 = Arc::clone(&tracker);
            let id1 = id.clone();
            let waiter1 = tokio::spawn(async move { t1.begin_owned(id1).await });
            let t2 = Arc::clone(&tracker);
            let id2 = id.clone();
            let waiter2 = tokio::spawn(async move {
                matches!(t2.begin(&id2).await, DeliverySlot::AlreadyDelivered)
            });
            tokio::task::yield_now().await;
            holder.mark_delivered();
            drop(holder);
            let r1 = tokio::time::timeout(Duration::from_secs(5), waiter1)
                .await
                .expect("waiter1 must wake without lost-wakeup deadlock")
                .unwrap();
            let r2 = tokio::time::timeout(Duration::from_secs(5), waiter2)
                .await
                .expect("waiter2 must wake without lost-wakeup deadlock")
                .unwrap();
            assert!(r1.is_none());
            assert!(r2);
        }
    }

    #[tokio::test]
    async fn delivery_tracker_keeps_unacked_events_immune_from_lru_eviction() {
        let tracker = Arc::new(RevocationDeliveryTracker::default());
        let unacked = RequestId::from_bytes([0xAA; 16]);
        let mut guard = tracker
            .begin_owned(unacked.clone())
            .await
            .expect("claim unacked");
        guard.mark_delivered();
        drop(guard);
        assert!(tracker.is_delivered(&unacked));

        // Deliver and durably ACK more than MAX_TRACKED_DELIVERED_EVENTS other events.
        for i in 0u32..(MAX_TRACKED_DELIVERED_EVENTS as u32 + 64) {
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&i.to_be_bytes());
            let other = RequestId::from_bytes(bytes);
            let mut g = tracker.begin_owned(other.clone()).await.expect("claim");
            g.mark_delivered();
            drop(g);
            tracker.mark_acked(&other);
        }

        // Un-ACKed delivered event must never be evicted before SQL ACK succeeds.
        assert!(tracker.is_delivered(&unacked));
        assert!(matches!(
            tracker.begin(&unacked).await,
            DeliverySlot::AlreadyDelivered
        ));

        // Once durably ACKed, it enters the bounded LRU normally.
        tracker.mark_acked(&unacked);
        assert!(tracker.is_delivered(&unacked));
    }
}

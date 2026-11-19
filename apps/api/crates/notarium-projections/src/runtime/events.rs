use std::{
    collections::BTreeSet,
    sync::{Arc, Weak, atomic::Ordering},
    time::Duration,
};

use notarium_canonical::{
    LiveNoteStatus, LiveReadPermit,
    codec::{cancelled_not_committed, deadline_not_committed},
    projection_read::ProjectionDelta,
};
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{NoteId, ProjectionGeneration, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::{
        BoardDelta, CallBudget, Cancellation, Change, ChangeKind, ChangeRead, ChangeReadResult,
        CommandSeqRange, ContentJobKind, EntityId, EventBusPort, MaintenanceContext, PageLimit,
        PortFuture, PortStream, ServicePurpose, SpaceContext, SpaceEvent, SpaceEventKind,
    },
    receipt::{ChangeCursor, MutationEffect},
};
use tokio::sync::{RwLockReadGuard, broadcast, watch};

use crate::{derived::GenerationLease, query::entry_folder};

use super::{
    ProjectionEngine, PublishedCut, SpaceSlot, apply,
    board_events::{BoardAudience, BoardNotice, MAX_BOARD_EVENT_ITEMS},
};

#[derive(Clone)]
pub(super) enum QueuedEvent {
    Space {
        event: SpaceEvent,
        generation: ProjectionGeneration,
    },
    Board(BoardNotice),
    RecoveryReady {
        scope: HistoryScope,
        through: SpaceSeq,
        repeat_at_cut: bool,
        generation: ProjectionGeneration,
    },
    CommandRefresh {
        scope: HistoryScope,
        range: CommandSeqRange,
        generation: ProjectionGeneration,
        allow_unrestricted: bool,
    },
}

#[derive(Clone)]
pub struct SpaceEventBus {
    engine: Weak<ProjectionEngine>,
}

impl SpaceEventBus {
    pub(super) fn new(engine: &Arc<ProjectionEngine>) -> Self {
        Self {
            engine: Arc::downgrade(engine),
        }
    }

    fn running(&self) -> Result<Arc<ProjectionEngine>, PortError> {
        self.engine
            .upgrade()
            .ok_or_else(|| DomainError::validation(ValidationReason::NotReady).into())
    }
}

impl ProjectionEngine {
    pub(super) fn emit(&self, scope: &HistoryScope, seq: SpaceSeq, kind: SpaceEventKind) {
        let generation = self.generation.load().store.generation();
        self.emit_generation(scope, seq, kind, generation);
    }

    pub(super) fn emit_generation(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
        kind: SpaceEventKind,
        generation: ProjectionGeneration,
    ) {
        // The freeze gates delivery. The old worker may still acknowledge and
        // enqueue its durable command, and the tag survives a racing flip.
        if self.generation.load().store.generation() != generation {
            return;
        }
        let event = SpaceEvent {
            scope: scope.clone(),
            seq,
            kind,
        };
        debug_assert!(valid_envelope(&event).is_ok());
        debug_assert!(!matches!(event.kind, SpaceEventKind::Board(_)));
        let _ = self.events.send(QueuedEvent::Space { event, generation });
    }

    pub(super) fn emit_board(&self, notice: BoardNotice) {
        // Freeze excludes delivery. Queuing an immutable old-generation
        // notice is safe, and the receiver checks the generation on rebind.
        if self.generation.load().store.generation() == notice.generation {
            let _ = self.events.send(QueuedEvent::Board(notice));
        }
    }

    pub(super) fn emit_recovery_ready(
        &self,
        scope: &HistoryScope,
        through: SpaceSeq,
        repeat_at_cut: bool,
        generation: ProjectionGeneration,
    ) {
        if self.generation.load().store.generation() == generation {
            let _ = self.events.send(QueuedEvent::RecoveryReady {
                scope: scope.clone(),
                through,
                repeat_at_cut,
                generation,
            });
        }
    }

    pub(super) fn emit_command_refresh(
        &self,
        scope: &HistoryScope,
        range: CommandSeqRange,
        generation: ProjectionGeneration,
        allow_unrestricted: bool,
    ) {
        if self.generation.load().store.generation() == generation {
            let _ = self.events.send(QueuedEvent::CommandRefresh {
                scope: scope.clone(),
                range,
                generation,
                allow_unrestricted,
            });
        }
    }
}

fn valid_envelope(event: &SpaceEvent) -> Result<(), PortError> {
    match &event.kind {
        SpaceEventKind::Changed(change) => {
            event.scope.check(&change.cursor.scope)?;
            if event.seq != change.cursor.after || !change.command_range.contains(event.seq) {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
        }
        SpaceEventKind::Board(delta) => {
            event.scope.check(&delta.scope)?;
            if event.seq != delta.seq {
                return Err(DomainError::validation(ValidationReason::InvalidRange).into());
            }
        }
        _ => {}
    }
    Ok(())
}

impl EventBusPort for SpaceEventBus {
    fn publish(&self, ctx: MaintenanceContext, event: SpaceEvent) -> PortFuture<'_, ()> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::EventPublication)?;
            if ctx.budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "space_events_publish",
                    "caller cancelled",
                ));
            }
            if ctx.budget.remaining.is_zero() {
                return Err(deadline_not_committed(
                    "space_events_publish",
                    "caller budget exhausted",
                ));
            }
            valid_envelope(&event)?;
            let engine = self.running()?;
            match event.kind {
                SpaceEventKind::Board(delta) => publish_board(&engine, &ctx, delta).await?,
                kind => engine.emit(&event.scope, event.seq, kind),
            }
            Ok(())
        })
    }

    fn subscribe(
        &self,
        ctx: SpaceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn PortStream<SpaceEvent>>> {
        Box::pin(async move {
            if ctx.budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "space_events_subscribe",
                    "subscriber cancelled",
                ));
            }
            if ctx.budget.remaining.is_zero() {
                return Err(deadline_not_committed(
                    "space_events_subscribe",
                    "caller budget exhausted",
                ));
            }
            let engine = self.running()?;
            let seq = after.check(ctx.scope())?;
            // Register first so an event published during admission is queued.
            let recv = engine.events.subscribe();
            let activation = engine.activation.subscribe();
            let scope = ctx.scope();
            {
                let permit = engine.live_handle(scope)?.try_read()?;
                authorize_subscription(&ctx, &permit, seq)?;
            }
            let generation = engine.generation.load().store.generation();
            let generation_lease =
                event_admission(&ctx, engine.admit_generation_read(scope, generation)).await?;
            let _admission = engine.current_admission(generation)?;
            let slot = engine
                .generation
                .load()
                .slot(&scope.space_id)
                .ok_or_else(|| DomainError::validation(ValidationReason::NotReady))?;
            let permit = engine.live_handle(scope)?.try_read()?;
            authorize_subscription(&ctx, &permit, seq)?;
            let initial = admitted_seq(&engine, scope);
            let pending = match initial {
                Some(projected) if projected > seq => Some(PendingEvent::Initial(projected)),
                Some(_) => None,
                // A new generation can be active before this Space binds its
                // lookup. Its first admitted cut decides whether to refresh.
                None => Some(PendingEvent::AwaitInitialCut(seq)),
            };
            Ok(Box::new(EventStream {
                engine: self.engine.clone(),
                ctx,
                recv,
                activation,
                history_ended: slot.history_ended.clone(),
                terminal: false,
                generation,
                _generation_lease: generation_lease,
                floor: initial.unwrap_or(seq).max(seq),
                delivered: seq,
                pending,
            }) as Box<dyn PortStream<SpaceEvent>>)
        })
    }
}

struct EventStream {
    engine: Weak<ProjectionEngine>,
    ctx: SpaceContext,
    recv: broadcast::Receiver<QueuedEvent>,
    activation: watch::Receiver<u64>,
    history_ended: Cancellation,
    terminal: bool,
    generation: ProjectionGeneration,
    _generation_lease: Option<GenerationLease>,
    floor: SpaceSeq,
    delivered: SpaceSeq,
    pending: Option<PendingEvent>,
}

impl PortStream<SpaceEvent> for EventStream {
    fn next(&mut self) -> PortFuture<'_, Option<SpaceEvent>> {
        Box::pin(async move {
            let result = match self.next_event().await {
                Err(error) if apply::is_history_mismatch(&error) => Ok(Some(self.finish_history())),
                result => result,
            };
            if matches!(result, Ok(None) | Err(PortError::Cancelled(_))) {
                self._generation_lease = None;
                self.pending = None;
            }
            result
        })
    }
}

impl EventStream {
    async fn next_event(&mut self) -> Result<Option<SpaceEvent>, PortError> {
        if self.terminal {
            return Ok(None);
        }
        if self.ctx.budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "space_events_receive",
                "subscriber cancelled",
            ));
        }
        loop {
            if self.history_ended.is_cancelled() {
                return Ok(Some(self.finish_history()));
            }
            let Some(engine) = self.engine.upgrade() else {
                return Ok(None);
            };
            if engine.generation.load().store.generation() != self.generation {
                let history_ended = self.history_ended.clone();
                return tokio::select! {
                    biased;
                    _ = history_ended.cancelled() => Ok(Some(self.finish_history())),
                    event = self.rebind_generation(&engine) => event.map(Some),
                };
            }
            if let Some(pending) = &mut self.pending {
                let initial = matches!(&*pending, PendingEvent::Initial(_));
                if let PendingEvent::Command(command) = pending {
                    command.page_in_flight = false;
                }
                let timed = tokio::select! {
                    biased;
                    _ = self.ctx.budget.cancellation.cancelled() => {
                        return Err(cancelled_not_committed("space_events_receive", "subscriber cancelled"));
                    }
                    _ = self.history_ended.cancelled() => {
                        return Ok(Some(self.finish_history()));
                    }
                    activated = self.activation.changed() => {
                        if activated.is_err() {
                            return Ok(None);
                        }
                        continue;
                    }
                    result = tokio::time::timeout(
                        self.ctx.budget.remaining,
                        async {
                            let result = pending_delivery(
                                &engine, &self.ctx, self.generation, self.delivered, pending,
                            )
                            .await;
                            confirm_history_on_not_ready(&engine, &self.ctx, result).await
                        },
                    ) => result,
                };
                let result = timed.unwrap_or_else(|_| {
                    if let PendingEvent::Command(command) = pending {
                        command.on_outer_deadline();
                    }
                    Err(deadline_not_committed(
                        "space_events_receive",
                        "event authority unavailable",
                    ))
                });
                let keep_pending = match &result {
                    Err(PortError::DeadlineExceeded(_)) => true,
                    Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                        if diagnostic.reason == ValidationReason::NotReady =>
                    {
                        true
                    }
                    Err(_) => initial,
                    Ok(_) => false,
                };
                if !keep_pending {
                    self.pending = None;
                }
                let Some(verified) = result? else {
                    continue;
                };
                let seq = verified.seq;
                let kind = verified.kind;
                self.delivered = seq;
                if matches!(kind, SpaceEventKind::ResyncRequired) {
                    self.floor = self.floor.max(seq);
                }
                return Ok(Some(SpaceEvent {
                    scope: self.ctx.scope().clone(),
                    seq,
                    kind,
                }));
            }
            drop(engine);
            let received = tokio::select! {
                biased;
                _ = self.ctx.budget.cancellation.cancelled() => {
                    return Err(cancelled_not_committed("space_events_receive", "subscriber cancelled"));
                }
                _ = self.history_ended.cancelled() => {
                    return Ok(Some(self.finish_history()));
                }
                activated = self.activation.changed() => {
                    if activated.is_err() {
                        return Ok(None);
                    }
                    continue;
                }
                event = self.recv.recv() => event,
            };
            let Some(engine) = self.engine.upgrade() else {
                return Ok(None);
            };
            if engine.generation.load().store.generation() != self.generation {
                continue;
            }
            let scope = self.ctx.scope();
            match received {
                Ok(QueuedEvent::Space { event, generation }) => {
                    if event.scope != *scope || generation != self.generation {
                        continue;
                    }
                    // History reset may repeat the last sequence. Graph
                    // settlement can follow an earlier structural refresh at the same cut.
                    if !matches!(event.kind, SpaceEventKind::ResyncRequired)
                        && (event.seq < self.delivered
                            || (event.seq <= self.floor
                                && !matches!(event.kind, SpaceEventKind::GraphSettled { .. }))
                            || matches!(event.kind, SpaceEventKind::GraphSettled { generation } if generation != self.generation))
                    {
                        continue;
                    }
                    self.pending = Some(PendingEvent::Space(event));
                }
                Ok(QueuedEvent::Board(notice)) => {
                    if notice.scope != *scope
                        || notice.generation != self.generation
                        || notice.seq < self.delivered
                        || notice.seq <= self.floor
                    {
                        continue;
                    }
                    self.pending = Some(PendingEvent::Board(notice));
                    continue;
                }
                Ok(QueuedEvent::RecoveryReady {
                    scope: recovered_scope,
                    through,
                    repeat_at_cut,
                    generation,
                }) => {
                    if recovered_scope == *scope
                        && generation == self.generation
                        && (through > self.delivered
                            || (repeat_at_cut && through == self.delivered))
                    {
                        self.pending = Some(PendingEvent::RecoveryReady(through));
                    }
                }
                Ok(QueuedEvent::CommandRefresh {
                    scope: command_scope,
                    range,
                    generation,
                    allow_unrestricted,
                }) => {
                    let direct = has_full_space_access(&self.ctx);
                    if command_scope != *scope
                        || generation != self.generation
                        || range.last_seq < self.delivered
                        || range.last_seq <= self.floor
                        || (direct && !allow_unrestricted)
                    {
                        continue;
                    }
                    self.pending = Some(PendingEvent::Command(PendingCommandRefresh {
                        range,
                        after: SpaceSeq::new(range.first_seq.get() - 1)?,
                        proof: None,
                        page_limit: PageLimit::new(64)?,
                        page_in_flight: false,
                        direct,
                    }));
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(None),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.pending = Some(PendingEvent::Lagged);
                }
            }
        }
    }

    async fn rebind_generation(
        &mut self,
        engine: &ProjectionEngine,
    ) -> Result<SpaceEvent, PortError> {
        self.pending = None;
        let budget = self.ctx.budget.clone();
        let mut activation = engine.activation.subscribe();
        tokio::select! {
            biased;
            _ = budget.cancellation.cancelled() => {
                Err(cancelled_not_committed("space_events_receive", "subscriber cancelled"))
            }
            result = tokio::time::timeout(budget.remaining, async {
                loop {
                    let scope = self.ctx.scope();
                    if let Err(error) = engine.canonical.live_visibility_fence().space(scope)
                        && apply::is_history_mismatch(&error)
                    {
                        return Err(error);
                    }
                    let target = engine.generation.load_full();
                    let slot = target.ensure_slot(&scope.space_id);
                    let generation = target.store.generation();
                    let event = tokio::select! {
                        biased;
                        _ = slot.history_ended.cancelled() => {
                            // A detached target can precede an admitted cut in
                            // the replacement history. Confirm it with the owner.
                            confirm_history(engine, &self.ctx).await?;
                            continue;
                        }
                        result = async {
                            let result = self
                                .try_rebind_generation(engine, generation, &slot, &budget, &mut activation)
                                .await;
                            confirm_history_on_not_ready(engine, &self.ctx, result).await
                        } => result?,
                    };
                    if let Some(event) = event {
                        return Ok(event);
                    }
                }
            }) => result.map_err(|_| {
                deadline_not_committed("space_events_receive", "new generation unavailable")
            })?,
        }
    }

    async fn try_rebind_generation(
        &mut self,
        engine: &ProjectionEngine,
        generation: ProjectionGeneration,
        slot: &SpaceSlot,
        budget: &CallBudget,
        activation: &mut watch::Receiver<u64>,
    ) -> Result<Option<SpaceEvent>, PortError> {
        // Activation precedes the new generation's per-Space lookup.
        // Rebind only after that Space can serve the delivered cursor.
        let cut = engine
            .wait_for_cut(self.ctx.scope(), self.delivered, budget, budget.remaining)
            .await?;
        let mut progress = slot.progress.subscribe();
        let still_admitted = || {
            slot.admitted_cut().is_some_and(|current| {
                Arc::ptr_eq(&current, &cut) && !current.base.repair_pending()
            })
        };
        if cut.cut.generation != generation || !still_admitted() {
            return Ok(None);
        }
        let participant = {
            let Some(owner) = rebind_permit(&cut, budget, activation, &mut progress).await? else {
                return Ok(None);
            };
            owner.owner_witness().process().to_owned()
        };
        let lease = event_admission(
            &self.ctx,
            engine.admit_generation_read_for_participant(generation, &participant),
        )
        .await;
        if engine.generation.load().store.generation() != generation {
            return Ok(None);
        }
        let lease = match lease {
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale =>
            {
                // The durable control row can move before this process
                // observes activation of the next generation.
                activation
                    .changed()
                    .await
                    .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
                return Ok(None);
            }
            result => result?,
        };
        #[cfg(all(test, feature = "test-support"))]
        slot.benchmark_pause
            .pause_at(
                super::benchmark::PausePoint::BeforeRebindAdmission,
                None,
                &budget.cancellation,
            )
            .await;
        let Some(permit) = rebind_permit(&cut, budget, activation, &mut progress).await? else {
            return Ok(None);
        };
        let Ok(_admission) = engine.current_admission(generation) else {
            drop(permit);
            drop(lease);
            wait_event_publication(engine, generation).await?;
            return Ok(None);
        };
        authorize_entry(&self.ctx, &permit)?;
        // The lease lookup can race with withdrawal of a failed mmap.
        // A live owner permit alone does not prove this cut can serve reads.
        if !still_admitted() {
            return Ok(None);
        }
        let seq = cut.cut.projected_seq;
        self.generation = generation;
        self.history_ended = slot.history_ended.clone();
        self._generation_lease = lease;
        self.floor = seq;
        self.delivered = seq;
        Ok(Some(self.resync(seq)))
    }

    fn finish_history(&mut self) -> SpaceEvent {
        self.pending = None;
        self._generation_lease = None;
        self.terminal = true;
        self.resync(self.delivered)
    }

    fn resync(&self, seq: SpaceSeq) -> SpaceEvent {
        SpaceEvent {
            scope: self.ctx.scope().clone(),
            seq,
            kind: SpaceEventKind::ResyncRequired,
        }
    }
}

async fn confirm_history(engine: &ProjectionEngine, ctx: &SpaceContext) -> Result<(), PortError> {
    let scope = ctx.scope();
    let header = engine
        .canonical
        .read_projection_space_header(&engine.projection_context_for(ctx), &scope.space_id, None)
        .await?;
    scope.check(&header.scope)?;
    Ok(())
}

async fn confirm_history_on_not_ready<T>(
    engine: &ProjectionEngine,
    ctx: &SpaceContext,
    result: Result<T, PortError>,
) -> Result<T, PortError> {
    // Restore can withdraw the live owner binding before catalog discovery
    // detaches the slot. Only a confirmed history change ends the stream.
    if matches!(&result, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
        if diagnostic.reason == ValidationReason::NotReady)
        && let Err(error) = confirm_history(engine, ctx).await
        && apply::is_history_mismatch(&error)
    {
        return Err(error);
    }
    result
}

async fn rebind_permit(
    cut: &PublishedCut,
    budget: &CallBudget,
    activation: &mut watch::Receiver<u64>,
    progress: &mut watch::Receiver<u64>,
) -> Result<Option<LiveReadPermit>, PortError> {
    match cut.live.read(budget).await {
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady =>
        {
            // A pending writer is handled by the budgeted read. An unbound
            // owner instead needs a new admitted cut or generation.
            tokio::select! {
                updated = activation.changed() => updated,
                updated = progress.changed() => updated,
            }
            .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
            Ok(None)
        }
        result => result.map(Some),
    }
}

async fn event_admission<T>(
    ctx: &SpaceContext,
    operation: impl Future<Output = Result<T, PortError>>,
) -> Result<T, PortError> {
    let budget = ctx.budget.remaining.min(Duration::from_millis(240));
    tokio::select! {
        biased;
        _ = ctx.budget.cancellation.cancelled() => {
            Err(cancelled_not_committed("space_events_subscribe", "subscriber cancelled"))
        }
        result = tokio::time::timeout(budget, operation) => {
            result.map_err(|_| deadline_not_committed("space_events_subscribe", "generation lease admission exceeded deadline"))?
        }
    }
}

fn authorize_subscription(
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    authorize_entry(ctx, permit)?;
    if seq > permit.head() {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    Ok(())
}

pub(super) fn authorize_entry(
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
) -> Result<(), PortError> {
    let grant = ctx
        .auth()
        .spaces()
        .get(&ctx.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    super::read::authorize_entry(
        permit,
        ctx,
        entry_folder(grant, permit.root_folder_id(), None),
    )
}

fn visible_note(
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
    note: &NoteId,
) -> Result<bool, PortError> {
    match permit.classify(ctx, note, true)? {
        LiveNoteStatus::ActiveVisible(facts) => {
            ctx.auth().authorize_read(&facts)?;
            Ok(true)
        }
        LiveNoteStatus::EncryptedVisible {
            facts,
            effective_lifecycle: Lifecycle::Active,
        } => {
            ctx.auth().authorize_read(&facts)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn publish_board(
    engine: &ProjectionEngine,
    ctx: &MaintenanceContext,
    delta: BoardDelta,
) -> Result<(), PortError> {
    let cut = engine.published_cut(&delta.scope)?;
    let definition = tokio::select! {
        biased;
        _ = ctx.budget.cancellation.cancelled() => {
            return Err(cancelled_not_committed("space_events_publish", "caller cancelled"));
        }
        result = tokio::time::timeout(
            ctx.budget.remaining,
            engine.board_definition(&cut, delta.seq, &delta.view),
        ) => result.map_err(|_| {
            deadline_not_committed("space_events_publish", "board source unavailable")
        })??,
    };
    if let Some(definition) = definition {
        engine.emit_board(BoardNotice {
            scope: delta.scope.clone(),
            seq: delta.seq,
            generation: cut.cut.generation,
            view: delta.view.clone(),
            source: Arc::new(definition.source),
            affected: Arc::from([]),
            delta: (delta.groups.len() + delta.ranks.len() < MAX_BOARD_EVENT_ITEMS)
                .then(|| Arc::new(delta)),
        });
    }
    Ok(())
}

struct EventDelivery<'engine> {
    seq: SpaceSeq,
    kind: SpaceEventKind,
    _permit: Option<LiveReadPermit>,
    _admission: RwLockReadGuard<'engine, ()>,
}

enum PendingEvent {
    Initial(SpaceSeq),
    AwaitInitialCut(SpaceSeq),
    RecoveryReady(SpaceSeq),
    Board(BoardNotice),
    Command(PendingCommandRefresh),
    Space(SpaceEvent),
    Lagged,
}

struct PendingCommandRefresh {
    range: CommandSeqRange,
    after: SpaceSeq,
    proof: Option<Change>,
    page_limit: PageLimit,
    // Kept set if the outer receive deadline drops a page future.
    page_in_flight: bool,
    direct: bool,
}

impl PendingCommandRefresh {
    fn reduce_page(&mut self) -> bool {
        let Ok(limit) = PageLimit::new(self.page_limit.get() / 2) else {
            return false;
        };
        self.page_limit = limit;
        true
    }

    fn on_outer_deadline(&mut self) {
        if std::mem::take(&mut self.page_in_flight) {
            self.reduce_page();
        }
    }
}

async fn pending_delivery<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    delivered: SpaceSeq,
    pending: &mut PendingEvent,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    match pending {
        PendingEvent::Initial(through) => {
            initial_refresh(engine, ctx, generation, delivered, *through).await
        }
        PendingEvent::RecoveryReady(through) => {
            // The target gates readiness, but the public event repeats the
            // reader's cursor instead of exposing the recovered cut.
            direct_refresh(engine, ctx, generation, delivered, Some(*through)).await
        }
        PendingEvent::AwaitInitialCut(after) => {
            let cut = engine
                .wait_for_cut(
                    ctx.scope(),
                    SpaceSeq::ZERO,
                    &ctx.budget,
                    ctx.budget.remaining,
                )
                .await?;
            let seq = cut.cut.projected_seq;
            if cut.cut.generation != generation || seq <= *after {
                return Ok(None);
            }
            *pending = PendingEvent::Initial(seq);
            initial_refresh(engine, ctx, generation, delivered, seq).await
        }
        PendingEvent::Space(event) if matches!(event.kind, SpaceEventKind::ResyncRequired) => {
            transport_refresh(engine, ctx, generation, delivered, Some(event.seq)).await
        }
        PendingEvent::Space(event) => space_delivery(engine, ctx, generation, event).await,
        PendingEvent::Lagged => transport_refresh(engine, ctx, generation, delivered, None).await,
        PendingEvent::Board(notice) => board_delivery(engine, ctx, notice).await,
        PendingEvent::Command(command) if command.direct => {
            direct_refresh(engine, ctx, generation, command.range.last_seq, None).await
        }
        PendingEvent::Command(command) => command_refresh(engine, ctx, generation, command).await,
    }
}

async fn initial_refresh<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    delivered: SpaceSeq,
    through: SpaceSeq,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    let seq = if has_full_space_access(ctx) {
        through
    } else {
        delivered
    };
    direct_refresh(engine, ctx, generation, seq, Some(through)).await
}

async fn wait_event_publication(
    engine: &ProjectionEngine,
    generation: ProjectionGeneration,
) -> Result<bool, PortError> {
    let mut activation = engine.activation.subscribe();
    loop {
        // An aborted handoff can reopen the same generation. Do not hold a
        // canonical permit while waiting for the publication lock or activation.
        let publication = engine.publication.read().await;
        if engine.generation.load().store.generation() != generation {
            return Ok(false);
        }
        if !engine.publication_closed.load(Ordering::Acquire) {
            return Ok(true);
        }
        drop(publication);
        activation
            .changed()
            .await
            .map_err(|_| DomainError::validation(ValidationReason::NotReady))?;
    }
}

// Callers hold publication admission for the active generation.
fn admitted_seq(engine: &ProjectionEngine, scope: &HistoryScope) -> Option<SpaceSeq> {
    engine
        .generation
        .load()
        .slot(&scope.space_id)
        .and_then(|slot| slot.admitted_cut())
        .filter(|cut| cut.cut.scope == *scope && !cut.base.repair_pending())
        .map(|cut| cut.cut.projected_seq)
}

fn has_full_space_access(ctx: &SpaceContext) -> bool {
    ctx.auth()
        .spaces()
        .get(&ctx.scope().space_id)
        .is_some_and(|grant| grant.project_root.is_none() && grant.read_classes == DocClass::all())
}

async fn space_delivery<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    event: &SpaceEvent,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    if matches!(event.kind, SpaceEventKind::GraphSettled { .. }) && !has_full_space_access(ctx) {
        return Ok(None);
    }
    while wait_event_publication(engine, generation).await? {
        let live = engine.live_handle(ctx.scope())?;
        let mut permit = live.read(&ctx.budget).await?;
        authorize_entry(ctx, &permit)?;
        if event.seq > permit.head() {
            return Ok(None);
        }

        let kind = if let SpaceEventKind::Changed(change) = &event.kind {
            let head = permit.head();
            drop(permit);
            let visible = engine
                .canonical()
                .filter_projection_event_change(
                    &engine.projection_context_for(ctx),
                    ctx,
                    change.clone(),
                )
                .await?;
            permit = live.read(&ctx.budget).await?;
            if permit.head() != head {
                continue;
            }
            authorize_entry(ctx, &permit)?;
            let Some(change) = visible else {
                return Ok(None);
            };
            SpaceEventKind::Changed(change)
        } else {
            if let SpaceEventKind::Job(job) = &event.kind {
                let Some(grant) = ctx.auth().spaces().get(&event.scope.space_id) else {
                    return Ok(None);
                };
                if grant.project_root.is_some() {
                    return Ok(None);
                }
                if let ContentJobKind::Export { notes, .. } = &job.kind {
                    for note in notes {
                        if !visible_note(ctx, &permit, note)? {
                            return Ok(None);
                        }
                    }
                }
            }
            event.kind.clone()
        };
        let Ok(admission) = engine.current_admission(generation) else {
            continue;
        };
        return Ok(Some(EventDelivery {
            seq: event.seq,
            kind,
            _permit: Some(permit),
            _admission: admission,
        }));
    }
    Ok(None)
}

async fn transport_refresh<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    delivered: SpaceSeq,
    requested: Option<SpaceSeq>,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    while wait_event_publication(engine, generation).await? {
        let permit = if requested.is_none() {
            Some(engine.live_handle(ctx.scope())?.read(&ctx.budget).await?)
        } else {
            // A history reset can invalidate the old live scope entirely.
            // In that case only the previously delivered cursor may be reused.
            engine
                .live_handle(ctx.scope())
                .and_then(|live| live.try_read())
                .ok()
        };
        if let Some(permit) = &permit {
            authorize_entry(ctx, permit)?;
        }
        let Ok(admission) = engine.current_admission(generation) else {
            continue;
        };
        // A transport notification may lead projection. Refreshing at a newer
        // canonical cursor would suppress the delivery when its cut catches up.
        let projected = admitted_seq(engine, ctx.scope()).unwrap_or(delivered);
        let seq = match requested {
            Some(seq) => permit
                .as_ref()
                .map_or(delivered, |live| seq.min(live.head()).min(projected)),
            None => projected,
        };
        return Ok(Some(EventDelivery {
            seq: seq.max(delivered),
            kind: SpaceEventKind::ResyncRequired,
            _permit: permit,
            _admission: admission,
        }));
    }
    Ok(None)
}

async fn direct_refresh<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    seq: SpaceSeq,
    ready_through: Option<SpaceSeq>,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    while wait_event_publication(engine, generation).await? {
        if let Some(through) = ready_through {
            let cut = engine
                .wait_for_cut(ctx.scope(), through, &ctx.budget, ctx.budget.remaining)
                .await?;
            if cut.cut.generation != generation {
                return Ok(None);
            }
        }
        let permit = engine.live_handle(ctx.scope())?.read(&ctx.budget).await?;
        authorize_entry(ctx, &permit)?;
        if seq > permit.head() {
            return Ok(None);
        }
        let Ok(admission) = engine.current_admission(generation) else {
            continue;
        };
        if ready_through.is_some_and(|through| {
            admitted_seq(engine, ctx.scope()).is_none_or(|projected| projected < through)
        }) {
            continue;
        }
        return Ok(Some(EventDelivery {
            seq,
            kind: SpaceEventKind::ResyncRequired,
            _permit: Some(permit),
            _admission: admission,
        }));
    }
    Ok(None)
}

async fn command_refresh<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    generation: ProjectionGeneration,
    command: &mut PendingCommandRefresh,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    while wait_event_publication(engine, generation).await? {
        if let Some(proof) = &command.proof {
            let live = engine.live_handle(ctx.scope())?;
            let head = {
                let permit = live.read(&ctx.budget).await?;
                authorize_entry(ctx, &permit)?;
                if command.range.last_seq > permit.head() {
                    return Ok(None);
                }
                permit.head()
            };
            let visible = engine
                .canonical()
                .filter_projection_event_change(
                    &engine.projection_context_for(ctx),
                    ctx,
                    proof.clone(),
                )
                .await?;
            let permit = live.read(&ctx.budget).await?;
            if permit.head() != head {
                continue;
            }
            if visible.is_none() {
                command.proof = None;
                continue;
            }
            authorize_entry(ctx, &permit)?;
            let Ok(admission) = engine.current_admission(generation) else {
                continue;
            };
            return Ok(Some(EventDelivery {
                seq: command.range.last_seq,
                kind: SpaceEventKind::ResyncRequired,
                _permit: Some(permit),
                _admission: admission,
            }));
        }

        if command.after == command.range.last_seq {
            return Ok(None);
        }
        command.page_in_flight = true;
        let page = scan_command_changes(engine, ctx, command).await;
        command.page_in_flight = false;
        if let Err(error) = page {
            if matches!(error, PortError::DeadlineExceeded(_)) && command.reduce_page() {
                continue;
            }
            return Err(error);
        }
    }
    Ok(None)
}

async fn scan_command_changes(
    engine: &ProjectionEngine,
    ctx: &SpaceContext,
    command: &mut PendingCommandRefresh,
) -> Result<(), PortError> {
    let limit = command.page_limit;
    let span = command.range;
    let after = ChangeCursor {
        scope: ctx.scope().clone(),
        after: command.after,
    };
    let ChangeReadResult::Log(page) = engine
        .canonical()
        .read_changes(
            ctx.clone(),
            ChangeRead::Log {
                after,
                through: span.last_seq,
                limit,
            },
        )
        .await?
    else {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    };
    page.next.check(ctx.scope())?;
    if page.cutoff != span.last_seq
        || page.next.after <= command.after
        || page.next.after > span.last_seq
        || page
            .changes
            .iter()
            .any(|change| change.command_range != span)
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }

    // Classless note moves can be physical rank updates for an unchanged
    // neighbor. Only consult the exact canonical page when an already-visible
    // candidate needs this distinction, and retain no unfiltered revision.
    let mut rank_changes = BTreeSet::new();
    if page.changes.first().is_some_and(needs_rank_proof) {
        let effects = engine
            .canonical()
            .read_projection_delta_batch(
                &engine.projection_context_for(ctx),
                ctx.scope(),
                SpaceSeq::new(span.first_seq.get() - 1)?,
                span.last_seq,
                Some(command.after),
                limit,
            )
            .await?;
        rank_changes.extend(effects.rows.into_iter().filter_map(|effect| match effect {
            ProjectionDelta::Rank {
                rank,
                changes_placement: true,
            } => Some(rank.revision_id),
            _ => None,
        }));
    }

    if let Some(mut proof) = page
        .changes
        .into_iter()
        .find(|change| !needs_rank_proof(change) || rank_changes.contains(&change.revision))
    {
        command.after = proof.cursor.after;
        proof.effect = MutationEffect::NoRelevantEffect;
        command.proof = Some(proof);
    } else {
        // Empty authorization-filtered pages still advance the physical cursor.
        command.after = page.next.after;
    }
    Ok(())
}

fn needs_rank_proof(change: &Change) -> bool {
    matches!(change.entity, EntityId::Note(_))
        && change.kind == ChangeKind::Move
        && change.class.is_none()
}

async fn board_delivery<'engine>(
    engine: &'engine ProjectionEngine,
    ctx: &SpaceContext,
    notice: &mut BoardNotice,
) -> Result<Option<EventDelivery<'engine>>, PortError> {
    loop {
        if !wait_event_publication(engine, notice.generation).await? {
            return Ok(None);
        }
        let live = engine.live_handle(&notice.scope)?;
        let head = {
            let permit = live.read(&ctx.budget).await?;
            authorize_entry(ctx, &permit)?;
            if notice.seq > permit.head() {
                return Ok(None);
            }
            let Some(audience) = board_audience_now(ctx, &permit, notice)? else {
                return Ok(None);
            };
            if audience == BoardAudience::Scoped
                && !notice.affected_visible(ctx, &permit, &notice.source)?
            {
                return Ok(None);
            }
            if permit.head() == notice.seq {
                let Ok(admission) = engine.current_admission(notice.generation) else {
                    continue;
                };
                let kind = match (audience, notice.delta.take()) {
                    (BoardAudience::Full, Some(delta)) => {
                        if !board_ranks_visible(ctx, &permit, &delta)? {
                            return Ok(None);
                        }
                        SpaceEventKind::Board(Arc::unwrap_or_clone(delta))
                    }
                    _ => SpaceEventKind::ResyncRequired,
                };
                return Ok(Some(EventDelivery {
                    seq: notice.seq,
                    kind,
                    _permit: Some(permit),
                    _admission: admission,
                }));
            }
            permit.head()
        };
        // Counts may include now-hidden contributors. Keep only the immutable
        // source facts while the projection catches up to the canonical head.
        drop(notice.delta.take());

        let cut = engine
            .wait_for_cut(&notice.scope, head, &ctx.budget, ctx.budget.remaining)
            .await?;
        if cut.cut.generation != notice.generation {
            return Ok(None);
        }
        let definition = engine
            .board_definition(&cut, cut.cut.projected_seq, &notice.view)
            .await;
        let permit = live.read(&ctx.budget).await?;
        authorize_entry(ctx, &permit)?;
        if permit.head() != cut.cut.projected_seq {
            continue;
        }

        let definition = match definition {
            Ok(Some(definition)) => definition,
            Ok(None) => return Ok(None),
            Err(PortError::Domain(ref error)) if error.requires_resync() => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(previous) = board_audience_now(ctx, &permit, notice)? else {
            return Ok(None);
        };
        let Some(current) = definition.source.audience(ctx, &permit) else {
            return Ok(None);
        };
        if (previous == BoardAudience::Scoped || current == BoardAudience::Scoped)
            && !notice.affected_visible(ctx, &permit, &definition.source)?
        {
            return Ok(None);
        }
        let Ok(admission) = engine.current_admission(notice.generation) else {
            continue;
        };
        return Ok(Some(EventDelivery {
            seq: notice.seq,
            kind: SpaceEventKind::ResyncRequired,
            _permit: Some(permit),
            _admission: admission,
        }));
    }
}

fn board_audience_now(
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
    notice: &BoardNotice,
) -> Result<Option<BoardAudience>, PortError> {
    let LiveNoteStatus::ActiveVisible(facts) = permit.classify(ctx, &notice.view.note, true)?
    else {
        return Ok(None);
    };
    let Some(audience) = notice.source.audience(ctx, permit) else {
        return Ok(None);
    };
    ctx.auth().authorize_read(&facts)?;
    Ok(Some(audience))
}

fn board_ranks_visible(
    ctx: &SpaceContext,
    permit: &LiveReadPermit,
    delta: &BoardDelta,
) -> Result<bool, PortError> {
    for (note, _) in &delta.ranks {
        if !visible_note(ctx, permit, note)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outer_deadline_reduces_only_an_in_flight_command_page() {
        let after = SpaceSeq::new(4).unwrap();
        let mut command = PendingCommandRefresh {
            range: CommandSeqRange::new(SpaceSeq::new(1).unwrap(), SpaceSeq::new(8).unwrap())
                .unwrap(),
            after,
            proof: None,
            page_limit: PageLimit::new(64).unwrap(),
            page_in_flight: false,
            direct: false,
        };
        command.on_outer_deadline();
        assert_eq!(command.page_limit.get(), 64);
        for expected in [32, 16, 8, 4, 2, 1, 1] {
            command.page_in_flight = true;
            command.on_outer_deadline();
            assert_eq!(command.page_limit.get(), expected);
            assert_eq!(command.after, after);
            assert!(!command.page_in_flight);
        }
    }
}

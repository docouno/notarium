use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use notarium_canonical::ProjectionCatalogSubscription;
use notarium_core::{
    DomainError,
    auth::Space,
    error::{PortError, RetryAdvice, ValidationReason},
    ids::{FolderId, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::{
        Cancellation, Change, ChangeBroadcast, ChangeNotice, ChangeRead, ChangeReadResult,
        ChangeSubscription, CommandSeqRange, PageLimit, SpaceEventKind,
    },
    receipt::ChangeCursor,
};
use tokio::{sync::Semaphore, task::JoinSet, time::Instant};

use super::{Generation, ProjectionEngine, PublishedCut, SpaceSlot, apply};

const GRAPH_QUIET: Duration = Duration::from_secs(2);
const GRAPH_CHANGE_LIMIT: u32 = 1_000;

pub(super) async fn supervise(
    engine: Arc<ProjectionEngine>,
    generation: Arc<Generation>,
    initial: Vec<(Space, HistoryScope, FolderId, SpaceSeq)>,
    mut catalog: ProjectionCatalogSubscription,
    stop: Cancellation,
) -> Result<(), PortError> {
    let mut workers = JoinSet::<SpaceId>::new();
    let mut known = BTreeMap::<SpaceId, (HistoryScope, Cancellation, tokio::task::Id)>::new();
    let seed_slots = Arc::new(Semaphore::new(4));

    refresh_workers(
        &engine,
        &generation,
        &mut workers,
        &mut known,
        &seed_slots,
        initial,
    );
    loop {
        let refresh = tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            notice = catalog.next() => match notice {
                Some(_) => true,
                None => break,
            },
            _ = engine.discovery.notified() => true,
            result = workers.join_next_with_id(), if !workers.is_empty() => {
                match result {
                    Some(Err(error)) => {
                        let failed_id = error.id();
                        tracing::error!(error = %error, "projection worker panicked; scheduling restart");
                        let crashed = known
                            .iter()
                            .find_map(|(space, (_, _, id))| (*id == failed_id).then(|| space.clone()));
                        if let Some(space) = crashed {
                            known.remove(&space);
                        }
                        tokio::select! {
                            _ = stop.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                        }
                        true
                    }
                    Some(Ok((finished_id, space)))
                        if known
                            .get(&space)
                            .is_some_and(|(_, _, id)| *id == finished_id) =>
                    {
                        known.remove(&space);
                        !stop.is_cancelled()
                    }
                    Some(Ok(_)) => false,
                    None => false,
                }
            }
        };
        if refresh {
            match engine
                .canonical
                .list_spaces(&engine.projection_context)
                .await
            {
                Ok(spaces) => refresh_workers(
                    &engine,
                    &generation,
                    &mut workers,
                    &mut known,
                    &seed_slots,
                    spaces,
                ),
                Err(error) => {
                    tracing::warn!(error = error.code(), "projection catalog refresh deferred");
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(250)) => engine.discovery.notify_one(),
                    }
                }
            }
        }
    }
    for (_, worker, _) in known.values() {
        worker.cancel();
    }
    while workers.join_next().await.is_some() {}
    Ok(())
}

fn refresh_workers(
    engine: &Arc<ProjectionEngine>,
    generation: &Arc<Generation>,
    workers: &mut JoinSet<SpaceId>,
    known: &mut BTreeMap<SpaceId, (HistoryScope, Cancellation, tokio::task::Id)>,
    seed_slots: &Arc<Semaphore>,
    spaces: Vec<(Space, HistoryScope, FolderId, SpaceSeq)>,
) {
    let current: BTreeMap<_, _> = spaces
        .into_iter()
        .map(|(_, scope, _, _)| (scope.space_id.clone(), scope))
        .collect();
    known.retain(|id, (scope, cancellation, _)| {
        if current.get(id) == Some(scope) {
            return true;
        }
        // A late completion owns only the withdrawn slot. Readers can
        // register on the replacement as soon as the old waiters wake.
        let previous = generation.detach_slot(id);
        cancellation.cancel();
        if let Some(slot) = previous {
            if let Some(cut) = slot.cut.load_full()
                && let Err(error) = cut.base.invalidate(&engine.pool)
            {
                tracing::warn!(error = %error, "projection checkpoint invalidation deferred");
            }
            slot.replace(None);
        }
        if engine.generation.load().store.generation() == generation.store.generation() {
            engine.reads.invalidate_history(scope);
        }
        false
    });
    for (id, scope) in current {
        known.entry(id.clone()).or_insert_with(|| {
            let stop = Cancellation::default();
            let engine = Arc::clone(engine);
            let generation_clone = Arc::clone(generation);
            let slot = generation.ensure_slot(&id);
            let scope_clone = scope.clone();
            let seed_slots = Arc::clone(seed_slots);
            let worker_stop = stop.clone();
            let space_id = id.clone();
            let handle = workers.spawn(async move {
                run_space(
                    engine,
                    generation_clone,
                    slot,
                    scope_clone,
                    seed_slots,
                    worker_stop,
                )
                .await;
                space_id
            });
            (scope, stop, handle.id())
        });
    }
}

async fn run_space(
    engine: Arc<ProjectionEngine>,
    generation: Arc<Generation>,
    slot: Arc<SpaceSlot>,
    scope: HistoryScope,
    seed_slots: Arc<Semaphore>,
    stop: Cancellation,
) {
    let mut delay = Duration::from_millis(50);
    let mut pending_delivery = None;
    let mut last_cut_seq = None;
    let mut waiting_for_owner = false;
    while !stop.is_cancelled() {
        if engine.control.is_postgres() && check_writer(&engine, &scope).is_err() {
            if !waiting_for_owner {
                waiting_for_owner = true;
                delay = Duration::from_millis(100);
                tracing::debug!(
                    generation = generation.store.generation().get(),
                    space = %scope.space_id,
                    "projection worker waiting for PostgreSQL space ownership"
                );
            }
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(delay) => {}
            }
            delay = (delay * 2).min(Duration::from_secs(2));
            continue;
        }
        if waiting_for_owner {
            waiting_for_owner = false;
            delay = Duration::from_millis(50);
        }
        let mut made_progress = false;
        let run = run_feed(
            &engine,
            &generation,
            &slot,
            &scope,
            &seed_slots,
            &stop,
            &mut pending_delivery,
            &mut last_cut_seq,
            &mut made_progress,
        )
        .await;
        if slot.is_detached() {
            break;
        }
        if made_progress {
            delay = Duration::from_millis(50);
        }
        match run {
            Ok(()) => break,
            Err(error) if matches!(&error, PortError::Domain(domain) if domain.requires_resync()) =>
            {
                // Catalog discovery owns history replacement and wakes
                // old subscriptions even when this worker is cancelled.
                if !apply::is_history_mismatch(&error) {
                    let seq = slot
                        .cut
                        .load_full()
                        .filter(|cut| cut.cut.scope == scope)
                        .map(|cut| cut.cut.projected_seq)
                        .or(last_cut_seq);
                    if let Some(seq) = seq {
                        arm_recovery(&mut pending_delivery, seq, true);
                    }
                    slot.replace(None);
                    if engine.generation.load().store.generation() == generation.store.generation()
                    {
                        engine.reads.invalidate_history(&scope);
                    }
                }
                engine.discovery.notify_one();
            }
            Err(error) => {
                if engine.control.is_postgres() && check_writer(&engine, &scope).is_err() {
                    waiting_for_owner = true;
                    delay = Duration::from_millis(100);
                    continue;
                }
                let (reason, diagnostic_ref) = match &error {
                    PortError::Domain(DomainError::ValidationFailed { diagnostic }) => {
                        (Some(diagnostic.reason), None)
                    }
                    PortError::Domain(_) => (None, None),
                    PortError::Cancelled(failure)
                    | PortError::DeadlineExceeded(failure)
                    | PortError::Unavailable(failure)
                    | PortError::Internal(failure) => (None, Some(failure.diagnostic_ref())),
                };
                tracing::warn!(
                    generation = generation.store.generation().get(),
                    code = error.code(),
                    ?reason,
                    ?diagnostic_ref,
                    "projection feed will reopen from its durable cut"
                );
            }
        }
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_feed(
    engine: &ProjectionEngine,
    generation: &Generation,
    slot: &Arc<SpaceSlot>,
    scope: &HistoryScope,
    seed_slots: &Semaphore,
    stop: &Cancellation,
    pending_delivery: &mut Option<PendingDelivery>,
    last_cut_seq: &mut Option<SpaceSeq>,
    made_progress: &mut bool,
) -> Result<(), PortError> {
    // Subscribe before opening a private cut. A promotion concurrent with
    // that open still owes this worker a Space-local lookup rebind.
    let mut activation = engine.activation.subscribe();
    if engine.control.is_postgres() {
        engine
            .canonical
            .check_projection_writer_candidate(&engine.projection_context, &scope.space_id)?;
        if generation.store.generation() != engine.generation.load().store.generation() {
            // A candidate needs a current owner handle before staging.
            let _ = engine.live_handle(scope)?.try_read()?;
        }
    }
    let stored = generation.store.watermarks(&scope.space_id).await?;
    if let Some(bad) = slot.cut.load_full()
        && bad.cut.scope == *scope
        && bad.base.repair_pending()
    {
        arm_recovery(pending_delivery, bad.cut.projected_seq, true);
        if slot.clear_if_current(&bad) {
            // The previous lease refuses new opens. Recovery will authenticate
            // the pathname independently before deciding to reclaim it.
            engine.pool.evict(&bad.base);
            if engine.generation.load().store.generation() == generation.store.generation() {
                engine.reads.invalidate_history(scope);
            }
        }
    }
    let needs_binding = || {
        engine.generation.load().store.generation() == generation.store.generation()
            && !slot.lookup_bound.load(Ordering::Acquire)
    };
    let force_seed = matches!(
        *pending_delivery,
        Some(PendingDelivery::AfterRecovery { through, .. })
            if stored.as_ref().is_none_or(|row| row.scope != *scope || row.projected_seq < through)
    );
    let usable = slot.cut.load_full().filter(|cut| {
        !force_seed
            && cut.cut.scope == *scope
            && !cut.base.repair_pending()
            && stored.as_ref().is_some_and(|row| {
                row.scope == cut.cut.scope
                    && row.projected_seq == cut.cut.projected_seq
                    && !row.seed_in_progress
            })
    });
    let mut cut = match usable {
        Some(cut) if needs_binding() => {
            let cut = apply::bind_prefetched_cut(engine, slot, &cut).await?;
            slot.replace(Some(Arc::clone(&cut)));
            cut
        }
        Some(cut) => cut,
        None => {
            #[cfg(any(test, feature = "test-support"))]
            if matches!(
                *pending_delivery,
                Some(PendingDelivery::AfterRecovery { .. })
            ) {
                slot.benchmark_pause
                    .pause_at(super::benchmark::PausePoint::BeforeRecovery, None, stop)
                    .await;
                if stop.is_cancelled() {
                    return Ok(());
                }
            }
            let lease = tokio::select! {
                _ = stop.cancelled() => return Ok(()),
                lease = seed_slots.acquire() => lease.map_err(|_| not_ready())?,
            };
            let cut = if force_seed {
                apply::seed(engine, &generation.store, scope, slot, None, stop).await?
            } else {
                apply::recover(engine, &generation.store, scope, slot, stop).await?
            };
            drop(lease);
            if stop.is_cancelled() {
                return Ok(());
            }
            slot.replace(Some(Arc::clone(&cut)));
            *made_progress = true;
            let previous_seq = stored
                .as_ref()
                .filter(|row| row.scope == *scope)
                .map_or(SpaceSeq::ZERO, |row| row.projected_seq);
            if cut.cut.projected_seq > previous_seq {
                // Recovery can advance by seeding instead of replaying.
                arm_recovery(pending_delivery, cut.cut.projected_seq, false);
            }
            cut
        }
    };
    *last_cut_seq = Some(cut.cut.projected_seq);
    #[cfg(any(test, feature = "test-support"))]
    if cut.cut.projected_seq == SpaceSeq::ZERO {
        slot.benchmark_pause
            .pause_at(super::benchmark::PausePoint::BeforeSubscribe, None, stop)
            .await;
        if stop.is_cancelled() {
            return Ok(());
        }
    }
    let mut feed = FeedSession {
        subscription: subscribe(engine, scope, cut.cut.projected_seq).await?,
        pending_delivery,
        folders: None,
    };
    let mut graph_schedule = GraphSchedule::default();
    if cut.watermark.graph_settled_seq < cut.cut.projected_seq {
        graph_schedule.due = Some(Instant::now() + GRAPH_QUIET);
    }
    let mut last_change = (!cut.delta.is_empty()).then(Instant::now);
    loop {
        if let Some(pending) = *feed.pending_delivery
            && pending.through() <= cut.cut.projected_seq
            && pending.through() <= feed.subscription.processed().after
        {
            if stop.is_cancelled() {
                return Ok(());
            }
            if engine.generation.load().store.generation() == cut.cut.generation {
                let permit = cut.live.try_read()?;
                if pending.through() > permit.head() {
                    return Err(invalid_cut());
                }
                match pending {
                    PendingDelivery::Command(range) => {
                        engine.emit_command_refresh(scope, range, cut.cut.generation, true);
                    }
                    PendingDelivery::AfterRecovery {
                        through,
                        repeat_at_cut,
                    } => {
                        engine.emit_recovery_ready(
                            scope,
                            through,
                            repeat_at_cut,
                            cut.cut.generation,
                        );
                    }
                }
            }
            *feed.pending_delivery = None;
        }
        let checkpoint_due = last_change.map(|when: Instant| when + Duration::from_secs(5));
        tokio::select! {
            biased;
            _ = stop.cancelled() => {
                if !cut.delta.is_empty() && check_writer(engine, scope).is_ok() {
                    let _ = apply::checkpoint(engine, &cut, false, &Cancellation::default()).await;
                }
                return Ok(());
            }
            _ = slot.repair.notified() => {
                if cut.base.repair_pending() || slot.cut.load().is_none() {
                    arm_recovery(feed.pending_delivery, cut.cut.projected_seq, true);
                    return Err(not_ready());
                }
                if needs_binding() {
                    return Err(not_ready());
                }
            }
            activated = activation.changed() => {
                activated.map_err(|_| not_ready())?;
                if needs_binding() {
                    cut = apply::bind_prefetched_cut(engine, slot, &cut).await?;
                    slot.replace(Some(Arc::clone(&cut)));
                    *made_progress = true;
                }
            }
            _ = slot.align_graph.notified() => {
                if engine.active_generation() == generation.store.generation() {
                    if cut.watermark.graph_settled_seq < cut.cut.projected_seq {
                        graph_schedule.due = Some(Instant::now());
                    }
                } else {
                    let serving = engine.published_cut(scope)?;
                    if cut.handoff_graph_source.as_ptr() != Arc::as_ptr(&serving)
                        && serving.watermark.graph_settled_seq == cut.cut.projected_seq
                        && serving.cut.projected_seq == cut.cut.projected_seq
                    {
                        check_writer(engine, scope)?;
                        cut = super::graph_settle::align_for_handoff(engine, &cut, &serving, stop).await?;
                        slot.replace(Some(Arc::clone(&cut)));
                        *made_progress = true;
                    }
                }
            }
            _ = slot.checkpoint.notified() => {
                check_writer(engine, scope)?;
                cut = apply::checkpoint(engine, &cut, false, stop).await?;
                last_change = None;
                slot.replace(Some(Arc::clone(&cut)));
                *made_progress = true;
            }
            _ = timer(graph_schedule.due) => {
                check_writer(engine, scope)?;
                let settled = cut.watermark.graph_settled_seq;
                cut = apply::checkpoint(engine, &cut, true, stop).await?;
                graph_schedule = GraphSchedule::default();
                last_change = None;
                slot.replace(Some(Arc::clone(&cut)));
                *made_progress = true;
                emit_graph_settlement(engine, generation, scope, settled, &cut);
            }
            _ = timer(checkpoint_due) => {
                check_writer(engine, scope)?;
                cut = apply::checkpoint(engine, &cut, false, stop).await?;
                last_change = None;
                slot.replace(Some(Arc::clone(&cut)));
                *made_progress = true;
            }
            notice = feed.subscription.next() => match notice? {
                // Recovery already seeded the published cut, including an empty
                // Space at zero. Replay changes that raced the first subscribe.
                Some(ChangeNotice::Advanced(ceiling))
                | Some(ChangeNotice::PurgeResync { cutoff: ceiling })
                | Some(ChangeNotice::SeedRequired { cutoff: ceiling }) => {
                    check_writer(engine, scope)?;
                    let through = ceiling.after;
                    match consume(engine, generation, slot, &mut cut, &mut feed, ceiling, stop).await {
                        Ok(outcome) => {
                            *last_cut_seq = Some(cut.cut.projected_seq);
                            *made_progress = true;
                            graph_schedule.advance(outcome, Instant::now());
                            last_change = (!cut.delta.is_empty()).then(Instant::now);
                            if cut.delta.should_checkpoint(std::time::Instant::now()) {
                                cut = apply::checkpoint(engine, &cut, false, stop).await?;
                                last_change = None;
                                slot.replace(Some(Arc::clone(&cut)));
                            }
                        }
                        Err(error) if needs_seed(&error) => {
                            arm_recovery(feed.pending_delivery, through, false);
                            return Err(error);
                        }
                        Err(error) => return Err(error),
                    }
                }
                Some(ChangeNotice::Lagged { .. }) => {
                    feed.subscription = subscribe(engine, scope, cut.cut.projected_seq).await?;
                }
                Some(ChangeNotice::Resync { scope: next }) => {
                    scope.check(&next)?;
                    return Err(DomainError::validation(ValidationReason::CursorStale).into());
                }
                None => return Err(not_ready()),
            }
        }
    }
}

fn check_writer(engine: &ProjectionEngine, scope: &HistoryScope) -> Result<(), PortError> {
    engine
        .canonical
        .check_projection_writer_candidate(&engine.projection_context, &scope.space_id)
}

fn emit_graph_settlement(
    engine: &ProjectionEngine,
    generation: &Generation,
    scope: &HistoryScope,
    previous: SpaceSeq,
    cut: &PublishedCut,
) {
    if cut.watermark.graph_settled_seq > previous {
        emit_active(
            engine,
            generation,
            scope,
            cut.watermark.graph_settled_seq,
            SpaceEventKind::GraphSettled {
                generation: cut.cut.generation,
            },
        );
    }
}

async fn timer(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn subscribe(
    engine: &ProjectionEngine,
    scope: &HistoryScope,
    seq: SpaceSeq,
) -> Result<Box<dyn ChangeSubscription>, PortError> {
    engine
        .canonical
        .subscribe(
            engine.projection_context(),
            ChangeCursor {
                scope: scope.clone(),
                after: seq,
            },
        )
        .await
}

#[derive(Clone, Copy)]
enum PendingDelivery {
    Command(CommandSeqRange),
    AfterRecovery {
        through: SpaceSeq,
        repeat_at_cut: bool,
    },
}

impl PendingDelivery {
    fn through(self) -> SpaceSeq {
        match self {
            Self::Command(range) => range.last_seq,
            Self::AfterRecovery { through, .. } => through,
        }
    }
}

fn arm_recovery(pending: &mut Option<PendingDelivery>, through: SpaceSeq, mut repeat_at_cut: bool) {
    if let Some(PendingDelivery::AfterRecovery {
        through: existing,
        repeat_at_cut: previous_repeat,
    }) = *pending
    {
        if existing > through {
            return;
        }
        repeat_at_cut |= existing == through && previous_repeat;
    }
    *pending = Some(PendingDelivery::AfterRecovery {
        through,
        repeat_at_cut,
    });
}

struct FeedSession<'a> {
    folders: Option<apply::CommandFolders>,
    subscription: Box<dyn ChangeSubscription>,
    pending_delivery: &'a mut Option<PendingDelivery>,
}

struct PendingCommand {
    range: CommandSeqRange,
    changes: Vec<Change>,
    overflow: bool,
}

impl PendingCommand {
    fn new(range: CommandSeqRange) -> Self {
        Self {
            range,
            changes: Vec::new(),
            overflow: false,
        }
    }

    fn add(&mut self, change: Change) {
        if self.changes.len() < 256 {
            self.changes.push(change);
        } else {
            self.overflow = true;
        }
    }
}

#[derive(Default)]
struct AppliedFeed {
    graph_changes: u32,
    graph_settled: bool,
}

#[derive(Default)]
struct GraphSchedule {
    pending: u32,
    due: Option<Instant>,
}

impl GraphSchedule {
    fn advance(&mut self, feed: AppliedFeed, now: Instant) {
        if feed.graph_settled {
            *self = Self::default();
        }
        if feed.graph_changes != 0 {
            self.pending = self.pending.saturating_add(feed.graph_changes);
            self.due = Some(if self.pending >= GRAPH_CHANGE_LIMIT {
                now
            } else {
                now + GRAPH_QUIET
            });
        }
    }
}

async fn consume(
    engine: &ProjectionEngine,
    generation: &Generation,
    slot: &SpaceSlot,
    cut: &mut Arc<PublishedCut>,
    feed: &mut FeedSession<'_>,
    ceiling: ChangeCursor,
    stop: &Cancellation,
) -> Result<AppliedFeed, PortError> {
    ceiling.scope.check(&cut.cut.scope)?;
    let mut after = ChangeCursor {
        scope: ceiling.scope.clone(),
        after: cut.cut.projected_seq,
    };
    let mut pending = BTreeMap::<SpaceSeq, PendingCommand>::new();
    let mut outcome = AppliedFeed::default();
    while after.after < ceiling.after && !stop.is_cancelled() {
        check_writer(engine, &ceiling.scope)?;
        #[cfg(any(test, feature = "test-support"))]
        slot.benchmark_pause
            .pause_at(super::benchmark::PausePoint::BeforeCatchUp, None, stop)
            .await;
        let result = engine
            .canonical
            .catch_up(
                engine.projection_context(),
                ChangeRead::Log {
                    after: after.clone(),
                    through: ceiling.after,
                    limit: page_limit(),
                },
            )
            .await?;
        let ChangeReadResult::Log(page) = result else {
            return Err(invalid_cut());
        };
        page.next.scope.check(&ceiling.scope)?;
        if page.next.after <= after.after || page.next.after > ceiling.after {
            return Err(invalid_cut());
        }
        for change in page.changes {
            let range = change.command_range;
            pending
                .entry(range.last_seq)
                .or_insert_with(|| PendingCommand::new(range))
                .add(change);
        }
        while let Some((&seq, _)) = pending
            .first_key_value()
            .filter(|(seq, _)| **seq <= page.safe_ack_end)
        {
            if stop.is_cancelled() {
                return Ok(outcome);
            }
            let command = pending.remove(&seq).ok_or_else(invalid_cut)?;
            if command.range.first_seq != cut.cut.projected_seq.checked_next()? {
                return Err(invalid_cut());
            }
            #[cfg(any(test, feature = "test-support"))]
            {
                slot.benchmark_pause
                    .pause_at(
                        super::benchmark::PausePoint::BeforeApply,
                        Some(command.range),
                        stop,
                    )
                    .await;
                if stop.is_cancelled() {
                    return Ok(outcome);
                }
            }
            // Stage publication may commit before apply or ACK fails. Keep
            // this range across reopen until the next cut proves the outcome.
            *feed.pending_delivery = Some(PendingDelivery::Command(command.range));
            let applied =
                apply::command_with_folders(engine, cut, command.range, stop, &mut feed.folders)
                    .await?;
            if applied.cut.watermark.graph_settled_seq > cut.watermark.graph_settled_seq {
                outcome.graph_settled = true;
                outcome.graph_changes = 0;
            } else {
                outcome.graph_changes = outcome.graph_changes.saturating_add(applied.graph_changes);
            }
            *cut = applied.cut;
            if stop.is_cancelled() {
                return Ok(outcome);
            }
            slot.replace(Some(Arc::clone(cut)));
            if !acknowledge_applied(
                #[cfg(any(test, feature = "test-support"))]
                slot,
                feed.subscription.as_mut(),
                ChangeCursor {
                    scope: ceiling.scope.clone(),
                    after: seq,
                },
                stop,
            )
            .await?
            {
                return Ok(outcome);
            }
            #[cfg(any(test, feature = "test-support"))]
            slot.benchmark_pause
                .pause_at(
                    super::benchmark::PausePoint::AfterAck,
                    Some(command.range),
                    stop,
                )
                .await;
            if engine.has_event_subscribers(&ceiling.scope.space_id) {
                if !command.overflow {
                    for change in command.changes {
                        emit_active(
                            engine,
                            generation,
                            &ceiling.scope,
                            change.cursor.after,
                            SpaceEventKind::Changed(change),
                        );
                    }
                }
                if (command.overflow || !applied.boards.is_empty())
                    && engine.generation.load().store.generation() == cut.cut.generation
                {
                    let unrestricted = applied.boards.fanout() || command.overflow;
                    let mut proof_incomplete = false;
                    if !applied.boards.is_empty() {
                        let assembly = engine.board_events(cut, &applied.boards).await;
                        for board in assembly.notices {
                            engine.emit_board(board);
                        }
                        proof_incomplete = assembly.proof_incomplete;
                    }
                    if unrestricted || proof_incomplete {
                        engine.emit_command_refresh(
                            &ceiling.scope,
                            command.range,
                            cut.cut.generation,
                            unrestricted,
                        );
                    }
                }
                for event in applied.events {
                    emit_active(engine, generation, &ceiling.scope, seq, event);
                }
            }
            *feed.pending_delivery = None;
        }
        after = page.next;
        if page.complete {
            if cut.cut.projected_seq != ceiling.after || !pending.is_empty() {
                return Err(invalid_cut());
            }
            break;
        }
    }
    Ok(outcome)
}

async fn acknowledge_applied(
    #[cfg(any(test, feature = "test-support"))] slot: &SpaceSlot,
    subscription: &mut dyn ChangeSubscription,
    cursor: ChangeCursor,
    stop: &Cancellation,
) -> Result<bool, PortError> {
    let mut delay = Duration::from_millis(50);
    loop {
        let acknowledge = async {
            #[cfg(any(test, feature = "test-support"))]
            if let Some(error) = slot
                .benchmark_pause
                .inject_failure(super::benchmark::FailurePoint::Ack, cursor.after)
            {
                return Err(error);
            }
            subscription.acknowledge(cursor.clone()).await
        };
        let result = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(false),
            result = acknowledge => result,
        };
        match result {
            Ok(()) => return Ok(true),
            Err(PortError::DeadlineExceeded(_)) => {}
            Err(PortError::Unavailable(failure)) if failure.retry() != RetryAdvice::Never => {}
            Err(error) => return Err(error),
        }
        // The SQL cut and Arc are already published. Retrying the same
        // subscription keeps its notices until this idempotent ACK succeeds.
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(false),
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

fn emit_active(
    engine: &ProjectionEngine,
    generation: &Generation,
    scope: &HistoryScope,
    seq: SpaceSeq,
    event: SpaceEventKind,
) {
    engine.emit_generation(scope, seq, event, generation.store.generation());
}

fn needs_seed(error: &PortError) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if matches!(diagnostic.reason, ValidationReason::PurgeResync | ValidationReason::CursorStale))
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}

fn invalid_cut() -> PortError {
    DomainError::validation(ValidationReason::InvalidCutoff).into()
}

pub(super) fn page_limit() -> PageLimit {
    PageLimit::new(200).expect("projection page size is bounded by the port")
}

#[cfg(test)]
mod graph_schedule_tests {
    use super::*;

    #[test]
    fn settlement_debounces_and_accelerates_after_cumulative_changes() {
        let now = Instant::now();
        let later = now + Duration::from_millis(100);
        let mut schedule = GraphSchedule::default();
        schedule.advance(
            AppliedFeed {
                graph_changes: 600,
                graph_settled: false,
            },
            now,
        );
        assert_eq!(schedule.due, Some(now + GRAPH_QUIET));
        schedule.advance(
            AppliedFeed {
                graph_changes: 399,
                graph_settled: false,
            },
            later,
        );
        assert_eq!(schedule.due, Some(later + GRAPH_QUIET));
        schedule.advance(
            AppliedFeed {
                graph_changes: 1,
                graph_settled: false,
            },
            later,
        );
        assert_eq!(schedule.due, Some(later));

        schedule.advance(
            AppliedFeed {
                graph_changes: 7,
                graph_settled: true,
            },
            later,
        );
        assert_eq!(schedule.pending, 7);
        assert_eq!(schedule.due, Some(later + GRAPH_QUIET));
        schedule.advance(
            AppliedFeed {
                graph_changes: 0,
                graph_settled: true,
            },
            later,
        );
        assert_eq!(schedule.pending, 0);
        assert_eq!(schedule.due, None);
    }
}

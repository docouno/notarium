use std::{
    sync::{Mutex, atomic::Ordering},
    time::Duration,
};

use notarium_agents::{
    chats::ExclusiveDataRoot,
    keepers::{ClusterKeeperAuthority, KeeperScheduler, KeeperSlot},
};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    classes::{AbilityKind, ClassEgressFence, DocClass},
    model::FolderRef,
    ports::schedules::*,
    value::Timestamp,
};
use tokio::{io::AsyncWriteExt, net::TcpListener, time::timeout};

use super::{
    runtime_ability_cases::{
        approve_disclosure, begin_ollama_response, identity, loopback_provider, read_request,
        send_ollama,
    },
    *,
};

pub(super) async fn calendar_scope_and_orphan(fixture: &mut RuntimeFixture, space: &SpaceContext) {
    let clock = fixture.storage.clock.clone();
    let initial_clock = clock.0.load(Ordering::SeqCst);
    let set_clock = |time: Timestamp| clock.0.store(time.unix_seconds() * 1000, Ordering::SeqCst);
    let parse = |value| Timestamp::parse(value).unwrap();
    let actor = fixture.human.auth().principal().clone();
    let personal = space.scope().space_id.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = loopback_provider(fixture, &fixture.human, &listener, 112, false).await;
    approve_disclosure(
        fixture,
        &fixture.human,
        &provider,
        114,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: personal.clone(),
        },
        [DocClass::Skill, DocClass::UserDoc].into(),
    )
    .await;
    provider
        .provider
        .set_preference(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 118).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Completion,
                    resource: provider.resource.id,
                    model: provider.model,
                },
            },
        )
        .await
        .unwrap();
    let resolution = fixture
        .control
        .resolve_ability(
            fixture.human.clone(),
            AbilitySelection::Name {
                name: "research".into(),
                kind: AbilityKind::Role,
                project: None,
            },
        )
        .await
        .unwrap();
    let AbilityResolution::Resolved(role) = resolution else {
        panic!("system role did not resolve")
    };
    assert_eq!(role.reference.placement, AbilityPlacement::System);
    let approval = fixture
        .control
        .schedule_ability_candidate(
            fixture.human.clone(),
            ScheduleAbilitySelection {
                space: personal.clone(),
                project: None,
                role: role.reference.identity(),
            },
        )
        .await
        .unwrap();

    let early = parse("2026-11-01T05:30:00Z");
    let first_tick = parse("2026-11-01T06:10:00Z");
    let late = parse("2026-11-01T06:30:00Z");
    let next_week = parse("2026-11-08T06:30:00Z");
    let final_slot = parse("2026-12-01T12:00:00Z");
    let orphan_slot = parse("2026-12-01T12:05:00Z");
    let new_schedule = |tag, title: &str, cron: &str, timezone: &str, next_slot| CreateSchedule {
        id: ScheduleId::from_bytes([tag; 16]),
        definition: ScheduleDefinition {
            space: personal.clone(),
            project: None,
            title: title.into(),
            init_prompt: "Review this scheduled task.".into(),
            cron: cron.into(),
            timezone: timezone.into(),
            approved_role: approval.approved_role.clone(),
            limits: RunLimits {
                max_steps: 2,
                max_tokens: 100_000,
                timeout_ms: 20_000,
            },
        },
        approved_skills: approval.approved_skills.clone(),
        next_slot,
        paused: false,
    };
    set_clock(early);
    let weekly = create(
        fixture,
        119,
        new_schedule(
            119,
            "Historical fold runtime",
            "0 30 1 * * Sun *",
            "America/New_York",
            early,
        ),
    )
    .await;
    let finite = create(
        fixture,
        120,
        new_schedule(
            120,
            "Finite keeper runtime",
            "0 0 12 1 12 * 2026",
            "UTC",
            final_slot,
        ),
    )
    .await;
    let partial_slot = parse("2026-12-01T12:00:01Z");
    let partial = create(
        fixture,
        124,
        new_schedule(
            124,
            "Concurrent keeper",
            "1 0 12 1 12 * 2026",
            "UTC",
            partial_slot,
        ),
    )
    .await;
    let orphan = create(
        fixture,
        121,
        new_schedule(
            121,
            "Orphaned keeper runtime",
            "0 5 12 1 12 * 2026",
            "UTC",
            orphan_slot,
        ),
    )
    .await;
    let registry = provider.registry;
    let scheduler = KeeperScheduler::new_local(
        registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    set_clock(first_tick);
    successful_tick(&scheduler, first_tick, &listener, "Old scope answer").await;
    let runs = schedule_runs(fixture, &weekly.id).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].slot, early);
    assert_eq!(runs[0].reserved_next_slot, Some(next_week));
    let original_log = runs[0].keeper_log.clone().unwrap();

    // A previously persisted due timestamp could preserve the late UTC spelling
    // of a civil slot whose canonical early counterpart was already delivered.
    fixture.storage.observer.execute(
        "UPDATE agent_schedules SET next_slot_utc_ms=1793514600000 WHERE title='Historical fold runtime'",
    ).await;
    assert_eq!(late.unix_seconds() * 1000, 1_793_514_600_000);
    set_clock(late);
    let duplicate = scheduler.tick(late).await.unwrap();
    assert_eq!(
        (duplicate.claimed, duplicate.skipped_duplicate),
        (0, 1),
        "{duplicate:?}"
    );
    assert_eq!(schedule_runs(fixture, &weekly.id).await, runs);
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );

    let active_epoch = fixture
        .canonical
        .read_space(&personal)
        .await
        .unwrap()
        .active_epoch;
    let project = FolderRef {
        space_id: personal.clone(),
        folder_id: FolderId::from_bytes([119; 16]),
    };
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: space.scope().clone(),
            active_epoch,
            folder_id: project.folder_id.clone(),
            parent: None,
            slug: "keeper-runtime".into(),
            display_name: "Keeper runtime".into(),
            is_project: true,
            project_slug: Some("keeper-runtime".into()),
            actor,
            timestamp: None,
        })
        .await
        .unwrap();
    let mut schedule = fixture
        .control
        .get_schedule(space.clone(), weekly.id.clone())
        .await
        .unwrap();
    assert_eq!(schedule.next_slot, Some(next_week));
    schedule.definition.project = Some(project.clone());
    fixture
        .control
        .update_schedule(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 122).await,
                input: UpdateSchedule {
                    schedule: weekly.id.clone(),
                    expected: schedule.revision,
                    definition: schedule.definition,
                    approved_skills: Some(approval.approved_skills.clone()),
                    next_slot: schedule.next_slot,
                    paused: false,
                },
            },
        )
        .await
        .unwrap();

    set_clock(next_week);
    let wire = successful_tick(&scheduler, next_week, &listener, "New scope answer").await;
    assert!(!wire["messages"].to_string().contains("Old scope answer"));
    let runs = schedule_runs(fixture, &weekly.id).await;
    assert_eq!(runs.len(), 2);
    let scoped_log = runs
        .iter()
        .find(|run| run.slot == next_week)
        .unwrap()
        .keeper_log
        .clone()
        .unwrap();
    assert_ne!(original_log, scoped_log);
    for (id, folder) in [(original_log, None), (scoped_log, Some(&project.folder_id))] {
        let branch = fixture
            .canonical
            .read_chat(
                space.clone(),
                ChatRead {
                    thread: id,
                    leaf: ThreadEntrySeq::ZERO,
                    before: None,
                    max_entries: PageLimit::new(1).unwrap(),
                },
            )
            .await
            .unwrap();
        assert_eq!(branch.thread.kind, ChatThreadKind::KeeperLog);
        assert_eq!(branch.thread.project_folder.as_ref(), folder);
        assert_ne!(branch.thread.head, ThreadEntrySeq::ZERO);
    }
    let advanced = fixture
        .control
        .get_schedule(space.clone(), weekly.id.clone())
        .await
        .unwrap();
    fixture
        .control
        .delete_schedule(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 123).await,
                input: DeleteSchedule {
                    schedule: weekly.id,
                    expected: advanced.revision,
                },
            },
        )
        .await
        .unwrap();

    set_clock(final_slot);
    // A live provider request from the previous scan must leave capacity for
    // another schedule becoming due one second later.
    let stop = Cancellation::default();
    let provider = async {
        let (mut slow, _) = read_request(&listener).await;
        // The same Space must admit writes for the next run's log after
        // dispatch. Keep the first completion in flight by delaying its body.
        let delayed = begin_ollama_response(
            &mut slow,
            json!({"role":"assistant","content":"Final calendar answer"}),
            "stop",
        )
        .await;
        set_clock(partial_slot);
        let (mut second, _) = read_request(&listener).await;
        send_ollama(
            &mut second,
            json!({"role":"assistant","content":"Partial result"}),
            "length",
        )
        .await;
        slow.get_mut().write_all(delayed.as_bytes()).await.unwrap();
        for id in [&finite.id, &partial.id] {
            loop {
                if schedule_runs(fixture, id)
                    .await
                    .iter()
                    .any(|run| matches!(run.status, ScheduleRunStatus::Terminal(_)))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        stop.cancel();
    };
    let (poll, ()) = timeout(Duration::from_secs(12), async {
        tokio::join!(
            scheduler.poll(
                clock.clone(),
                Duration::from_millis(25),
                Duration::from_secs(60),
                stop.clone()
            ),
            provider
        )
    })
    .await
    .expect("concurrent Keeper turns did not settle");
    poll.unwrap();
    let failed = schedule_runs(fixture, &partial.id).await.pop().unwrap();
    assert_eq!(
        failed.status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Failed)
    );
    let log = failed.keeper_log.unwrap();
    let read = |leaf| ChatRead {
        thread: log.clone(),
        leaf,
        before: None,
        max_entries: PageLimit::new(1).unwrap(),
    };
    let head = fixture
        .canonical
        .read_chat(space.clone(), read(ThreadEntrySeq::ZERO))
        .await
        .unwrap()
        .thread
        .head;
    let entries = fixture
        .canonical
        .read_chat_contents(
            space.clone(),
            ChatContentRead {
                thread: log,
                leaf: head,
                entries: vec![head],
            },
        )
        .await
        .unwrap();
    assert_eq!(entries[0].interruption, Some(CompletionFinish::Length));
    assert_eq!(
        ClassEgressFence::chat_transcript(&entries[0].content, space.auth()).unwrap(),
        "Partial result"
    );
    let terminal = schedule_runs(fixture, &finite.id).await;
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].slot, final_slot);
    assert_eq!(terminal[0].reserved_next_slot, None);
    assert_eq!(
        terminal[0].status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Succeeded)
    );
    assert_eq!(
        fixture
            .control
            .get_schedule(space.clone(), finite.id)
            .await
            .unwrap()
            .next_slot,
        None,
    );
    drop(scheduler);
    let restarted = KeeperScheduler::new_local(
        registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    assert_eq!(restarted.tick(final_slot).await.unwrap().claimed, 0);
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    drop(restarted);

    // The reconciler shares the writer-slot registry with the previous owner.
    // An expired receipt alone cannot prove that the registered owner is gone.
    let shared = Arc::new(SharedAuthority::new(fixture.revocations.clone()));
    let other = KeeperScheduler::new_clustered(
        registry.clone(),
        fixture.revocations.clone(),
        shared.clone(),
    );
    set_clock(orphan_slot);
    let live = shared
        .acquire_slot(
            scheduler_context(),
            KeeperSlot {
                schedule: orphan.id.clone(),
                space: project.space_id,
                slot: orphan_slot,
            },
            Cancellation::default(),
        )
        .await
        .unwrap()
        .unwrap();
    let claim = fixture
        .control
        .claim_schedule(
            scheduler_context(),
            ClaimSchedule {
                schedule: orphan.id.clone(),
                slot: orphan_slot,
                current_role: orphan.definition.approved_role,
                expected: orphan.revision,
                next_slot: None,
            },
        )
        .await
        .unwrap();
    let ScheduleClaim::Claimed { run, .. } = claim else {
        panic!("orphan claim lost")
    };
    assert_eq!(
        other.reconcile(orphan_slot).await.unwrap().recorded_unknown,
        0
    );
    let expired = parse("2026-12-01T12:05:20Z");
    set_clock(expired);
    let deferred = other.reconcile(expired).await.unwrap();
    assert_eq!(
        (deferred.recorded_unknown, deferred.deferred),
        (0, 1),
        "{deferred:?}"
    );
    drop(live);
    let recorded = other.reconcile(expired).await.unwrap();
    assert_eq!(
        (recorded.recorded_unknown, recorded.deferred),
        (1, 0),
        "{recorded:?}"
    );
    let receipt = fixture
        .control
        .get_schedule_run(
            ScheduleRunContext::Scheduler(scheduler_context()),
            orphan.id,
            run,
        )
        .await
        .unwrap();
    assert_eq!(
        receipt.status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Unknown)
    );
    assert_eq!(other.reconcile(expired).await.unwrap().recorded_unknown, 0);
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );

    // One-shot tick(now) with 9 due minute schedules crossing a minute boundary while
    // the 9th schedule waits behind the 8-worker semaphore must refresh its next-slot
    // witness and execute all 9 runs instead of dropping the 9th as `raced`.
    let minute_slot = parse("2026-12-02T12:00:00Z");
    let tick_before_boundary = parse("2026-12-02T12:00:59Z");
    let clock_after_boundary = parse("2026-12-02T12:01:01Z");
    set_clock(minute_slot);
    let mut queued_ids = Vec::new();
    for idx in 0..9u8 {
        let tag = 200 + idx;
        let created = create(
            fixture,
            tag,
            new_schedule(
                tag,
                &format!("Minute rollover keeper {idx}"),
                "0 * * * * * *",
                "UTC",
                minute_slot,
            ),
        )
        .await;
        queued_ids.push(created.id);
    }
    set_clock(tick_before_boundary);
    let rollover_provider = async {
        let mut first_eight = Vec::with_capacity(8);
        for _ in 0..8 {
            let (socket, _) = timeout(Duration::from_secs(10), read_request(&listener))
                .await
                .expect("expected first 8 concurrent keeper requests");
            first_eight.push(socket);
        }
        // Hold all 8 worker permits past the minute boundary so the 9th schedule
        // acquires its permit after Control's clock has entered 12:01:01Z.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        set_clock(clock_after_boundary);
        for mut socket in first_eight {
            send_ollama(
                &mut socket,
                json!({"role": "assistant", "content": "Batch worker done"}),
                "stop",
            )
            .await;
        }
        let (mut ninth_socket, _) = timeout(Duration::from_secs(10), read_request(&listener))
            .await
            .expect("9th keeper must refresh next_slot after waiting past minute boundary");
        send_ollama(
            &mut ninth_socket,
            json!({"role": "assistant", "content": "Ninth worker done"}),
            "stop",
        )
        .await;
    };
    let rollover_scheduler = KeeperScheduler::new_local(
        registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let (rollover_summary, ()) = tokio::join!(
        rollover_scheduler.tick(tick_before_boundary),
        rollover_provider
    );
    let rollover_summary = rollover_summary.unwrap();
    assert_eq!(
        (
            rollover_summary.claimed,
            rollover_summary.succeeded,
            rollover_summary.raced,
            rollover_summary.errors
        ),
        (9, 9, 0, 0),
        "all 9 minute schedules must claim and succeed across minute rollover: {rollover_summary:?}"
    );
    for (idx, id) in queued_ids.into_iter().enumerate() {
        let current = fixture
            .control
            .get_schedule(space.clone(), id.clone())
            .await
            .unwrap();
        fixture
            .control
            .delete_schedule(
                fixture.human.clone(),
                AccountMutation {
                    identity: identity(fixture, &fixture.human, 210 + idx as u8).await,
                    input: DeleteSchedule {
                        schedule: id,
                        expected: current.revision,
                    },
                },
            )
            .await
            .unwrap();
    }

    // One-shot tick(now) where caller's `now` lags Control's clock across a cron boundary
    // without waiting a full wall-clock second must still step the witness past the
    // rejected slot and execute cleanly with zero errors.
    let lag_slot = parse("2026-12-02T12:10:00Z");
    let lag_now = parse("2026-12-02T12:10:59Z");
    let lag_control_clock = parse("2026-12-02T12:11:01Z");
    set_clock(lag_slot);
    let lag_schedule = create(
        fixture,
        219,
        new_schedule(
            219,
            "Lagging witness minute keeper",
            "0 * * * * * *",
            "UTC",
            lag_slot,
        ),
    )
    .await;
    set_clock(lag_control_clock);
    let lag_provider = async {
        let (mut socket, _) = timeout(Duration::from_secs(10), read_request(&listener))
            .await
            .expect("lagging tick(now) must refresh witness past minute boundary");
        send_ollama(
            &mut socket,
            json!({"role": "assistant", "content": "Lagging witness done"}),
            "stop",
        )
        .await;
    };
    let (lag_summary, ()) = tokio::join!(rollover_scheduler.tick(lag_now), lag_provider);
    let lag_summary = lag_summary.unwrap();
    assert_eq!(
        (
            lag_summary.claimed,
            lag_summary.succeeded,
            lag_summary.raced,
            lag_summary.errors
        ),
        (1, 1, 0, 0),
        "tick(now) lagging Control's clock across cron boundary must still claim and succeed: {lag_summary:?}"
    );
    let lag_current = fixture
        .control
        .get_schedule(space.clone(), lag_schedule.id.clone())
        .await
        .unwrap();
    fixture
        .control
        .delete_schedule(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 220).await,
                input: DeleteSchedule {
                    schedule: lag_schedule.id,
                    expected: lag_current.revision,
                },
            },
        )
        .await
        .unwrap();

    // Waiting behind a Control DB write lock longer than the schedule's timeout_ms
    // must not exhaust the run's execution budget before step 0, because Control
    // stamps started_at/expires_at after acquiring the lock.
    let lock_slot = parse("2026-12-02T12:20:00Z");
    set_clock(lock_slot);
    let mut short_budget_def = new_schedule(
        186,
        "Lock wait budget keeper",
        "0 20 * * * * *",
        "UTC",
        lock_slot,
    );
    short_budget_def.definition.limits.timeout_ms = 1_000;
    let lock_schedule = create(fixture, 186, short_budget_def).await;
    if fixture.storage.root.is_some() {
        fixture.storage.observer.execute("BEGIN IMMEDIATE").await;
    } else {
        fixture.storage.observer.execute("BEGIN").await;
        fixture
            .storage
            .observer
            .execute("LOCK TABLE agent_schedules IN EXCLUSIVE MODE")
            .await;
    }
    let release_lock = async {
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        fixture.storage.observer.execute("COMMIT").await;
    };
    let lock_provider = async {
        let (mut socket, _) = timeout(Duration::from_secs(10), read_request(&listener))
            .await
            .expect("keeper must reach provider after lock wait longer than timeout_ms");
        send_ollama(
            &mut socket,
            json!({"role": "assistant", "content": "Completed after lock wait"}),
            "stop",
        )
        .await;
    };
    let (lock_summary, (), ()) = tokio::join!(
        rollover_scheduler.tick(lock_slot),
        release_lock,
        lock_provider
    );
    let lock_summary = lock_summary.unwrap();
    assert_eq!(
        (
            lock_summary.claimed,
            lock_summary.succeeded,
            lock_summary.failed,
            lock_summary.errors
        ),
        (1, 1, 0, 0),
        "claim lock wait longer than timeout_ms must not fail the newly claimed run: {lock_summary:?}"
    );
    let lock_current = fixture
        .control
        .get_schedule(space.clone(), lock_schedule.id.clone())
        .await
        .unwrap();
    fixture
        .control
        .delete_schedule(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 187).await,
                input: DeleteSchedule {
                    schedule: lock_schedule.id,
                    expected: lock_current.revision,
                },
            },
        )
        .await
        .unwrap();

    // Personal defaults take precedence over project settings. Retire this
    // fixture's preference before the next provider scenario.
    fixture.storage.observer.execute(
        "DELETE FROM provider_preferences WHERE scope_kind='personal' AND resource_id='prv_70707070707070707070707070707070'",
    ).await;
    clock.0.store(initial_clock, Ordering::SeqCst);
}

async fn successful_tick(
    scheduler: &KeeperScheduler,
    now: Timestamp,
    listener: &TcpListener,
    response: &str,
) -> Value {
    let provider = async {
        let (mut socket, request) = timeout(Duration::from_secs(10), read_request(listener))
            .await
            .expect("keeper did not reach the provider");
        send_ollama(
            &mut socket,
            json!({"role":"assistant","content":response}),
            "stop",
        )
        .await;
        request
    };
    let (summary, request) = tokio::join!(scheduler.tick(now), provider);
    let summary = summary.unwrap();
    assert_eq!((summary.claimed, summary.succeeded), (1, 1), "{summary:?}");
    request
}

async fn create(fixture: &RuntimeFixture, tag: u8, input: CreateSchedule) -> AgentSchedule {
    fixture
        .control
        .create_schedule(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, tag).await,
                input,
            },
        )
        .await
        .unwrap()
        .value
}

async fn schedule_runs(fixture: &RuntimeFixture, schedule: &ScheduleId) -> Vec<ScheduleRunReceipt> {
    fixture
        .control
        .list_schedule_runs(
            ScheduleRunContext::Scheduler(scheduler_context()),
            schedule.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap()
        .items
}

fn scheduler_context() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Scheduler),
        budget: budget(),
    }
}

type SharedSlots = Arc<Mutex<BTreeSet<ScheduleId>>>;

struct SharedAuthority {
    revocations: Arc<RevocationHub>,
    slots: SharedSlots,
}

impl SharedAuthority {
    fn new(revocations: Arc<RevocationHub>) -> Self {
        Self {
            revocations,
            slots: SharedSlots::default(),
        }
    }

    fn reserve(&self, id: ScheduleId) -> Option<Box<dyn RevocationLease>> {
        self.slots.lock().unwrap().insert(id.clone()).then(|| {
            Box::new(SharedSlot {
                slots: self.slots.clone(),
                id,
            }) as Box<dyn RevocationLease>
        })
    }
}

struct SharedSlot {
    slots: SharedSlots,
    id: ScheduleId,
}

impl Drop for SharedSlot {
    fn drop(&mut self) {
        self.slots.lock().unwrap().remove(&self.id);
    }
}

impl RevocationLease for SharedSlot {
    fn check(&self) -> Result<(), PortError> {
        Ok(())
    }
}

impl ClusterKeeperAuthority for SharedAuthority {
    fn acquire_slot(
        &self,
        _ctx: MaintenanceContext,
        slot: KeeperSlot,
        _ownership_lost: Cancellation,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async move { Ok(self.reserve(slot.schedule)) })
    }

    fn fence_orphan(
        &self,
        _ctx: MaintenanceContext,
        run: ScheduleRunReceipt,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async move { Ok(self.reserve(run.schedule)) })
    }
}

impl SessionRevocationPort for SharedAuthority {
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.revocations
            .register_provider(ctx, selectors, cancellation)
    }

    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        self.revocations
            .register_canonical_effect(ctx, selectors, cancellation)
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.revocations.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.revocations.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.revocations.revoke(ctx, selector, reason)
    }
}

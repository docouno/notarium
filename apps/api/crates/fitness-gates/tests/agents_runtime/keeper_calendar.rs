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
    classes::{AbilityKind, DocClass},
    model::FolderRef,
    ports::schedules::*,
    value::Timestamp,
};
use tokio::{net::TcpListener, time::timeout};

use super::{
    runtime_ability_cases::{
        approve_disclosure, identity, loopback_provider, read_request, send_ollama,
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
        space_id: personal,
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
                    approved_skills: Some(approval.approved_skills),
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
    successful_tick(&scheduler, final_slot, &listener, "Final calendar answer").await;
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
    let other =
        KeeperScheduler::new_clustered(registry, fixture.revocations.clone(), shared.clone());
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

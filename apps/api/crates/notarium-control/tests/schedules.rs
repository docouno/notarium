#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    DomainError,
    auth::*,
    classes::{AbilityKind, DocClass},
    error::{PortError, ValidationReason},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
    value::Timestamp,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::Ordering,
};
use support::*;

fn tick(ms: i64) -> Timestamp {
    Timestamp::parse(
        &chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339(),
    )
    .unwrap()
}
fn scheduler() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Scheduler),
        budget: budget(),
    }
}
async fn identity(
    service: &ControlService,
    ctx: &AccountContext,
    key: u8,
) -> AccountCommandIdentity {
    let owner = ctx.auth().principal();
    command(
        owner,
        owner,
        key,
        service
            .account(ctx.clone(), owner.clone())
            .await
            .unwrap()
            .revision,
    )
}
async fn exercise(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "schedules").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("schedule password fixture".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let auth = service
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    let ctx = AccountContext::new(auth, budget());
    let personal = service
        .list_spaces(ctx.clone(), ControlPageRequest::new(200, None).unwrap())
        .await
        .unwrap()
        .items
        .pop()
        .unwrap();
    let space_ctx =
        SpaceContext::new(ctx.auth().clone(), personal.history.clone(), budget()).unwrap();
    let role = AbilityRef {
        id: AbilityId::from_bytes([7; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([7; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: role.clone(),
            kind: AbilityKind::Role,
            name: "scheduled-guide".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: None,
            auxiliary_files: vec![],
        });
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let definition = ScheduleDefinition {
        space: personal.space.id.clone(),
        project: None,
        title: "private schedule title".into(),
        init_prompt: "private initial prompt".into(),
        cron: "20 * * * * * *".into(),
        timezone: "UTC".into(),
        approved_role: role.clone(),
        limits: RunLimits::default(),
    };
    assert!(!format!("{definition:?}").contains("private"));
    let request = AccountMutation {
        identity: identity(&service, &ctx, 1).await,
        input: CreateSchedule {
            id: ScheduleId::from_bytes([1; 16]),
            definition: definition.clone(),
            approved_skills: vec![],
            next_slot: tick(now),
            paused: false,
        },
    };
    let created = service
        .create_schedule(ctx.clone(), request.clone())
        .await
        .unwrap()
        .value;
    let replay = service
        .create_schedule(ctx.clone(), request.clone())
        .await
        .unwrap()
        .value;
    assert_eq!(created.id, replay.id);
    let mut reused = request.clone();
    reused.input.definition.init_prompt.push('!');
    assert!(service.create_schedule(ctx.clone(), reused).await.is_err());
    let due = service
        .list_due_schedules(
            scheduler(),
            tick(now),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(due.items.len(), 1);
    let sub_ms = Timestamp::parse(
        &chrono::DateTime::from_timestamp(now / 1000, 500_123)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
    .unwrap();
    assert_eq!(
        service
            .list_due_schedules(
                scheduler(),
                sub_ms,
                ControlPageRequest::new(1, None).unwrap(),
            )
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        service
            .list_due_schedules(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                    budget: budget()
                },
                tick(now),
                ControlPageRequest::new(1, None).unwrap()
            )
            .await
            .is_err()
    );
    assert_eq!(
        service
            .list_schedules(space_ctx.clone(), ControlPageRequest::new(1, None).unwrap())
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    let claim = ClaimSchedule {
        schedule: created.id.clone(),
        slot: tick(now),
        current_role: role.clone(),
        expected: created.revision,
    };
    let mut workers = Vec::new();
    for _ in 0..3 {
        let service = service.clone();
        let claim = claim.clone();
        workers.push(tokio::spawn(async move {
            service.claim_schedule(scheduler(), claim).await
        }));
    }
    let mut winner = None;
    let mut receipts = Vec::new();
    for worker in workers {
        match worker.await.unwrap().unwrap() {
            ScheduleClaim::Claimed {
                run,
                lease,
                schedule,
                context,
            } => {
                assert!(winner.is_none());
                winner = Some((run, lease, schedule, context));
            }
            ScheduleClaim::AlreadyClaimed(receipt) => receipts.push(receipt),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(receipts.len(), 2);
    let (run, lease, advanced, keeper) = winner.unwrap();
    assert!(receipts.iter().all(|r| r.run == run && r.lease == lease));
    assert_eq!(keeper.auth().kind(), &PrincipalKind::Keeper(run.clone()));
    assert!(!keeper.auth().has_cap(Cap::AbilityWrite));
    assert_eq!(keeper.auth().spaces().len(), 1);
    assert_eq!(
        keeper
            .auth()
            .spaces()
            .values()
            .next()
            .unwrap()
            .write_classes,
        BTreeSet::from([DocClass::AgentMemory])
    );
    let account_keeper = AccountContext::new(keeper.auth().clone(), budget());
    service.whoami(account_keeper.clone()).await.unwrap();
    assert!(
        service
            .account(account_keeper.clone(), ctx.auth().principal().clone())
            .await
            .is_err()
    );
    let restarted = fixture.service(AuthenticationMode::Password).await.unwrap();
    assert!(matches!(
        restarted
            .claim_schedule(scheduler(), claim.clone())
            .await
            .unwrap(),
        ScheduleClaim::AlreadyClaimed(_)
    ));
    assert_eq!(
        restarted
            .get_schedule_run(
                ScheduleRunContext::Scheduler(scheduler()),
                created.id.clone(),
                run.clone()
            )
            .await
            .unwrap()
            .status,
        ScheduleRunStatus::Claimed
    );
    assert_eq!(advanced.next_slot, Some(tick(now + 60_000)));
    fixture.clock.0.store(now + 60_000, Ordering::SeqCst);
    let (run2, lease2, keeper2) = match service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now + 60_000),
                current_role: role.clone(),
                expected: advanced.revision,
            },
        )
        .await
        .unwrap()
    {
        ScheduleClaim::Claimed {
            run,
            lease,
            context,
            ..
        } => (run, lease, context),
        other => panic!("{other:?}"),
    };
    service.whoami(account_keeper.clone()).await.unwrap(); // Cursor advance does not revoke run 1.
    let current = service
        .get_schedule(space_ctx.clone(), created.id.clone())
        .await
        .unwrap();
    assert_eq!(current.config_revision, created.config_revision);
    let terminal = ScheduleResult {
        schedule: created.id.clone(),
        run: run.clone(),
        lease,
        outcome: ScheduleOutcome::Succeeded,
    };
    let receipt = service
        .record_schedule_result(scheduler(), terminal.clone())
        .await
        .unwrap();
    assert_eq!(
        receipt.status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Succeeded)
    );
    assert_eq!(
        service
            .record_schedule_result(scheduler(), terminal.clone())
            .await
            .unwrap(),
        receipt
    );
    assert!(service.whoami(account_keeper.clone()).await.is_err());
    service
        .whoami(AccountContext::new(keeper2.auth().clone(), budget()))
        .await
        .unwrap();
    assert_eq!(
        service
            .get_schedule(space_ctx.clone(), created.id.clone())
            .await
            .unwrap()
            .revision,
        current.revision
    );
    let mut bad = terminal;
    bad.outcome = ScheduleOutcome::Failed;
    assert!(
        service
            .record_schedule_result(scheduler(), bad)
            .await
            .is_err()
    );
    let runs = service
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(ctx.clone())),
            created.id.clone(),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(runs.items[0].run, run);
    let runs2 = service
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(ctx.clone())),
            created.id.clone(),
            ControlPageRequest::new(1, runs.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(runs2.items[0].run, run2);
    let update = AccountMutation {
        identity: identity(&service, &ctx, 2).await,
        input: UpdateSchedule {
            schedule: created.id.clone(),
            expected: current.revision,
            definition: definition.clone(),
            approved_skills: None,
            next_slot: current.next_slot,
            paused: true,
        },
    };
    let cancelled = Cancellation::default();
    let registration = fixture
        .revoker
        .register_provider(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            vec![RevocationSelector::Schedule(created.id.clone())],
            cancelled.clone(),
        )
        .await
        .unwrap();
    fixture.catalog.ability_entries.lock().unwrap()[0].healthy = false;
    let task = {
        let service = service.clone();
        let ctx = ctx.clone();
        let update = update.clone();
        tokio::spawn(async move { service.update_schedule(ctx, update).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !cancelled.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !task.is_finished(),
        "mutation must wait for registration shutdown acknowledgement"
    );
    drop(registration);
    let paused = task.await.unwrap().unwrap().value;
    fixture.catalog.ability_entries.lock().unwrap()[0].healthy = true;
    assert_eq!(paused.paused_reason, Some(SchedulePauseReason::Manual));
    assert!(
        service
            .whoami(AccountContext::new(keeper2.auth().clone(), budget()))
            .await
            .is_err()
    );
    service.update_schedule(ctx.clone(), update).await.unwrap();
    let resumed = service
        .update_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 3).await,
                input: UpdateSchedule {
                    schedule: created.id.clone(),
                    expected: paused.revision,
                    definition: definition.clone(),
                    approved_skills: None,
                    next_slot: Some(tick(now + 120_000)),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    fixture.clock.0.store(now + 120_000, Ordering::SeqCst);
    fixture.catalog.ability_entries.lock().unwrap()[0]
        .reference
        .revision = RevisionId::from_bytes([8; 16]);
    let changed = service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now + 120_000),
                current_role: role.clone(),
                expected: resumed.revision,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        changed,
        ScheduleClaim::Paused(SchedulePauseReason::RoleChanged)
    ));
    assert!(
        service
            .list_due_schedules(
                scheduler(),
                tick(now + 120_000),
                ControlPageRequest::new(200, None).unwrap()
            )
            .await
            .unwrap()
            .items
            .is_empty()
    );
    fixture.catalog.ability_entries.lock().unwrap()[0].reference = role.clone();
    let changed = service
        .get_schedule(space_ctx.clone(), created.id.clone())
        .await
        .unwrap();
    let active = service
        .update_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 4).await,
                input: UpdateSchedule {
                    schedule: created.id.clone(),
                    expected: changed.revision,
                    definition: definition.clone(),
                    approved_skills: None,
                    next_slot: Some(tick(now + 120_000)),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let (run3, lease3, keeper3) = match service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now + 120_000),
                current_role: role.clone(),
                expected: active.revision,
            },
        )
        .await
        .unwrap()
    {
        ScheduleClaim::Claimed {
            run,
            lease,
            context,
            ..
        } => (run, lease, context),
        other => panic!("{other:?}"),
    };
    fixture.clock.0.store(now + 480_000, Ordering::SeqCst);
    assert!(
        service
            .whoami(AccountContext::new(keeper3.auth().clone(), budget()))
            .await
            .is_err()
    );
    // Audit can finish expired or invalidated runs; no schedule cursor changes.
    let before_delete = service
        .get_schedule(space_ctx.clone(), created.id.clone())
        .await
        .unwrap();
    let delete = AccountMutation {
        identity: identity(&service, &ctx, 5).await,
        input: DeleteSchedule {
            schedule: created.id.clone(),
            expected: before_delete.revision,
        },
    };
    service
        .delete_schedule(ctx.clone(), delete.clone())
        .await
        .unwrap();
    service.delete_schedule(ctx.clone(), delete).await.unwrap();
    assert!(
        service
            .get_schedule(space_ctx.clone(), created.id.clone())
            .await
            .is_err()
    );
    let wrong = ScheduleResult {
        schedule: created.id.clone(),
        run: run3.clone(),
        lease: LeaseEpoch::new(2).unwrap(),
        outcome: ScheduleOutcome::Unknown,
    };
    assert!(
        service
            .record_schedule_result(scheduler(), wrong)
            .await
            .is_err()
    );
    service
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: created.id.clone(),
                run: run2,
                lease: lease2,
                outcome: ScheduleOutcome::Failed,
            },
        )
        .await
        .unwrap();
    service
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: created.id.clone(),
                run: run3,
                lease: lease3,
                outcome: ScheduleOutcome::Unknown,
            },
        )
        .await
        .unwrap();
    let persisted = fixture
        .observer
        .count("SELECT next_slot_utc_ms FROM agent_schedules LIMIT 1")
        .await;
    assert_eq!(persisted, now + 180_000);
    assert_eq!(
        fixture
            .observer
            .text("SELECT init_prompt FROM agent_schedules LIMIT 1")
            .await,
        ""
    );
    assert!(!fixture.revoker.calls.lock().unwrap().is_empty());
    // Invalid parser input, sub-minute cron, and over-budget runs cannot create rows.
    for (i, mut def) in [
        (6, definition.clone()),
        (7, definition.clone()),
        (8, definition.clone()),
        (9, definition),
    ]
    .into_iter()
    {
        match i {
            6 => def.timezone = "invalid/zone".into(),
            7 => def.cron = "every day".into(),
            8 => def.limits.max_steps = 1001,
            _ => def.cron = "* * * * * * *".into(),
        }
        assert!(
            service
                .create_schedule(
                    ctx.clone(),
                    AccountMutation {
                        identity: identity(&service, &ctx, i).await,
                        input: CreateSchedule {
                            id: ScheduleId::from_bytes([i; 16]),
                            definition: def,
                            approved_skills: vec![],
                            next_slot: tick(now),
                            paused: false
                        }
                    }
                )
                .await
                .is_err()
        );
    }
    authority_changes(&mut fixture, &service, ctx, token.expose(), role).await;
    drop(restarted);
    drop(service);
    fixture.close().await;
}
async fn authority_changes(
    fixture: &mut Fixture,
    service: &ControlService,
    mut ctx: AccountContext,
    token: &str,
    role: AbilityRef,
) {
    let other = service
        .create_account(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, &ctx, 30).await,
                input: NewAccount {
                    username: "successor".into(),
                    email: None,
                    display_name: "Successor".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let shared = service
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, &ctx, 31).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([30; 16]),
                    kind: SpaceKind::Shared,
                    name: "Scheduled workspace".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    ctx = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token))
            .await
            .unwrap(),
        budget(),
    );
    let management =
        SpaceContext::new(ctx.auth().clone(), shared.history.clone(), budget()).unwrap();
    let membership = service
        .change_membership(
            management.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([32; 16]),
                member: other.id,
                role: Some(SpaceRole::Owner),
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    let project = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([30; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project.space_id.clone(), project.folder_id.clone()),
        ProjectInfo {
            folder: project.clone(),
            name: "Scheduled project".into(),
            project_slug: "scheduled-project".into(),
        },
    );
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let definition = ScheduleDefinition {
        space: shared.space.id.clone(),
        project: Some(project.clone()),
        title: "Scope checks".into(),
        init_prompt: "Inspect project memory".into(),
        cron: "20 * * * * * *".into(),
        timezone: "UTC".into(),
        approved_role: role.clone(),
        limits: RunLimits::default(),
    };
    let created = service
        .create_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, &ctx, 33).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([30; 16]),
                    definition,
                    approved_skills: vec![],
                    next_slot: tick(now),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let (run, lease, advanced, keeper) = match service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now),
                current_role: role.clone(),
                expected: created.revision,
            },
        )
        .await
        .unwrap()
    {
        ScheduleClaim::Claimed {
            run,
            lease,
            schedule,
            context,
        } => (run, lease, schedule, context),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        keeper
            .auth()
            .spaces()
            .get(&shared.space.id)
            .unwrap()
            .project_root,
        Some(project.folder_id)
    );
    let account = AccountContext::new(keeper.auth().clone(), budget());
    service.whoami(account.clone()).await.unwrap();
    fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get_mut(&shared.space.id)
        .unwrap()
        .2
        .history
        .incarnation = HistoryIncarnation::from_bytes([99; 16]);
    assert!(service.whoami(account.clone()).await.is_err());
    fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get_mut(&shared.space.id)
        .unwrap()
        .2
        .history = shared.history.clone();
    service.whoami(account.clone()).await.unwrap();
    service
        .change_membership(
            management,
            MembershipChange {
                command: CommandKey::from_bytes([34; 16]),
                member: ctx.auth().principal().clone(),
                role: Some(SpaceRole::Viewer),
                expected: membership.revision,
            },
        )
        .await
        .unwrap();
    assert!(service.whoami(account).await.is_err());
    fixture.clock.0.store(now + 60_000, Ordering::SeqCst);
    assert!(matches!(
        service
            .claim_schedule(
                scheduler(),
                ClaimSchedule {
                    schedule: created.id.clone(),
                    slot: tick(now + 60_000),
                    current_role: role.clone(),
                    expected: advanced.revision
                }
            )
            .await
            .unwrap(),
        ScheduleClaim::Paused(SchedulePauseReason::OwnerRevoked)
    ));
    service
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: created.id,
                run,
                lease,
                outcome: ScheduleOutcome::Unknown,
            },
        )
        .await
        .unwrap();
    // Scheduled credentials are independent of session expiry, but account
    // credential resets revoke their pinned auth version too.
    let owner = service
        .account(ctx.clone(), ctx.auth().principal().clone())
        .await
        .unwrap();
    let definition = ScheduleDefinition {
        space: owner.personal_space.unwrap(),
        project: None,
        title: "Auth version check".into(),
        init_prompt: "Inspect memory".into(),
        cron: "20 * * * * * *".into(),
        timezone: "UTC".into(),
        approved_role: role.clone(),
        limits: RunLimits::default(),
    };
    let created = service
        .create_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, &ctx, 35).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([31; 16]),
                    definition,
                    approved_skills: vec![],
                    next_slot: tick(now + 60_000),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let keeper = match service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id,
                slot: tick(now + 60_000),
                current_role: role,
                expected: created.revision,
            },
        )
        .await
        .unwrap()
    {
        ScheduleClaim::Claimed { context, .. } => context,
        other => panic!("{other:?}"),
    };
    service
        .whoami(AccountContext::new(keeper.auth().clone(), budget()))
        .await
        .unwrap();
    service
        .change_password(
            ctx.clone(),
            ChangePassword {
                account: ctx.auth().principal().clone(),
                current: Some(SecretString::new("schedule password fixture".into())),
                replacement: SecretString::new("replacement schedule password".into()),
                expected: service
                    .account(ctx.clone(), ctx.auth().principal().clone())
                    .await
                    .unwrap()
                    .revision,
            },
        )
        .await
        .unwrap();
    assert!(
        service
            .whoami(AccountContext::new(keeper.auth().clone(), budget()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sqlite_schedule_claims_and_authority() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_schedule_claims_and_authority() {
    exercise(true).await;
}

async fn role_placement_scope_and_run_inspection_access(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "schedules_role_scope").await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(SecretString::new("schedule scope fixture password".into())),
            },
        )
        .await
        .unwrap();
    let raw_token = boot.session.unwrap().token;
    let mut aw_ev = evidence(AuthEvidenceKind::Session, raw_token.expose());
    aw_ev.evidence = aw_ev.evidence.with_ability_write();
    let ctx = AccountContext::new(control.resolve(aw_ev).await.unwrap(), budget());

    let shared_a = control
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([31; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared A".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let shared_b = control
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([32; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared B".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let mut aw_ev = evidence(AuthEvidenceKind::Session, raw_token.expose());
    aw_ev.evidence = aw_ev.evidence.with_ability_write();
    let ctx = AccountContext::new(control.resolve(aw_ev).await.unwrap(), budget());

    let project_a1 = FolderRef {
        space_id: shared_a.space.id.clone(),
        folder_id: FolderId::from_bytes([41; 16]),
    };
    let project_a2 = FolderRef {
        space_id: shared_a.space.id.clone(),
        folder_id: FolderId::from_bytes([42; 16]),
    };
    let project_b = FolderRef {
        space_id: shared_b.space.id.clone(),
        folder_id: FolderId::from_bytes([43; 16]),
    };
    for (proj, title) in [
        (&project_a1, "Project A1"),
        (&project_a2, "Project A2"),
        (&project_b, "Project B"),
    ] {
        fixture.catalog.project_entries.lock().unwrap().insert(
            (proj.space_id.clone(), proj.folder_id.clone()),
            ProjectInfo {
                folder: proj.clone(),
                name: title.into(),
                project_slug: title.to_ascii_lowercase().replace(' ', "-"),
            },
        );
    }

    let seed_role = |space: &Space,
                     placement: AbilityPlacement,
                     id: u8,
                     name: &str,
                     ancestors: Vec<FolderId>| {
        let reference = AbilityRef {
            id: AbilityId::from_bytes([id; 16]),
            placement,
            revision: RevisionId::from_bytes([id; 16]),
        };
        let note = NoteRef {
            space_id: space.id.clone(),
            note_id: NoteId::from_bytes([id; 16]),
        };
        fixture
            .catalog
            .ability_entries
            .lock()
            .unwrap()
            .push(AbilityDescriptor {
                attached_skills: vec![],
                promoted_from: None,
                requires_explicit_binding: false,
                reference: reference.clone(),
                kind: AbilityKind::Role,
                name: name.into(),
                description: None,
                enabled: true,
                healthy: true,
                lifecycle: Lifecycle::Active,
                entrypoint: (reference.placement != AbilityPlacement::System).then(|| note.clone()),
                auxiliary_files: vec![],
            });
        fixture.catalog.note_entries.lock().unwrap().insert(
            (space.id.clone(), note.note_id.clone()),
            CatalogNote {
                reference: note,
                lifecycle: Lifecycle::Active,
                facts: ResourceFacts {
                    space: space.clone(),
                    class: DocClass::Skill,
                    project: None,
                    ancestor_folders: ancestors,
                    folder_write_locked: false,
                    ability_package: Some(reference.id.clone()),
                },
            },
        );
        reference
    };

    let role_pa1 = seed_role(
        &shared_a.space,
        AbilityPlacement::OwnedProject(project_a1.clone()),
        50,
        "role-pa1",
        vec![project_a1.folder_id.clone()],
    );
    let role_space_a = seed_role(
        &shared_a.space,
        AbilityPlacement::OwnedSpace(shared_a.space.id.clone()),
        51,
        "role-space-a",
        vec![],
    );

    // Role placement scope enforced in episodes.
    let ep_id = EpisodeId::from_bytes([70; 16]);
    control
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 3).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: Some("scope-ep".into()),
                    },
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();

    for bad_project in [None, Some(project_a2.clone()), Some(project_b.clone())] {
        let err = control
            .update_episode(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&control, &ctx, 4).await,
                    input: EpisodeMutation::Full(EpisodeUpdate {
                        episode: ep_id.clone(),
                        expected: ControlRevision::new(1).unwrap(),
                        name: Some("scope-ep".into()),
                        active_role: Some(role_pa1.clone()),
                        project_hint: bad_project,
                        lifecycle: EpisodeLifecycle::Active,
                    }),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            PortError::Domain(DomainError::ResourceNotFound)
        ));
    }
    let cross_space_err = control
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 5).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: ep_id.clone(),
                    expected: ControlRevision::new(1).unwrap(),
                    name: Some("scope-ep".into()),
                    active_role: Some(role_space_a.clone()),
                    project_hint: Some(project_b),
                    lifecycle: EpisodeLifecycle::Active,
                }),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        cross_space_err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));

    let updated_ep = control
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 6).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: ep_id,
                    expected: ControlRevision::new(1).unwrap(),
                    name: Some("scope-ep".into()),
                    active_role: Some(role_pa1.clone()),
                    project_hint: Some(project_a1.clone()),
                    lifecycle: EpisodeLifecycle::Active,
                }),
            },
        )
        .await
        .unwrap()
        .value;
    assert_eq!(updated_ep.active_role, Some(role_pa1.clone()));

    // Space-wide schedule (`project: None`) rejects project-scoped role `role_pa1`.
    let now_ts = Timestamp::parse("2023-11-14T22:15:00Z").unwrap();
    let bad_sched = control
        .create_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 7).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([71; 16]),
                    definition: ScheduleDefinition {
                        space: shared_a.space.id.clone(),
                        project: None,
                        title: "Project role on space schedule".into(),
                        init_prompt: "Check".into(),
                        cron: "0 */5 * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: role_pa1.clone(),
                        limits: RunLimits::default(),
                    },
                    approved_skills: vec![],
                    next_slot: now_ts,
                    paused: false,
                },
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        bad_sched,
        PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::InvalidState
    ));

    // Project-pinned schedule claimed -> Keeper inspects its own run via revalidated read,
    // while narrowed credentials outside the target Space or project receive ResourceNotFound.
    let good_sched_id = ScheduleId::from_bytes([72; 16]);
    control
        .create_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 8).await,
                input: CreateSchedule {
                    id: good_sched_id.clone(),
                    definition: ScheduleDefinition {
                        space: shared_a.space.id.clone(),
                        project: Some(project_a1.clone()),
                        title: "Project A1 schedule".into(),
                        init_prompt: "Check".into(),
                        cron: "0 */5 * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: role_pa1.clone(),
                        limits: RunLimits::default(),
                    },
                    approved_skills: vec![],
                    next_slot: Timestamp::parse("2023-11-14T22:15:00Z").unwrap(),
                    paused: false,
                },
            },
        )
        .await
        .unwrap();
    fixture.clock.0.store(1_700_000_100_000, Ordering::SeqCst);
    let (claimed_run, keeper_space_ctx) = match control
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: good_sched_id.clone(),
                slot: Timestamp::parse("2023-11-14T22:15:00Z").unwrap(),
                current_role: role_pa1,
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap()
    {
        ScheduleClaim::Claimed { run, context, .. } => (run, context),
        other => panic!("expected Claimed, got {other:?}"),
    };
    let keeper_owner_ctx = ScheduleRunContext::Owner(Box::new(AccountContext::new(
        keeper_space_ctx.auth().clone(),
        budget(),
    )));
    let run_receipt = control
        .get_schedule_run(keeper_owner_ctx, good_sched_id.clone(), claimed_run.clone())
        .await
        .unwrap();
    assert_eq!(run_receipt.run, claimed_run);

    // A Keeper auth context pinned to a different AgentRunId for the same schedule
    // must NOT read another run's receipt.
    let foreign_run_keeper_auth = ctx
        .auth()
        .for_keeper(
            AgentRunId::from_bytes([74; 16]),
            shared_a.space.id.clone(),
            Some(project_a1.folder_id.clone()),
            BTreeSet::new(),
        )
        .unwrap();
    let foreign_run_err = control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(AccountContext::new(
                foreign_run_keeper_auth,
                budget(),
            ))),
            good_sched_id.clone(),
            claimed_run.clone(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        foreign_run_err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));

    let pat_shared_b = ctx
        .auth()
        .for_pat(BTreeMap::from([(
            shared_b.space.id.clone(),
            ctx.auth().spaces().get(&shared_b.space.id).unwrap().clone(),
        )]))
        .unwrap();
    let narrowed_err = control
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(AccountContext::new(pat_shared_b, budget()))),
            good_sched_id.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        narrowed_err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));

    let wrong_proj_auth = ctx
        .auth()
        .for_keeper(
            AgentRunId::from_bytes([73; 16]),
            shared_a.space.id.clone(),
            Some(project_a2.folder_id.clone()),
            BTreeSet::new(),
        )
        .unwrap();
    let wrong_proj_err = control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(AccountContext::new(wrong_proj_auth, budget()))),
            good_sched_id,
            claimed_run,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        wrong_proj_err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));

    // An ordinary schedule owner can review and explicitly approve current
    // dependency tips without authority to edit the Role or Skill.
    let interactive = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, raw_token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    assert!(!interactive.auth().has_cap(Cap::AbilityWrite));
    let skill = seed_role(
        &shared_a.space,
        AbilityPlacement::OwnedSpace(shared_a.space.id.clone()),
        63,
        "schedule-skill",
        vec![],
    );
    {
        let mut abilities = fixture.catalog.ability_entries.lock().unwrap();
        abilities
            .iter_mut()
            .find(|entry| entry.reference == skill)
            .unwrap()
            .kind = AbilityKind::Skill;
        abilities
            .iter_mut()
            .find(|entry| entry.reference == role_space_a)
            .unwrap()
            .attached_skills = vec![skill.clone()];
    }
    let selection = ScheduleAbilitySelection {
        space: shared_a.space.id.clone(),
        project: Some(project_a1.clone()),
        role: role_space_a.identity(),
    };
    let reviewed = control
        .schedule_ability_candidate(interactive.clone(), selection.clone())
        .await
        .unwrap();
    assert_eq!(reviewed.approved_skills, vec![skill.clone()]);
    let id = ScheduleId::from_bytes([78; 16]);
    let definition = ScheduleDefinition {
        space: selection.space.clone(),
        project: selection.project.clone(),
        title: "Review project memory".into(),
        init_prompt: "Review".into(),
        cron: "0 */5 * * * *".into(),
        timezone: "UTC".into(),
        approved_role: reviewed.approved_role.clone(),
        limits: RunLimits::default(),
    };
    let created = control
        .create_schedule(
            interactive.clone(),
            AccountMutation {
                identity: command(
                    interactive.auth().principal(),
                    interactive.auth().principal(),
                    91,
                    reviewed.account_revision,
                ),
                input: CreateSchedule {
                    id: id.clone(),
                    definition: definition.clone(),
                    approved_skills: reviewed.approved_skills,
                    next_slot: now_ts,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let next_slot = Timestamp::parse("2023-11-14T22:20:00Z").unwrap();
    let first = control
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: id.clone(),
                slot: now_ts,
                current_role: role_space_a.clone(),
                expected: created.revision,
            },
        )
        .await
        .unwrap();
    let ScheduleClaim::Claimed {
        run,
        lease,
        schedule: advanced,
        context,
    } = first
    else {
        panic!("approved run was not claimed");
    };
    let log_a1 = context.auth().keeper_log().unwrap().clone();
    assert!(context.auth().readonly_abilities().contains(&skill.id));
    control
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: id.clone(),
                run: run.clone(),
                lease,
                outcome: ScheduleOutcome::Succeeded,
            },
        )
        .await
        .unwrap();

    let change_skill = |revision: u8| {
        let mut abilities = fixture.catalog.ability_entries.lock().unwrap();
        let reference = &mut abilities
            .iter_mut()
            .find(|entry| entry.reference.id == skill.id)
            .unwrap()
            .reference;
        reference.revision = RevisionId::from_bytes([revision; 16]);
        reference.clone()
    };
    let skill2 = change_skill(64);
    fixture
        .clock
        .0
        .store(next_slot.unix_seconds() * 1000, Ordering::SeqCst);
    assert!(matches!(
        control
            .claim_schedule(
                scheduler(),
                ClaimSchedule {
                    schedule: id.clone(),
                    slot: next_slot,
                    current_role: role_space_a.clone(),
                    expected: advanced.revision,
                }
            )
            .await
            .unwrap(),
        ScheduleClaim::Paused(SchedulePauseReason::RoleChanged)
    ));

    let scope_ctx = SpaceContext::new(
        interactive.auth().clone(),
        shared_a.history.clone(),
        budget(),
    )
    .unwrap();
    let paused = control.get_schedule(scope_ctx, id.clone()).await.unwrap();
    let selection = ScheduleAbilitySelection {
        project: Some(project_a2.clone()),
        ..selection
    };
    let reviewed = control
        .schedule_ability_candidate(interactive.clone(), selection.clone())
        .await
        .unwrap();
    assert_eq!(reviewed.approved_skills, vec![skill2]);
    let skill3 = change_skill(65);
    let mut definition = definition;
    definition.project = Some(project_a2.clone());
    let update = |key, reviewed: ScheduleAbilityCandidate| AccountMutation {
        identity: command(
            interactive.auth().principal(),
            interactive.auth().principal(),
            key,
            reviewed.account_revision,
        ),
        input: UpdateSchedule {
            schedule: id.clone(),
            expected: paused.revision,
            definition: definition.clone(),
            approved_skills: Some(reviewed.approved_skills),
            next_slot: paused.next_slot,
            paused: false,
        },
    };
    assert!(
        control
            .update_schedule(interactive.clone(), update(92, reviewed))
            .await
            .is_err()
    );
    let reviewed = control
        .schedule_ability_candidate(interactive.clone(), selection)
        .await
        .unwrap();
    assert_eq!(reviewed.approved_skills, vec![skill3.clone()]);
    let reapproved = control
        .update_schedule(interactive.clone(), update(93, reviewed))
        .await
        .unwrap()
        .value;
    assert_eq!(reapproved.approved_skills, vec![skill3]);
    let second = control
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: id.clone(),
                slot: next_slot,
                current_role: role_space_a,
                expected: reapproved.revision,
            },
        )
        .await
        .unwrap();
    let ScheduleClaim::Claimed {
        run: second,
        context,
        ..
    } = second
    else {
        panic!("reapproved run was not claimed");
    };
    assert_ne!(context.auth().keeper_log(), Some(&log_a1));
    assert!(matches!(
        control
            .get_schedule_run(
                ScheduleRunContext::Owner(Box::new(AccountContext::new(
                    context.auth().clone(),
                    budget(),
                ))),
                id.clone(),
                run.clone(),
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let keeper_runs = control
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(AccountContext::new(
                context.auth().clone(),
                budget(),
            ))),
            id.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        keeper_runs
            .items
            .iter()
            .map(|r| r.run.clone())
            .collect::<Vec<_>>(),
        vec![second.clone()],
        "Keeper run listing must only return its own run"
    );
    let mut project_a2_grant = interactive
        .auth()
        .spaces()
        .get(&shared_a.space.id)
        .unwrap()
        .clone();
    project_a2_grant.project_root = Some(project_a2.folder_id.clone());
    let project_a2_pat = interactive
        .auth()
        .for_pat(BTreeMap::from([(
            shared_a.space.id.clone(),
            project_a2_grant,
        )]))
        .unwrap();
    let old = control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(AccountContext::new(project_a2_pat, budget()))),
            id,
            run,
        )
        .await
        .unwrap();
    assert!(
        old.keeper_log.is_none(),
        "the project grant cannot disclose the former project's log"
    );

    let expired_at = next_slot.unix_seconds() * 1000 + 300_000;
    fixture.clock.0.store(expired_at, Ordering::SeqCst);
    let expired = control
        .list_expired_schedule_runs(
            scheduler(),
            tick(expired_at),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    let second = expired
        .items
        .into_iter()
        .find(|item| item.run == second)
        .unwrap();
    assert_eq!(second.keeper_log.as_ref(), context.auth().keeper_log());
    control
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: second.schedule.clone(),
                run: second.run,
                lease: second.lease,
                outcome: ScheduleOutcome::Unknown,
            },
        )
        .await
        .unwrap();

    // 1. Delete must scrub schedule `title` and `init_prompt` to empty strings.
    let del_rev = control
        .get_schedule(
            SpaceContext::new(
                interactive.auth().clone(),
                shared_a.history.clone(),
                budget(),
            )
            .unwrap(),
            second.schedule.clone(),
        )
        .await
        .unwrap()
        .revision;
    let del_acct_rev = control
        .account(interactive.clone(), interactive.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    control
        .delete_schedule(
            interactive.clone(),
            AccountMutation {
                identity: command(
                    interactive.auth().principal(),
                    interactive.auth().principal(),
                    94,
                    del_acct_rev,
                ),
                input: DeleteSchedule {
                    schedule: second.schedule,
                    expected: del_rev,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .observer
            .count(
                "SELECT count(*) FROM agent_schedules WHERE deleted_at IS NOT NULL AND (title <> '' OR init_prompt <> '')"
            )
            .await,
        0,
        "delete_schedule must scrub both title and init_prompt on soft-deleted schedules"
    );

    // 2. Project-pinned owner must be able to review and approve a role inside their own project.
    let proj_a1_role = seed_role(
        &shared_a.space,
        AbilityPlacement::OwnedProject(project_a1.clone()),
        66,
        "proj-a1-role",
        vec![project_a1.folder_id.clone()],
    );
    let proj_a1_auth = interactive.auth().restrict_to_project(&project_a1).unwrap();
    let pinned_candidate = control
        .schedule_ability_candidate(
            AccountContext::new(proj_a1_auth.clone(), budget()),
            ScheduleAbilitySelection {
                space: shared_a.space.id.clone(),
                project: Some(project_a1.clone()),
                role: proj_a1_role.identity(),
            },
        )
        .await
        .expect("project-pinned owner must approve a role living inside their project");
    assert_eq!(pinned_candidate.approved_role, proj_a1_role);

    // 3. Narrowed caller missing `DocClass::UserDoc` read class must not mint a wider ScheduledRun.
    let narrow_read_auth = proj_a1_auth
        .restrict_read_classes(&shared_a.space.id, &BTreeSet::from([DocClass::AgentMemory]))
        .unwrap();
    let narrow_acct_rev = control
        .account(interactive.clone(), interactive.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    let narrow_create = control
        .create_schedule(
            AccountContext::new(narrow_read_auth, budget()),
            AccountMutation {
                identity: command(
                    interactive.auth().principal(),
                    interactive.auth().principal(),
                    95,
                    narrow_acct_rev,
                ),
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([79; 16]),
                    definition: ScheduleDefinition {
                        space: shared_a.space.id.clone(),
                        project: Some(project_a1.clone()),
                        title: "Narrow mint blocked".into(),
                        init_prompt: "Blocked".into(),
                        cron: "0 */5 * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: proj_a1_role,
                        limits: RunLimits::default(),
                    },
                    approved_skills: vec![],
                    next_slot: Timestamp::parse("2023-11-14T22:35:00Z").unwrap(),
                    paused: false,
                },
            },
        )
        .await;
    assert!(
        narrow_create.is_err(),
        "narrowed read_classes caller must not mint wider ScheduledRun, got {narrow_create:?}"
    );

    // 4. Claiming a schedule with a System role must NOT insert that System AbilityId
    // into `readonly_abilities`, preventing accidental exemption of a colliding owned package ID.
    let sys_role = AbilityRef {
        id: AbilityId::from_bytes([67; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([67; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            reference: sys_role.clone(),
            kind: AbilityKind::Role,
            name: "sys-role-collision-check".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: None,
            auxiliary_files: vec![],
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
        });
    let sys_acct_rev = control
        .account(interactive.clone(), interactive.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    let sys_slot = Timestamp::parse("2023-11-14T22:40:00Z").unwrap();
    let sys_sched_id = ScheduleId::from_bytes([80; 16]);
    let sys_sched = control
        .create_schedule(
            interactive.clone(),
            AccountMutation {
                identity: command(
                    interactive.auth().principal(),
                    interactive.auth().principal(),
                    96,
                    sys_acct_rev,
                ),
                input: CreateSchedule {
                    id: sys_sched_id.clone(),
                    definition: ScheduleDefinition {
                        space: shared_a.space.id.clone(),
                        project: Some(project_a1.clone()),
                        title: "System role isolation".into(),
                        init_prompt: "Run".into(),
                        cron: "0 */5 * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: sys_role.clone(),
                        limits: RunLimits::default(),
                    },
                    approved_skills: vec![],
                    next_slot: sys_slot,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    fixture
        .clock
        .0
        .store(sys_slot.unix_seconds() * 1000, Ordering::SeqCst);
    let ScheduleClaim::Claimed {
        context: sys_ctx, ..
    } = control
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: sys_sched_id,
                slot: sys_slot,
                current_role: sys_role.clone(),
                expected: sys_sched.revision,
            },
        )
        .await
        .unwrap()
    else {
        panic!("system-role schedule was not claimed");
    };
    assert!(
        !sys_ctx.auth().readonly_abilities().contains(&sys_role.id),
        "System AbilityPlacement must never be inserted into readonly_abilities"
    );

    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_role_placement_scope_and_run_inspection_access() {
    role_placement_scope_and_run_inspection_access(false).await;
}
#[tokio::test]
async fn postgres_role_placement_scope_and_run_inspection_access() {
    role_placement_scope_and_run_inspection_access(true).await;
}

async fn terminal_slots_and_migrated_folds(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "schedule_civil_windows").await;
    let mode = AuthenticationMode::TrustedNone {
        owner: PrincipalId::from_bytes([177; 16]),
    };
    let service = fixture.service(mode.clone()).await.unwrap();
    service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: None,
            },
        )
        .await
        .unwrap();
    let ctx = AccountContext::new(
        service
            .trusted_none(
                PerimeterAttestation::attest_checked().with_human_management(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let space = service
        .list_spaces(ctx.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .pop()
        .unwrap()
        .space
        .id;
    let role = AbilityRef {
        id: AbilityId::from_bytes([173; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([173; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            reference: role.clone(),
            kind: AbilityKind::Role,
            name: "calendar-test".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: None,
            auxiliary_files: vec![],
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
        });
    let parse = |date| Timestamp::parse(date).unwrap();
    let first = parse("2026-11-01T05:30:00Z");
    let late = parse("2026-11-01T06:30:00Z");
    let next = parse("2026-11-08T06:30:00Z");
    let terminal = parse("2026-12-01T12:00:00Z");
    let calendars = [
        (
            "Repeated local hour",
            "0 30 1 * * Sun *",
            "America/New_York",
            first,
        ),
        (
            "Unclaimed local hour",
            "0 30 1 * * Sun *",
            "America/New_York",
            first,
        ),
        ("Finite UTC calendar", "0 0 12 1 12 * 2026", "UTC", terminal),
        (
            "Retained fold",
            "0 30 1 * * Sun *",
            "America/New_York",
            first,
        ),
        (
            "Expired history",
            "0 30 1 * * Sun *",
            "America/New_York",
            first,
        ),
        (
            "Complete history",
            "0 30 1 * * Sun *",
            "America/New_York",
            parse("2026-10-25T05:30:00Z"),
        ),
        (
            "Reconfigured fold",
            "0 30 1 * * Sun *",
            "America/New_York",
            first,
        ),
    ];
    let mut schedules = Vec::new();
    for (key, (title, cron, timezone, slot)) in (81..).zip(calendars) {
        let created = service
            .create_schedule(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, key).await,
                    input: CreateSchedule {
                        id: ScheduleId::from_bytes([key; 16]),
                        definition: ScheduleDefinition {
                            space: space.clone(),
                            project: None,
                            title: title.into(),
                            init_prompt: "Review space".into(),
                            cron: cron.into(),
                            timezone: timezone.into(),
                            approved_role: role.clone(),
                            limits: RunLimits::default(),
                        },
                        approved_skills: Vec::new(),
                        next_slot: slot,
                        paused: false,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        schedules.push(created);
    }
    let late_time = late.unix_seconds() * 1000;
    fixture
        .clock
        .0
        .store(late_time - 20 * 60_000, Ordering::SeqCst);
    let make_claim =
        |schedule: &AgentSchedule, slot, _next_slot: Option<Timestamp>| ClaimSchedule {
            schedule: schedule.id.clone(),
            expected: schedule.revision,
            slot,
            current_role: role.clone(),
        };
    let first_claim = service
        .claim_schedule(scheduler(), make_claim(&schedules[0], first, Some(next)))
        .await
        .unwrap();
    let ScheduleClaim::Claimed {
        schedule: advanced,
        run,
        ..
    } = first_claim
    else {
        panic!("early civil occurrence was not retained");
    };
    for schedule in &schedules[3..] {
        let due = schedule.next_slot.unwrap();
        let claim = service
            .claim_schedule(scheduler(), make_claim(schedule, due, Some(next)))
            .await
            .unwrap();
        let ScheduleClaim::Claimed { run, lease, .. } = claim else {
            panic!("expected the initial slot to run");
        };
        if due == first {
            service
                .record_schedule_result(
                    scheduler(),
                    ScheduleResult {
                        schedule: schedule.id.clone(),
                        run,
                        lease,
                        outcome: ScheduleOutcome::Succeeded,
                    },
                )
                .await
                .unwrap();
        }
    }
    // Earlier schedule rows could retain both UTC representations in persisted
    // schedules. Simulate that old state after an early-slot receipt and with
    // an unclaimed schedule.
    fixture.observer.execute(
        "UPDATE agent_schedules SET next_slot_utc_ms=1793514600000 WHERE title IN ('Repeated local hour','Unclaimed local hour','Retained fold','Complete history')"
    ).await;
    // A legacy edit could also store the late cursor under a new configuration.
    fixture.observer.execute(
        "UPDATE agent_schedules SET next_slot_utc_ms=1793514600000,config_revision=config_revision+1,revision=revision+1 WHERE title='Reconfigured fold'"
    ).await;
    assert_eq!(1793514600000, late_time);
    fixture.clock.0.store(late_time, Ordering::SeqCst);
    let duplicate = make_claim(&advanced, late, Some(next));
    for _ in 0..2 {
        assert!(matches!(
            service.claim_schedule(scheduler(), duplicate.clone()).await.unwrap(),
            ScheduleClaim::SkippedDuplicate(previous) if previous.run == run
        ));
    }
    assert!(matches!(
        service
            .claim_schedule(scheduler(), make_claim(&schedules[1], late, Some(next)))
            .await
            .unwrap(),
        ScheduleClaim::Claimed { .. }
    ));

    fixture
        .clock
        .0
        .store(terminal.unix_seconds() * 1000 + 15_000, Ordering::SeqCst);
    let final_claim = make_claim(&schedules[2], terminal, None);
    let last = service
        .claim_schedule(scheduler(), final_claim.clone())
        .await
        .unwrap();
    let ScheduleClaim::Claimed {
        run,
        context,
        schedule,
        lease,
    } = last
    else {
        panic!("finite calendar lost its final due");
    };
    assert!(schedule.next_slot.is_none());
    let restarted = fixture.service(mode).await.unwrap();
    restarted
        .whoami(AccountContext::new(context.auth().clone(), budget()))
        .await
        .unwrap();
    assert!(matches!(
        restarted.claim_schedule(scheduler(), final_claim).await.unwrap(),
        ScheduleClaim::AlreadyClaimed(previous) if previous.run == run && previous.reserved_next_slot.is_none()
    ));
    restarted
        .record_schedule_result(
            scheduler(),
            ScheduleResult {
                schedule: schedule.id.clone(),
                run: run.clone(),
                lease,
                outcome: ScheduleOutcome::Succeeded,
            },
        )
        .await
        .unwrap();
    // A persisted update from an older build may point at the exact issued slot.
    assert_eq!(terminal.unix_seconds(), 1_796_126_400);
    fixture.observer.execute(
        "UPDATE agent_schedules SET next_slot_utc_ms=1796126400000 WHERE title='Finite UTC calendar'",
    ).await;
    fixture.clock.0.fetch_add(91 * 86_400_000, Ordering::SeqCst);
    let maintenance = || MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
        budget: budget(),
    };
    let receipts = "SELECT COUNT(*) FROM agent_schedule_runs WHERE slot_utc_ms=1796126400000";
    restarted
        .cleanup_telemetry(maintenance(), 200)
        .await
        .unwrap();
    assert_eq!(fixture.observer.count(receipts).await, 1);

    let owner_scope =
        SpaceContext::new(ctx.auth().clone(), context.scope().clone(), budget()).unwrap();
    // One old installation kept its late-fold cursor through cleanup. Another
    // restores the same legacy cursor after its original receipt has expired.
    assert_eq!(fixture.observer.count(
        "SELECT COUNT(*) FROM agent_schedule_runs r JOIN agent_schedules s ON s.schedule_id=r.schedule_id WHERE s.title='Retained fold'"
    ).await, 1);
    assert_eq!(fixture.observer.count(
        "SELECT COUNT(*) FROM agent_schedule_runs r JOIN agent_schedules s ON s.schedule_id=r.schedule_id WHERE s.title='Expired history'"
    ).await, 0);
    assert_eq!(fixture.observer.count(
        "SELECT COUNT(*) FROM agent_schedule_runs r JOIN agent_schedules s ON s.schedule_id=r.schedule_id WHERE s.title='Reconfigured fold' AND s.config_revision>r.config_revision"
    ).await, 1);
    fixture.observer.execute("UPDATE agent_schedules SET next_slot_utc_ms=1793514600000 WHERE title='Expired history'").await;
    let resumed_at = tick(fixture.clock.0.load(Ordering::SeqCst));
    let after_fold = notarium_control::service::compute_next_slot(
        &advanced.definition.cron,
        &advanced.definition.timezone,
        late,
        resumed_at,
    )
    .unwrap()
    .unwrap();
    for schedule in &schedules[3..] {
        let due = restarted
            .get_schedule(owner_scope.clone(), schedule.id.clone())
            .await
            .unwrap();
        let claim = make_claim(&due, late, Some(after_fold));
        for attempt in 0..2 {
            let result = restarted
                .claim_schedule(scheduler(), claim.clone())
                .await
                .unwrap();
            match schedule.definition.title.as_str() {
                "Retained fold" | "Reconfigured fold" => assert!(
                    matches!(result, ScheduleClaim::SkippedDuplicate(previous) if previous.slot == first)
                ),
                "Expired history" => {
                    assert!(matches!(result, ScheduleClaim::SkippedUnverifiedFold))
                }
                "Complete history" if attempt == 0 => {
                    assert!(matches!(result, ScheduleClaim::Claimed { .. }))
                }
                "Complete history" => {
                    assert!(matches!(result, ScheduleClaim::AlreadyClaimed(_)))
                }
                _ => unreachable!(),
            }
        }
    }
    let due = restarted
        .get_schedule(owner_scope.clone(), schedule.id.clone())
        .await
        .unwrap();
    let mut renamed = due.definition;
    renamed.title = "Renamed overdue schedule".into();
    let updated = restarted
        .update_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&restarted, &ctx, 91).await,
                input: UpdateSchedule {
                    schedule: due.id,
                    expected: due.revision,
                    definition: renamed,
                    approved_skills: None,
                    next_slot: due.next_slot,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let repair = make_claim(&updated, terminal, None);
    for _ in 0..2 {
        assert!(matches!(
            restarted.claim_schedule(scheduler(), repair.clone()).await.unwrap(),
            ScheduleClaim::SkippedDuplicate(previous) if previous.run == run
        ));
    }
    let page = restarted
        .list_due_schedules(
            scheduler(),
            terminal,
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    assert!(!page.items.iter().any(|item| item.id == schedule.id));
    restarted
        .cleanup_telemetry(maintenance(), 200)
        .await
        .unwrap();
    assert_eq!(fixture.observer.count(receipts).await, 0);

    let current = restarted
        .get_schedule(owner_scope, schedule.id.clone())
        .await
        .unwrap();
    let rewind = restarted
        .update_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&restarted, &ctx, 90).await,
                input: UpdateSchedule {
                    schedule: current.id,
                    expected: current.revision,
                    definition: current.definition,
                    approved_skills: None,
                    next_slot: Some(terminal),
                    paused: false,
                },
            },
        )
        .await;
    assert!(
        matches!(rewind, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
        if diagnostic.reason == ValidationReason::InvalidTimestamp)
    );
    fixture
        .clock
        .0
        .store(after_fold.unix_seconds() * 1000, Ordering::SeqCst);
    let repaired = restarted
        .get_schedule(
            SpaceContext::new(ctx.auth().clone(), context.scope().clone(), budget()).unwrap(),
            schedules[4].id.clone(),
        )
        .await
        .unwrap();
    assert_eq!(repaired.next_slot, Some(after_fold));
    let subsequent = notarium_control::service::compute_next_slot(
        &repaired.definition.cron,
        &repaired.definition.timezone,
        after_fold,
        after_fold,
    )
    .unwrap();
    assert!(matches!(
        restarted
            .claim_schedule(scheduler(), make_claim(&repaired, after_fold, subsequent))
            .await
            .unwrap(),
        ScheduleClaim::Claimed { .. }
    ));
    drop(restarted);
    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_terminal_slots_and_migrated_folds() {
    terminal_slots_and_migrated_folds(false).await;
}

#[tokio::test]
async fn postgres_terminal_slots_and_migrated_folds() {
    terminal_slots_and_migrated_folds(true).await;
}

async fn pinned_schedule_cursors_and_control_next_slot(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "schedules_pinned_cursors").await;
    let t0 = 1_767_225_600_000_i64; // 2026-01-01T00:00:00Z
    fixture.clock.0.store(t0, Ordering::SeqCst);
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "cursor-owner".into(),
                email: None,
                display_name: "Cursor Owner".into(),
                password: Some(SecretString::new("cursor password fixture".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let auth = service
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    let ctx = AccountContext::new(auth, budget());
    let personal = service
        .list_spaces(ctx.clone(), ControlPageRequest::new(200, None).unwrap())
        .await
        .unwrap()
        .items
        .pop()
        .unwrap();
    let role = AbilityRef {
        id: AbilityId::from_bytes([0x51; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([0x52; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: role.clone(),
            kind: AbilityKind::Role,
            name: "pinned-role".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: None,
            auxiliary_files: vec![],
        });

    let mut created = Vec::new();
    for idx in 1u8..=3 {
        let sched = service
            .create_schedule(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, 200 + idx).await,
                    input: CreateSchedule {
                        id: ScheduleId::from_bytes([0x40 + idx; 16]),
                        definition: ScheduleDefinition {
                            space: personal.space.id.clone(),
                            project: None,
                            title: format!("Pinned {idx}"),
                            init_prompt: "Run checks".into(),
                            cron: "0 */5 * * * * *".into(),
                            timezone: "UTC".into(),
                            approved_role: role.clone(),
                            limits: RunLimits::default(),
                        },
                        approved_skills: vec![],
                        next_slot: tick(t0),
                        paused: false,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        created.push(sched);
    }

    // 1. Paginate `list_due_schedules` with `requested > control_now` and advance Control's
    //    clock between page 1 and page 2: cursor pins page-1 cutoff and must NOT return CursorStale.
    let requested = tick(t0 + 120_000);
    let mut seen_due = Vec::new();
    let mut cursor = None;
    loop {
        let page = service
            .list_due_schedules(
                scheduler(),
                requested,
                ControlPageRequest::new(1, cursor).unwrap(),
            )
            .await
            .expect("due schedule page must stay valid as Control clock advances");
        seen_due.extend(page.items.into_iter().map(|s| s.id));
        if page.continuation.is_none() {
            break;
        }
        cursor = page.continuation;
        // Advance Control clock between pages!
        fixture.clock.0.fetch_add(15_000, Ordering::SeqCst);
    }
    assert_eq!(seen_due.len(), 3);

    // 2. Claim all 3 schedules when Control clock is 7 minutes ahead of `slot` (t0):
    //    Control must authoritatively compute `next_slot` strictly after Control's clock (t0 + 10m).
    let ahead = t0 + 7 * 60_000;
    fixture.clock.0.store(ahead, Ordering::SeqCst);
    let mut claimed_runs = Vec::new();
    for sched in &created {
        let ScheduleClaim::Claimed { run, schedule, .. } = service
            .claim_schedule(
                scheduler(),
                ClaimSchedule {
                    schedule: sched.id.clone(),
                    slot: tick(t0),
                    current_role: role.clone(),
                    expected: sched.revision,
                },
            )
            .await
            .unwrap()
        else {
            panic!("expected Claimed");
        };
        assert_eq!(
            schedule.next_slot,
            Some(tick(t0 + 10 * 60_000)),
            "Control must compute next_slot from max(slot, control_now)"
        );
        claimed_runs.push(run);
    }

    // 3. Advance past run expiry and paginate `list_expired_schedule_runs` while clock keeps
    //    advancing between pages (with `requested > control_now`): must not fail CursorStale.
    let after_expiry = ahead + 400_000;
    fixture.clock.0.store(after_expiry, Ordering::SeqCst);
    let expired_cutoff = tick(after_expiry + 120_000);
    let mut seen_expired = Vec::new();
    let mut cursor = None;
    loop {
        let page = service
            .list_expired_schedule_runs(
                scheduler(),
                expired_cutoff,
                ControlPageRequest::new(1, cursor).unwrap(),
            )
            .await
            .expect("expired run page must stay valid as Control clock advances");
        seen_expired.extend(page.items.into_iter().map(|r| r.run));
        if page.continuation.is_none() {
            break;
        }
        cursor = page.continuation;
        fixture.clock.0.fetch_add(10_000, Ordering::SeqCst);
    }
    assert_eq!(seen_expired.len(), claimed_runs.len());

    // 4. Config edit after a claim must NEVER masquerade as a SkippedDuplicate repair:
    //    claim(T1, rev=0) -> update_schedule(rev=1 -> rev=2) -> claim(T1, rev=1) must fail
    //    with IdempotencyKeyReused instead of returning SkippedDuplicate.
    let mut updated_def = created[0].definition.clone();
    updated_def.title = "Pinned 1 renamed".into();
    let updated = service
        .update_schedule(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 210).await,
                input: UpdateSchedule {
                    schedule: created[0].id.clone(),
                    expected: ControlRevision::new(1).unwrap(),
                    definition: updated_def,
                    approved_skills: None,
                    next_slot: Some(tick(t0 + 20 * 60_000)),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    assert_eq!(updated.revision, ControlRevision::new(2).unwrap());
    assert!(matches!(
        service
            .claim_schedule(
                scheduler(),
                ClaimSchedule {
                    schedule: created[0].id.clone(),
                    slot: tick(t0),
                    current_role: role.clone(),
                    expected: ControlRevision::new(1).unwrap(),
                },
            )
            .await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));

    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_pinned_schedule_cursors_and_control_next_slot() {
    pinned_schedule_cursors_and_control_next_slot(false).await;
}

#[tokio::test]
async fn postgres_pinned_schedule_cursors_and_control_next_slot() {
    pinned_schedule_cursors_and_control_next_slot(true).await;
}

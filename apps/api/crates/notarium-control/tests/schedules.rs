#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    auth::*,
    classes::{AbilityKind, DocClass},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
    value::Timestamp,
};
use std::{collections::BTreeSet, sync::atomic::Ordering};
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
            reference: role.clone(),
            kind: AbilityKind::Role,
            name: "scheduled-guide".into(),
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: NoteRef {
                space_id: personal.space.id.clone(),
                note_id: NoteId::from_bytes([7; 16]),
            },
            auxiliary_files: vec![],
        });
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let definition = ScheduleDefinition {
        space: personal.space.id.clone(),
        project: None,
        title: "private schedule title".into(),
        init_prompt: "private initial prompt".into(),
        cron: "* * * * * * *".into(),
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
        next_slot: tick(now + 1000),
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
    let mut different = claim.clone();
    different.next_slot = tick(now + 2000);
    assert!(
        restarted
            .claim_schedule(scheduler(), different)
            .await
            .is_err()
    );
    fixture.clock.0.store(now + 1000, Ordering::SeqCst);
    let (run2, lease2, keeper2) = match service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now + 1000),
                current_role: role.clone(),
                expected: advanced.revision,
                next_slot: tick(now + 2000),
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
                    next_slot: tick(now + 2000),
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    fixture.clock.0.store(now + 2000, Ordering::SeqCst);
    fixture.catalog.ability_entries.lock().unwrap()[0]
        .reference
        .revision = RevisionId::from_bytes([8; 16]);
    let changed = service
        .claim_schedule(
            scheduler(),
            ClaimSchedule {
                schedule: created.id.clone(),
                slot: tick(now + 2000),
                current_role: role.clone(),
                expected: resumed.revision,
                next_slot: tick(now + 3000),
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
                tick(now + 2000),
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
                    next_slot: tick(now + 2000),
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
                slot: tick(now + 2000),
                current_role: role.clone(),
                expected: active.revision,
                next_slot: tick(now + 3000),
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
    fixture.clock.0.store(now + 302_000, Ordering::SeqCst);
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
    assert_eq!(persisted, now + 3000);
    assert!(!fixture.revoker.calls.lock().unwrap().is_empty());
    // Invalid parser input and over-budget runs cannot create rows.
    for (i, mut def) in [
        (6, definition.clone()),
        (7, definition.clone()),
        (8, definition),
    ]
    .into_iter()
    {
        match i {
            6 => def.timezone = "invalid/zone".into(),
            7 => def.cron = "every day".into(),
            _ => def.limits.max_steps = 1001,
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
        },
    );
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let definition = ScheduleDefinition {
        space: shared.space.id.clone(),
        project: Some(project.clone()),
        title: "Scope checks".into(),
        init_prompt: "Inspect project memory".into(),
        cron: "* * * * * * *".into(),
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
                next_slot: tick(now + 1000),
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
    fixture.clock.0.store(now + 1000, Ordering::SeqCst);
    assert!(matches!(
        service
            .claim_schedule(
                scheduler(),
                ClaimSchedule {
                    schedule: created.id.clone(),
                    slot: tick(now + 1000),
                    next_slot: tick(now + 2000),
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
        cron: "* * * * * * *".into(),
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
                    next_slot: tick(now + 1000),
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
                slot: tick(now + 1000),
                next_slot: tick(now + 2000),
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

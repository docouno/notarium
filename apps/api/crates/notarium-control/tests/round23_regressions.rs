#[allow(dead_code)]
#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_control::{
    auth::token,
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlService,
        oauth::{OAuthConfig, OAuthService},
    },
    store::TargetRecord,
};
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
use provider::*;
use std::sync::{Arc, atomic::Ordering};
use support::*;

const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const BROWSER: &str = "a-random-browser-binding-with-at-least-32-bytes";

async fn next_identity(
    control: &ControlService,
    ctx: &AccountContext,
    key: u8,
) -> AccountCommandIdentity {
    let owner = ctx.auth().principal();
    let revision = control
        .account(ctx.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    command(owner, owner, key, revision)
}

async fn run_oauth_reuse_gc_and_diag_import(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "reg_oauth_gc").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(SecretString::new("round23 oauth password".into())),
            },
        )
        .await
        .unwrap();
    let session = boot.session.unwrap();
    let ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let oauth = Arc::new(
        OAuthService::new(
            control.clone(),
            keys,
            Arc::new(OutboundTransport::new(NetworkPolicy::default())),
            OAuthConfig {
                issuer: "https://auth.example/".into(),
                authorization_endpoint: "https://auth.example/authorize".into(),
                token_endpoint: "https://auth.example/token".into(),
                registration_endpoint: "https://auth.example/register".into(),
                revocation_endpoint: "https://auth.example/revoke".into(),
            },
        )
        .unwrap(),
    );

    let client = oauth
        .register_client(
            budget(),
            RegisterOAuthClient {
                client_name: "CLI".into(),
                redirect_uris: vec!["http://127.0.0.1:54321/callback".into()],
            },
        )
        .await
        .unwrap();

    let issue_offline = |ctx: AccountContext| {
        let oauth = oauth.clone();
        let client_id = client.client_id.clone();
        async move {
            let prepared = oauth
                .prepare_authorization(
                    ctx.clone(),
                    PrepareOAuthAuthorization {
                        client_id: client_id.clone(),
                        redirect_uri: "http://127.0.0.1:54321/callback".into(),
                        resource: "https://resource.example/".into(),
                        scope: "read offline_access".into(),
                        selected_spaces: Some(vec![]),
                        code_challenge: URL_SAFE_NO_PAD.encode(token::digest(VERIFIER.as_bytes())),
                        code_challenge_method: "S256".into(),
                        browser_binding: SecretString::new(BROWSER.into()),
                    },
                )
                .await
                .unwrap();
            let approved = oauth
                .approve_authorization(
                    ctx,
                    OAuthConsent::attest_checked(
                        prepared.intent,
                        SecretString::new(BROWSER.into()),
                    ),
                )
                .await
                .unwrap();
            oauth
                .exchange_code(
                    budget(),
                    ExchangeOAuthCode {
                        client_id,
                        code: approved.code,
                        redirect_uri: "http://127.0.0.1:54321/callback".into(),
                        resource: "https://resource.example/".into(),
                        code_verifier: SecretString::new(VERIFIER.into()),
                    },
                )
                .await
                .unwrap()
        }
    };

    // Family 1: rotate RT_1 -> RT_2 at t = T0.
    let first = issue_offline(ctx.clone()).await;
    let rt1 = first.refresh_token.unwrap().expose().to_owned();
    let rotated = oauth
        .refresh(
            budget(),
            RefreshOAuthToken {
                client_id: client.client_id.clone(),
                refresh_token: SecretString::new(rt1.clone()),
                resource: "https://resource.example/".into(),
                scope: None,
            },
        )
        .await
        .unwrap();
    let rt2 = rotated.refresh_token.unwrap().expose().to_owned();

    // Family 2: unrotated offline_access family (`revoked_at IS NULL`) that expires naturally.
    let ctx2 = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let _second = issue_offline(ctx2).await;

    // Advance +8 days (> 7d, < 30d refresh lifetime) and run cleanup_telemetry.
    let t0 = fixture.clock.0.load(Ordering::SeqCst);
    fixture.clock.0.store(t0 + 8 * 86_400_000, Ordering::SeqCst);
    control
        .cleanup_telemetry(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
                budget: budget(),
            },
            200,
        )
        .await
        .unwrap();

    // IMPL-040: Rotated RT_1 tombstone MUST remain intact on day 8 so replay revokes Family 1!
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM oauth_refresh_tokens")
            .await,
        3,
        "rotated refresh tombstone must not be deleted before expires_at + 7d"
    );
    let replay_err = oauth
        .refresh(
            budget(),
            RefreshOAuthToken {
                client_id: client.client_id.clone(),
                refresh_token: SecretString::new(rt1),
                resource: "https://resource.example/".into(),
                scope: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        replay_err,
        PortError::Domain(DomainError::OAuth {
            error: OAuthErrorCode::InvalidGrant
        })
    ));
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM oauth_refresh_families WHERE reason_code='refresh_reuse' AND revoked_at IS NOT NULL")
            .await,
        1,
        "replaying stolen RT_1 on day 8 must revoke the active OAuth family"
    );
    assert!(
        oauth
            .refresh(
                budget(),
                RefreshOAuthToken {
                    client_id: client.client_id.clone(),
                    refresh_token: SecretString::new(rt2),
                    resource: "https://resource.example/".into(),
                    scope: None,
                },
            )
            .await
            .is_err(),
        "live successor RT_2 must be rejected once RT_1 reuse revokes the family"
    );

    // Advance +40 days (> 30d expiry + 7d retention) and run cleanup_telemetry.
    fixture
        .clock
        .0
        .store(t0 + 40 * 86_400_000, Ordering::SeqCst);
    control
        .cleanup_telemetry(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
                budget: budget(),
            },
            200,
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM oauth_refresh_tokens")
            .await,
        0
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM oauth_refresh_families")
            .await,
        0,
        "both revoked and naturally expired unrevoked families must be pruned once childless"
    );

    // IMPL-043: ProviderCallLog with > 2048-byte diagnostic imports cleanly on SQLite & PG.
    let owner_id = boot.account.id.to_string();
    let personal_space = boot.account.personal_space.unwrap().to_string();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='migrating'")
        .await;
    fixture
        .store
        .import_target_batch(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            &[TargetRecord::ProviderCallLog {
                call_id: RequestId::from_bytes([92; 16]).to_string(),
                owner_id: owner_id.clone(),
                principal: owner_id,
                run_id: None,
                scope_id: format!("space:{personal_space}"),
                intent_key: CommandKey::from_bytes([93; 16]).to_string(),
                request_hash: vec![9; 32],
                resource_id: ProviderResourceId::from_bytes([91; 16]).to_string(),
                credential_id: None,
                policy_epochs: "{}".into(),
                participating_spaces: "[]".into(),
                model_id: None,
                reserved_tokens: 10,
                bucket_keys: "[]".into(),
                delivery_state: "settled".into(),
                outcome: Some("completed".into()),
                usage_source: "exact".into(),
                input_tokens: Some(5),
                output_tokens: Some(5),
                diagnostic: Some("d".repeat(3_200)),
                dispatch_owner: None,
                created_at: t0,
                settled_at: Some(t0),
            }],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;

    drop(oauth);
    drop(control);
    fixture.close().await;
}

async fn run_pool_isolation_role_scope_and_race_idempotency(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "reg_pool_scope").await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(SecretString::new("round23 pool password".into())),
            },
        )
        .await
        .unwrap();
    let raw_token = boot.session.unwrap().token;

    // IMPL-044: Ambient session cannot logout, and AbilityWrite requires human_management.
    let ambient_with_ability_flag = control
        .resolve(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(AuthEvidenceKind::Session, raw_token.expose().into())
                .with_ability_write(),
        })
        .await
        .unwrap();
    assert!(!ambient_with_ability_flag.human_management());
    assert!(
        !ambient_with_ability_flag.has_cap(Cap::AbilityWrite),
        "Cap::AbilityWrite must never be granted without human_management"
    );
    let ambient_logout = control
        .logout(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(AuthEvidenceKind::Session, raw_token.expose().into()),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        ambient_logout,
        PortError::Domain(DomainError::AccessDenied)
    ));

    let ctx = AccountContext::new(
        control
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Session, raw_token.expose().into())
                    .with_human_management()
                    .with_ability_write(),
            })
            .await
            .unwrap(),
        budget(),
    );
    assert!(ctx.auth().has_cap(Cap::AbilityWrite));

    // Create two shared Spaces (`shared_a` with projects P_A1, P_A2 and `shared_b` with P_B).
    let shared_a = control
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 1).await,
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
                identity: next_identity(&control, &ctx, 2).await,
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
    let ctx = AccountContext::new(
        control
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Session, raw_token.expose().into())
                    .with_human_management()
                    .with_ability_write(),
            })
            .await
            .unwrap(),
        budget(),
    );

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
            },
        );
    }

    let seed_ability = |space: &Space,
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
                reference: reference.clone(),
                kind: AbilityKind::Role,
                name: name.into(),
                enabled: true,
                healthy: true,
                lifecycle: Lifecycle::Active,
                entrypoint: note.clone(),
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
                    ancestor_folders: ancestors,
                    folder_write_locked: false,
                    ability_package: Some(reference.id.clone()),
                },
            },
        );
        reference
    };

    let role_pa1 = seed_ability(
        &shared_a.space,
        AbilityPlacement::OwnedProject(project_a1.clone()),
        50,
        "role-pa1",
        vec![project_a1.folder_id.clone()],
    );
    let role_space_a = seed_ability(
        &shared_a.space,
        AbilityPlacement::OwnedSpace(shared_a.space.id.clone()),
        51,
        "role-space-a",
        vec![],
    );
    for idx in 0..25_u8 {
        seed_ability(
            &shared_a.space,
            AbilityPlacement::System,
            60 + idx,
            &format!("sys-role-{idx:02}"),
            vec![],
        );
    }

    // IMPL-042: N+1 elimination on runtime discover_abilities (27 unique names -> 1 catalog.abilities call).
    fixture.catalog.abilities_calls.store(0, Ordering::SeqCst);
    let discovered = control
        .discover_abilities(
            ctx.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: Some(project_a1.clone()),
                kind: None,
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(discovered.items.len(), 27);
    assert_eq!(
        fixture.catalog.abilities_calls.load(Ordering::SeqCst),
        1,
        "single-page runtime discover_abilities must make 1 catalog.abilities call, not N+1"
    );

    // IMPL-042: Role placement scope enforced in episodes & schedules.
    let ep_id = EpisodeId::from_bytes([70; 16]);
    control
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 3).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: Some("scope-ep".into()),
                    },
                    project_hint: None,
                },
            },
        )
        .await
        .unwrap();

    // Project role rejected when episode has no project_hint or a different project_hint.
    for bad_project in [None, Some(project_a2.clone()), Some(project_b.clone())] {
        let err = control
            .update_episode(
                ctx.clone(),
                AccountMutation {
                    identity: next_identity(&control, &ctx, 4).await,
                    input: EpisodeUpdate {
                        episode: ep_id.clone(),
                        expected: ControlRevision::new(1).unwrap(),
                        name: Some("scope-ep".into()),
                        active_role: Some(role_pa1.clone()),
                        project_hint: bad_project,
                        lifecycle: EpisodeLifecycle::Active,
                    },
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            PortError::Domain(DomainError::ResourceNotFound)
        ));
    }
    // Space-A role rejected when episode project_hint points to Space-B.
    let cross_space_err = control
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 5).await,
                input: EpisodeUpdate {
                    episode: ep_id.clone(),
                    expected: ControlRevision::new(1).unwrap(),
                    name: Some("scope-ep".into()),
                    active_role: Some(role_space_a.clone()),
                    project_hint: Some(project_b.clone()),
                    lifecycle: EpisodeLifecycle::Active,
                },
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        cross_space_err,
        PortError::Domain(DomainError::ResourceNotFound)
    ));

    // Project-A1 role succeeds when project_hint == Some(project_a1).
    let updated_ep = control
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 6).await,
                input: EpisodeUpdate {
                    episode: ep_id.clone(),
                    expected: ControlRevision::new(1).unwrap(),
                    name: Some("scope-ep".into()),
                    active_role: Some(role_pa1.clone()),
                    project_hint: Some(project_a1.clone()),
                    lifecycle: EpisodeLifecycle::Active,
                },
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
                identity: next_identity(&control, &ctx, 7).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([71; 16]),
                    definition: ScheduleDefinition {
                        space: shared_a.space.id.clone(),
                        project: None,
                        title: "Bad project role on space schedule".into(),
                        init_prompt: "Check".into(),
                        cron: "0 */5 * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: role_pa1.clone(),
                        limits: RunLimits::default(),
                    },
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

    // IMPL-041: 20 concurrent slow catalog reads (> 16 pool connections!) never hold ReadTransaction
    // or starve concurrent writers!
    fixture
        .catalog
        .abilities_gate
        .enabled
        .store(true, Ordering::SeqCst);
    let mut reader_handles = Vec::with_capacity(20);
    for _ in 0..20 {
        let svc = control.clone();
        let rctx = ctx.clone();
        let proj = project_a1.clone();
        reader_handles.push(tokio::spawn(async move {
            svc.discover_abilities(
                rctx,
                AbilityQuery {
                    page: ControlPageRequest::new(50, None).unwrap(),
                    project: Some(proj),
                    kind: None,
                    name: None,
                    authoring: false,
                },
            )
            .await
        }));
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.catalog.abilities_gate.entered.acquire_many(20),
    )
    .await
    .expect("all 20 readers must enter catalog without holding 16-slot ReadTransaction")
    .unwrap()
    .forget();

    // While all 20 catalog reads are suspended in flight, writers succeed immediately!
    let write_call_id = RequestId::from_bytes([80; 16]);
    control
        .begin_agent_call(
            ctx.clone(),
            BeginAgentCall {
                call: write_call_id.clone(),
                request: RequestId::from_bytes([81; 16]),
                episode: Some(ep_id.clone()),
                operation: AgentOperation::Search,
                transport: AgentTransport::Mcp,
                effect: AgentEffect::Read,
                input_bytes: 32,
            },
        )
        .await
        .expect("writer must not starve behind 20 slow catalog reads");

    fixture
        .catalog
        .abilities_gate
        .enabled
        .store(false, Ordering::SeqCst);
    fixture.catalog.abilities_gate.release.add_permits(20);
    for handle in reader_handles {
        let page = handle.await.unwrap().unwrap();
        assert_eq!(page.items.len(), 27);
    }

    // IMPL-044: 10-way concurrent identical client-ID inserts succeed idempotently on SQLite & PG.
    let race_call = RequestId::from_bytes([85; 16]);
    let race_retrieval = RequestId::from_bytes([86; 16]);
    let mut race_tasks = Vec::new();
    for _ in 0..10 {
        let svc = control.clone();
        let c = ctx.clone();
        let call_id = race_call.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.begin_agent_call(
                c,
                BeginAgentCall {
                    call: call_id,
                    request: RequestId::from_bytes([87; 16]),
                    episode: None,
                    operation: AgentOperation::Read,
                    transport: AgentTransport::Mcp,
                    effect: AgentEffect::Read,
                    input_bytes: 16,
                },
            )
            .await
        }));
        let svc = control.clone();
        let c = ctx.clone();
        let ret_id = race_retrieval.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.record_agent_retrieval(
                c,
                AgentRetrieval {
                    id: ret_id,
                    call: None,
                    kind: RetrievalKind::FullText,
                    hits: vec![],
                    result_count: 0,
                    top_score: None,
                },
            )
            .await
        }));
        let svc = control.clone();
        let c = ctx.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.record_mcp_dedup(
                c,
                McpDedupRecord {
                    key: McpDedupKey {
                        actor: "mcp-client".into(),
                        request_key: CommandKey::from_bytes([88; 16]),
                        request_hash: ContentDigest::from_bytes([89; 32]),
                        operation: "create_note".into(),
                    },
                    safe_result: "{\"ok\":true}".into(),
                    effect: AgentEffect::Write,
                    ttl_ms: 60_000,
                },
            )
            .await
        }));
    }
    for task in race_tasks {
        task.await.unwrap().expect(
            "concurrent identical client-ID inserts must be idempotent without 23505 Unavailable",
        );
    }

    // Interactive logout succeeds.
    control
        .logout(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(AuthEvidenceKind::Session, raw_token.expose().into())
                .with_human_management(),
        })
        .await
        .unwrap();

    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_oauth_reuse_gc_and_diag_import() {
    run_oauth_reuse_gc_and_diag_import(false).await;
}
#[tokio::test]
async fn postgres_oauth_reuse_gc_and_diag_import() {
    run_oauth_reuse_gc_and_diag_import(true).await;
}

#[tokio::test]
async fn sqlite_pool_isolation_role_scope_and_race_idempotency() {
    run_pool_isolation_role_scope_and_race_idempotency(false).await;
}
#[tokio::test]
async fn postgres_pool_isolation_role_scope_and_race_idempotency() {
    run_pool_isolation_role_scope_and_race_idempotency(true).await;
}

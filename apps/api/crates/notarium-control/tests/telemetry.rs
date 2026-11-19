#[allow(dead_code)]
#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;
use notarium_control::{
    service::{AuthenticationMode, ControlService},
    store::TargetRecord,
};
use notarium_core::{
    auth::*,
    ids::*,
    model::HistoryScope,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use provider::keyring;
use std::{collections::BTreeMap, sync::atomic::Ordering};
use support::*;
fn maintenance() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
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
fn start(id: u8) -> BeginAgentCall {
    BeginAgentCall {
        call: RequestId::from_bytes([id; 16]),
        request: RequestId::from_bytes([id; 16]),
        episode: None,
        operation: AgentOperation::Search,
        transport: AgentTransport::Mcp,
        effect: AgentEffect::Read,
        input_bytes: 128,
    }
}
fn finish(id: u8, detail: AgentCallDetail) -> FinishAgentCall {
    FinishAgentCall {
        call: RequestId::from_bytes([id; 16]),
        outcome: AgentOutcome::Succeeded,
        failure: None,
        output_bytes: 256,
        detail: Some(detail),
    }
}
async fn exercise(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "telemetry").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("telemetry fixture password".into())),
            },
        )
        .await
        .unwrap();
    let token = boot.session.unwrap().token;
    let ctx = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let settings = service.telemetry_settings(ctx.clone()).await.unwrap();
    assert!(!settings.detailed_enabled);
    assert_eq!(
        (
            settings.compact_retention_days,
            settings.detailed_retention_days
        ),
        (90, 30)
    );
    let payload = AgentCallDetail {
        resources: vec![
            TelemetryResource::Space(boot.account.personal_space.clone().unwrap()),
            TelemetryResource::Space(SpaceId::from_bytes([99; 16])),
        ],
        counters: vec![CounterSample {
            counter: AgentCounter::CacheHits,
            value: 3,
        }],
        steps: vec![AgentStepSummary {
            operation: AgentOperation::Search,
            outcome: AgentOutcome::Succeeded,
            duration_ms: 12,
        }],
    };
    let mut forbidden = serde_json::to_value(&payload).unwrap();
    forbidden["prompt"] = "must not persist".into();
    assert!(serde_json::from_value::<AgentCallDetail>(forbidden).is_err());
    service
        .begin_agent_call(ctx.clone(), start(1))
        .await
        .unwrap();
    service
        .begin_agent_call(ctx.clone(), start(1))
        .await
        .unwrap();
    let mut reused = start(1);
    reused.input_bytes = 129;
    assert!(service.begin_agent_call(ctx.clone(), reused).await.is_err());
    service
        .finish_agent_call(maintenance(), finish(1, payload.clone()))
        .await
        .unwrap();
    assert!(
        service
            .get_agent_call(ctx.clone(), RequestId::from_bytes([1; 16]))
            .await
            .unwrap()
            .detail
            .is_none()
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM agent_call_details")
            .await,
        0
    );
    let delegated = AccountContext::new(ctx.auth().for_pat(BTreeMap::new()).unwrap(), budget());
    assert!(service.telemetry_settings(delegated.clone()).await.is_err());
    let enable = AccountMutation {
        identity: identity(&service, &ctx, 1).await,
        input: TelemetrySettings {
            detailed_enabled: true,
            ..settings
        },
    };
    let enabled = service
        .update_telemetry_settings(ctx.clone(), enable.clone())
        .await
        .unwrap();
    assert!(enabled.value.detailed_enabled);
    service
        .update_telemetry_settings(ctx.clone(), enable)
        .await
        .unwrap();
    service
        .begin_agent_call(ctx.clone(), start(2))
        .await
        .unwrap();
    service
        .finish_agent_call(maintenance(), finish(2, payload.clone()))
        .await
        .unwrap();
    let full = service
        .get_agent_call(ctx.clone(), RequestId::from_bytes([2; 16]))
        .await
        .unwrap();
    assert_eq!(full.detail.unwrap().resources.len(), 1);
    let limited = service
        .get_agent_call(delegated.clone(), RequestId::from_bytes([2; 16]))
        .await
        .unwrap();
    assert!(limited.detail.unwrap().resources.is_empty());
    service
        .finish_agent_call(maintenance(), finish(2, payload.clone()))
        .await
        .unwrap();
    let mut reused = finish(2, payload.clone());
    reused.output_bytes = 257;
    assert!(
        service
            .finish_agent_call(maintenance(), reused)
            .await
            .is_err()
    );
    assert!(
        service
            .finish_agent_call(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Scheduler),
                    budget: budget()
                },
                finish(2, payload.clone())
            )
            .await
            .is_err()
    );
    let mut too_big = payload.clone();
    too_big.steps = vec![too_big.steps[0].clone(); 201];
    assert!(
        service
            .finish_agent_call(maintenance(), finish(2, too_big))
            .await
            .is_err()
    );
    // An orphaned crashed call (> 24h old) is eligible for GC, while an active
    // recent call (< 24h old) and its child retrieval must be preserved.
    service
        .begin_agent_call(ctx.clone(), start(99))
        .await
        .unwrap();
    let retrieval = AgentRetrieval {
        id: RequestId::from_bytes([4; 16]),
        call: Some(RequestId::from_bytes([2; 16])),
        kind: RetrievalKind::Hybrid,
        hits: vec![],
        result_count: 2,
        top_score: Some(0.5),
    };
    service
        .record_agent_retrieval(ctx.clone(), retrieval.clone())
        .await
        .unwrap();
    service
        .record_agent_retrieval(ctx.clone(), retrieval.clone())
        .await
        .unwrap();
    let mut reused = retrieval.clone();
    reused.result_count = 3;
    assert!(
        service
            .record_agent_retrieval(ctx.clone(), reused)
            .await
            .is_err()
    );
    let first = service
        .list_agent_calls(ctx.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].start.call, RequestId::from_bytes([1; 16]));
    let second = service
        .list_agent_calls(
            ctx.clone(),
            ControlPageRequest::new(1, first.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.items[0].start.call, RequestId::from_bytes([2; 16]));
    assert!(second.items[0].detail.is_none());
    fixture.observer.execute("INSERT INTO control_commands(owner,actor,command_key,request_hash,target,expected,state,expires_at) SELECT owner,actor,'cmd_ffffffffffffffffffffffffffffffff',request_hash,'pending-fixture',0,'pending',0 FROM control_commands LIMIT 1").await;
    fixture.clock.0.fetch_add(29 * 86_400_000, Ordering::SeqCst);
    // Touch session within its 30d window so we can open an active in-flight call right before retention GC.
    let ctx_mid = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    fixture.clock.0.fetch_add(29 * 86_400_000, Ordering::SeqCst);
    let _ = service
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    fixture.clock.0.fetch_add(29 * 86_400_000, Ordering::SeqCst);
    let ctx_recent = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    fixture.clock.0.fetch_add(4 * 86_400_000, Ordering::SeqCst); // Total +91d; session still valid for 26d.
    let _ = ctx_mid;
    service
        .begin_agent_call(ctx_recent.clone(), start(3))
        .await
        .unwrap();
    let mut pending = retrieval;
    pending.id = RequestId::from_bytes([5; 16]);
    pending.call = Some(RequestId::from_bytes([3; 16]));
    service
        .record_agent_retrieval(ctx_recent.clone(), pending)
        .await
        .unwrap();
    let mut removed = (0, 0, 0, 0);
    let mut ended = false;
    for _ in 0..20 {
        let result = service.cleanup_telemetry(maintenance(), 1).await.unwrap();
        assert!(result.details + result.retrievals + result.calls + result.commands <= 1);
        removed.0 += result.details;
        removed.1 += result.retrievals;
        removed.2 += result.calls;
        removed.3 += result.commands;
        if !result.has_more {
            ended = true;
            break;
        }
    }
    assert!(ended);
    assert_eq!((removed.0, removed.1, removed.2), (1, 1, 3));
    assert!(removed.3 > 0);
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM agent_calls WHERE finished_at IS NULL")
            .await,
        1
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM agent_retrievals")
            .await,
        1
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM control_commands WHERE state='pending'")
            .await,
        1
    );
    // Simulate a backward NTP clock step before finishing call 3: duration clamps to 0.
    fixture.clock.0.fetch_sub(50, Ordering::SeqCst);
    service
        .finish_agent_call(maintenance(), finish(3, AgentCallDetail::default()))
        .await
        .unwrap();
    fixture
        .clock
        .0
        .fetch_add(31 * 86_400_000 + 50, Ordering::SeqCst);
    assert!(service.whoami(ctx).await.is_err()); // Old session expired.
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM agent_calls WHERE finished_at IS NULL")
            .await,
        0
    );
    assert!(service.cleanup_telemetry(maintenance(), 201).await.is_err());
    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_content_free_telemetry() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_content_free_telemetry() {
    exercise(true).await;
}

async fn cleanup_operational_tables(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "telemetry_retention").await;
    let _keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(SecretString::new("retention fixture password".into())),
            },
        )
        .await
        .unwrap();
    let owner = boot.account.id.clone();
    let personal_id = boot.account.personal_space.clone().unwrap();
    let token = boot.session.unwrap().token;
    let ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );

    let now = fixture.clock.0.load(Ordering::SeqCst);
    let old = now - 100 * 86_400_000;
    let key_id = fixture
        .observer
        .text("SELECT key_id FROM secret_keyring LIMIT 1")
        .await;

    // Backdate an in-flight call beyond 24h so cleanup treats it as orphaned.
    control
        .begin_agent_call(
            ctx,
            BeginAgentCall {
                call: RequestId::from_bytes([61; 16]),
                request: RequestId::from_bytes([61; 16]),
                episode: None,
                operation: AgentOperation::Search,
                transport: AgentTransport::Mcp,
                effect: AgentEffect::Read,
                input_bytes: 10,
            },
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE agent_calls SET started_at = 1000")
        .await;

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
            &[
                TargetRecord::ControlCommands {
                    owner: owner.to_string(),
                    actor: owner.to_string(),
                    command_key: CommandKey::from_bytes([62; 16]).to_string(),
                    request_hash: vec![7; 32],
                    target: "create-space".into(),
                    expected: 0,
                    result_revision: Some(1),
                    state: "committed".into(),
                    safe_result: Some("{}".into()),
                    expires_at: now - 60_000,
                },
                TargetRecord::RevocationEvents {
                    event_id: RequestId::from_bytes([63; 16]).to_string(),
                    selector: serde_json::to_string(&RevocationSelector::ProviderCall(
                        RequestId::from_bytes([63; 16]),
                    ))
                    .unwrap(),
                    reason: serde_json::to_string(&RevocationReason::PermissionChanged).unwrap(),
                    authority_version: 1,
                    committed_at: now,
                    delivered_at: None,
                    attempts: 0,
                },
                TargetRecord::RevocationEvents {
                    event_id: RequestId::from_bytes([64; 16]).to_string(),
                    selector: serde_json::to_string(&RevocationSelector::ProviderCall(
                        RequestId::from_bytes([64; 16]),
                    ))
                    .unwrap(),
                    reason: serde_json::to_string(&RevocationReason::PermissionChanged).unwrap(),
                    authority_version: 1,
                    committed_at: old,
                    delivered_at: Some(old),
                    attempts: 1,
                },
                TargetRecord::ControlOperations {
                    operation_id: RequestId::from_bytes([65; 16]).to_string(),
                    command_key: CommandKey::from_bytes([65; 16]).to_string(),
                    kind: "create-space".into(),
                    target_space: SpaceId::from_bytes([65; 16]).to_string(),
                    state: "committed".into(),
                    payload_hash: vec![65; 32],
                    payload: "{}".into(),
                    canonical_receipt: None,
                    next_action: "none".into(),
                    updated_at: old,
                },
                TargetRecord::Sessions {
                    session_id: AuthSessionId::from_bytes([66; 16]).to_string(),
                    token_hash: vec![66; 32],
                    user_id: owner.to_string(),
                    created_at: old,
                    expires_at: old + 1000,
                    last_used_at: old,
                    revoked_at: None,
                    auth_version: 0,
                },
                TargetRecord::OneTimeTokens {
                    token_hash: vec![67; 32],
                    user_id: owner.to_string(),
                    purpose: "reset".into(),
                    expires_at: old + 1000,
                    used_at: None,
                    created_at: old,
                },
                TargetRecord::OauthClients {
                    client_id: "client_gc_fixture".into(),
                    kind: "dcr".into(),
                    redirect_uris: "[\"http://127.0.0.1/cb\"]".into(),
                    client_name: "GC Client".into(),
                    metadata_uri: None,
                    metadata_digest: None,
                    cache_expires_at: None,
                    activated_at: Some(old),
                    created_at: old,
                    last_seen_at: Some(old),
                },
                TargetRecord::OauthGrants {
                    ability_write: 0,
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    user_id: owner.to_string(),
                    client_id: "client_gc_fixture".into(),
                    resource_uri: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    revoked_at: None,
                    revision: 0,
                    created_at: old,
                },
                TargetRecord::OauthAuthCodes {
                    code_hash: vec![68; 32],
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    client_id: "client_gc_fixture".into(),
                    redirect_uri: "http://127.0.0.1/cb".into(),
                    resource_uri: "https://resource.example/".into(),
                    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
                    method: "S256".into(),
                    offline_access: 0,
                    expires_at: old + 1000,
                    used_at: None,
                    created_at: old,
                },
                TargetRecord::OauthRefreshFamilies {
                    family_id: OAuthFamilyId::from_bytes([69; 16]).to_string(),
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    revoked_at: Some(old),
                    reason_code: Some("logout".into()),
                    created_at: old,
                },
                TargetRecord::OauthRefreshTokens {
                    token_id: "696969696969".into(),
                    token_hash: vec![69; 32],
                    family_id: OAuthFamilyId::from_bytes([69; 16]).to_string(),
                    client_id: "client_gc_fixture".into(),
                    issued_at: old,
                    expires_at: old + 1000,
                    used_at: None,
                    revoked_at: Some(old),
                    rotated_to: None,
                },
                TargetRecord::OauthAccessTokens {
                    ability_write: 0,
                    token_id: "707070707070".into(),
                    token_hash: vec![70; 32],
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    family_id: Some(OAuthFamilyId::from_bytes([69; 16]).to_string()),
                    refresh_id: Some("696969696969".into()),
                    resource_uri: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    issued_at: old,
                    expires_at: old + 1000,
                    revoked_at: None,
                    last_used_at: None,
                },
                TargetRecord::OidcTransactions {
                    transaction_id: RequestId::from_bytes([71; 16]).to_string(),
                    state_hash: vec![71; 32],
                    nonce_hash: vec![71; 32],
                    flow_context_hash: vec![71; 32],
                    key_id,
                    issuer: "https://idp.example/".into(),
                    client_id: "notarium-web".into(),
                    redirect_uri: "https://app.example/callback".into(),
                    purpose: "login".into(),
                    bound_user: None,
                    browser_binding_hash: vec![71; 32],
                    expires_at: old + 1000,
                    consumed_at: None,
                    created_at: old,
                },
                TargetRecord::McpDedup {
                    owner: owner.to_string(),
                    actor: "gc-actor".into(),
                    request_key: CommandKey::from_bytes([72; 16]).to_string(),
                    request_hash: vec![72; 32],
                    operation: "search".into(),
                    safe_result: "{}".into(),
                    effect: "read".into(),
                    expires_at: old + 1000,
                },
                TargetRecord::ProviderBudgetBuckets {
                    budget_kind: "space".into(),
                    budget_owner: personal_id.to_string(),
                    window_start_ms: old - (old % 60_000),
                    window_end_ms: old - (old % 60_000) + 60_000,
                    rpm_used: 1,
                    tpm_reserved: 10,
                    tpm_exact: 10,
                },
                TargetRecord::ProviderCallLog {
                    call_id: RequestId::from_bytes([73; 16]).to_string(),
                    owner_id: owner.to_string(),
                    principal: owner.to_string(),
                    run_id: None,
                    scope_id: format!("space:{personal_id}"),
                    intent_key: CommandKey::from_bytes([73; 16]).to_string(),
                    request_hash: vec![73; 32],
                    resource_id: ProviderResourceId::from_bytes([73; 16]).to_string(),
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
                    diagnostic: None,
                    dispatch_owner: None,
                    created_at: old,
                    settled_at: Some(old),
                },
                TargetRecord::AgentSchedules {
                    schedule_id: ScheduleId::from_bytes([74; 16]).to_string(),
                    owner_id: owner.to_string(),
                    space_id: personal_id.to_string(),
                    project_folder_id: None,
                    title: "Deleted tombstone".into(),
                    init_prompt: String::new(),
                    cron_expr: "0 * * * * *".into(),
                    timezone: "UTC".into(),
                    approved_role: serde_json::to_string(&AbilityRef {
                        id: AbilityId::from_bytes([74; 16]),
                        placement: AbilityPlacement::System,
                        revision: RevisionId::from_bytes([1; 16]),
                    })
                    .unwrap(),
                    paused_reason: None,
                    write_class_mask: 1,
                    budgets: serde_json::to_string(&RunLimits::default()).unwrap(),
                    misfire_policy: "coalesce_latest".into(),
                    approved_skills: "[]".into(),
                    next_slot_utc_ms: Some(old - (old % 60_000)),
                    deleted_at: Some(old),
                    revision: 1,
                    config_revision: 1,
                    created_at: old,
                    updated_at: old,
                },
                TargetRecord::AgentScheduleRuns {
                    run_id: AgentRunId::from_bytes([75; 16]).to_string(),
                    schedule_id: ScheduleId::from_bytes([74; 16]).to_string(),
                    slot_utc_ms: old - (old % 60_000),
                    lease_epoch: 1,
                    claim_request_hash: vec![75; 32],
                    claimed_schedule_revision: 0,
                    approved_skills: "[]".into(),
                    keeper_log_id: None,
                    keeper_project_folder_id: None,
                    reserved_next_slot: Some(old - (old % 60_000) + 60_000),
                    status: "succeeded".into(),
                    started_at: old,
                    finished_at: Some(old + 1000),
                    safe_result: None,
                    owner_auth_version: 0,
                    config_revision: 0,
                    admission_epoch: 0,
                    history_scope: serde_json::to_string(&HistoryScope {
                        space_id: personal_id,
                        incarnation: HistoryIncarnation::from_bytes([1; 16]),
                    })
                    .unwrap(),
                    expires_at: old + 60_000,
                },
            ],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;

    let cleanup = control.cleanup_telemetry(maintenance(), 200).await.unwrap();
    assert_eq!(cleanup.calls, 1, "orphaned >24h agent_call must be pruned");
    assert!(
        cleanup.commands >= 1,
        "expired committed command must be pruned despite unrelated fresh revocation_event"
    );

    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        1
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM sessions")
            .await,
        1
    );

    for sql in [
        "SELECT COUNT(*) FROM agent_calls",
        "SELECT COUNT(*) FROM one_time_tokens",
        "SELECT COUNT(*) FROM oauth_auth_codes",
        "SELECT COUNT(*) FROM oauth_access_tokens",
        "SELECT COUNT(*) FROM oauth_refresh_tokens",
        "SELECT COUNT(*) FROM oauth_refresh_families",
        "SELECT COUNT(*) FROM oidc_transactions",
        "SELECT COUNT(*) FROM mcp_dedup",
        "SELECT COUNT(*) FROM provider_budget_buckets",
        "SELECT COUNT(*) FROM provider_call_log",
        "SELECT COUNT(*) FROM agent_schedule_runs",
        "SELECT COUNT(*) FROM agent_schedules",
        "SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NOT NULL",
        "SELECT COUNT(*) FROM control_operations WHERE operation_id = 'req_41414141414141414141414141414141'",
    ] {
        assert_eq!(
            fixture.observer.count(sql).await,
            0,
            "unpruned row in: {sql}"
        );
    }

    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_cleanup_prunes_expired_operational_rows_across_all_tables() {
    cleanup_operational_tables(false).await;
}
#[tokio::test]
async fn postgres_cleanup_prunes_expired_operational_rows_across_all_tables() {
    cleanup_operational_tables(true).await;
}

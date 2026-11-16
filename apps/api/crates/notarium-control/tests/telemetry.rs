#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    auth::*,
    ids::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
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
    service
        .begin_agent_call(ctx.clone(), start(3))
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
    let mut pending = retrieval;
    pending.id = RequestId::from_bytes([5; 16]);
    pending.call = Some(RequestId::from_bytes([3; 16]));
    service
        .record_agent_retrieval(ctx.clone(), pending)
        .await
        .unwrap();
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
    fixture.clock.0.fetch_add(91 * 86_400_000, Ordering::SeqCst);
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
    assert_eq!((removed.0, removed.1, removed.2), (1, 1, 2));
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
    assert!(service.whoami(ctx).await.is_err()); // Old session expired.
    service
        .finish_agent_call(maintenance(), finish(3, AgentCallDetail::default()))
        .await
        .unwrap();
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

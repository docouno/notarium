use super::*;
use crate::{store::ControlStore, test_support::*};
use std::sync::Arc;

fn row(id: u8, tokens: i64) -> ProviderCallLogRow {
    ProviderCallLogRow {
        call_id: RequestId::from_bytes([id; 16]).to_string(),
        owner_id: PrincipalId::from_bytes([id; 16]).to_string(),
        principal: PrincipalId::from_bytes([id; 16]).to_string(),
        run_id: None,
        scope_id: "scope".into(),
        intent_key: CommandKey::from_bytes([id; 16]).to_string(),
        request_hash: vec![id; 32],
        resource_id: ProviderResourceId::from_bytes([1; 16]).to_string(),
        credential_id: Some(CredentialId::from_bytes([1; 16]).to_string()),
        policy_epochs: "{}".into(),
        participating_spaces: json(&vec![SpaceId::from_bytes([1; 16])]).unwrap(),
        model_id: Some(ModelProfileId::from_bytes([1; 16]).to_string()),
        reserved_tokens: tokens,
        bucket_keys: "[]".into(),
        delivery_state: "intent".into(),
        outcome: None,
        usage_source: "unknown".into(),
        input_tokens: None,
        output_tokens: None,
        diagnostic: None,
        dispatch_owner: None,
        created_at: 0,
        settled_at: None,
    }
}
fn budgets() -> Vec<BudgetLimit> {
    vec![
        BudgetLimit {
            kind: "resource",
            owner: ProviderResourceId::from_bytes([1; 16]).to_string(),
            limits: ProviderLimits {
                requests_per_minute: Some(7),
                tokens_per_minute: Some(500),
            },
        },
        BudgetLimit {
            kind: "credential",
            owner: CredentialId::from_bytes([1; 16]).to_string(),
            limits: ProviderLimits {
                requests_per_minute: Some(4),
                tokens_per_minute: Some(600),
            },
        },
        BudgetLimit {
            kind: "space",
            owner: SpaceId::from_bytes([1; 16]).to_string(),
            limits: ProviderLimits {
                requests_per_minute: Some(10),
                tokens_per_minute: Some(300),
            },
        },
    ]
}
async fn admit(
    store: &ControlStore,
    id: u8,
    tokens: i64,
    now: i64,
) -> Result<ProviderCallLogRow, PortError> {
    let budget = OperationBudget::new(budget());
    let mut tx = store.write(budget.clone()).await?;
    let row = reserve(tx.inner_mut(), row(id, tokens), budgets(), now).await?;
    sending(
        tx.inner_mut(),
        &RequestId::parse(&row.call_id)?,
        &RequestId::from_bytes([255; 16]),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}
async fn finish(
    store: &ControlStore,
    id: u8,
    actual: ProviderUsage,
    result: ProviderOutcome,
    now: i64,
) -> ProviderCallStatus {
    let mut tx = store.write(OperationBudget::new(budget())).await.unwrap();
    let row = call(tx.inner_mut(), &RequestId::from_bytes([id; 16]))
        .await
        .unwrap();
    let status = settle(tx.inner_mut(), row, actual, result, None, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    status
}
fn exact(input: u64, output: u64) -> ProviderUsage {
    ProviderUsage::Exact {
        input_tokens: input,
        output_tokens: output,
    }
}
async fn accounting(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_accounting").await;
    let now = 1_700_000_000_000;
    admit(&fixture.store, 1, 100, now).await.unwrap();
    assert!(matches!(
        admit(&fixture.store, 1, 100, now).await,
        Err(PortError::Domain(DomainError::ProviderCallAlreadyStarted {
            state: ProviderDeliveryState::Sending,
            ..
        }))
    ));
    let mut tx = fixture
        .store
        .write(OperationBudget::new(budget()))
        .await
        .unwrap();
    assert!(matches!(
        existing(
            tx.inner_mut(),
            &PrincipalId::from_bytes([1; 16]).to_string(),
            "scope",
            &CommandKey::from_bytes([1; 16]),
            &[2; 32]
        )
        .await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    tx.rollback().await.unwrap();
    let settled = finish(
        &fixture.store,
        1,
        exact(30, 10),
        ProviderOutcome::Completed,
        now + 1,
    )
    .await;
    assert_eq!(settled.usage, exact(30, 10));
    finish(
        &fixture.store,
        1,
        exact(30, 10),
        ProviderOutcome::Completed,
        now + 2,
    )
    .await;
    assert_eq!(
        fixture
            .observer
            .count("SELECT CAST(sum(tpm_exact) AS BIGINT) FROM provider_budget_buckets")
            .await,
        120
    );
    admit(&fixture.store, 2, 100, now).await.unwrap();
    finish(
        &fixture.store,
        2,
        ProviderUsage::Unknown,
        ProviderOutcome::Cancelled,
        now + 2,
    )
    .await;
    admit(&fixture.store, 3, 100, now).await.unwrap();
    finish(
        &fixture.store,
        3,
        ProviderUsage::Unknown,
        ProviderOutcome::NotSent,
        now + 2,
    )
    .await;
    assert_eq!(
        fixture
            .observer
            .count("SELECT CAST(sum(rpm_used) AS BIGINT) FROM provider_budget_buckets")
            .await,
        6
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT CAST(sum(tpm_reserved) AS BIGINT) FROM provider_budget_buckets")
            .await,
        300
    );
    // A late authoritative result enriches the audit, without touching the next
    // window or giving it credit for expired reservations.
    let late = window(now).unwrap().1 + 1;
    let status = finish(
        &fixture.store,
        2,
        exact(20, 10),
        ProviderOutcome::Completed,
        late,
    )
    .await;
    assert_eq!(status.usage, exact(20, 10));
    assert_eq!(status.outcome, Some(ProviderOutcome::Cancelled));
    assert_eq!(
        fixture
            .observer
            .count("SELECT CAST(sum(tpm_reserved) AS BIGINT) FROM provider_budget_buckets")
            .await,
        300
    );
    admit(&fixture.store, 4, 100, late).await.unwrap();
    let mismatch = finish(
        &fixture.store,
        4,
        exact(100, 20),
        ProviderOutcome::Completed,
        late + 1,
    )
    .await;
    assert_eq!(mismatch.diagnostic, Some(ProviderErrorCode::BudgetMismatch));
    assert_eq!(mismatch.usage, exact(100, 20));
    assert!(matches!(
        admit(&fixture.store, 5, 10, late + 2).await,
        Err(PortError::Domain(DomainError::RateLimited {
            budget: BudgetKind::Tokens,
            ..
        }))
    ));
    let next = window(late).unwrap().1 + 1;
    let store = Arc::new(fixture.store.clone());
    let mut jobs = Vec::new();
    for id in 10..50 {
        let store = store.clone();
        jobs.push(tokio::spawn(
            async move { admit(&store, id, 100, next).await },
        ));
    }
    let mut admitted = 0;
    for job in jobs {
        match job.await.unwrap() {
            Ok(_) => admitted += 1,
            Err(PortError::Domain(DomainError::RateLimited { .. })) => {}
            Err(other) => panic!("unexpected admission failure: {other:?}"),
        }
    }
    assert_eq!(
        admitted, 3,
        "every Space pays the whole call; failed reservations roll back all buckets"
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_call_log WHERE delivery_state='sending'")
            .await,
        3
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT max(tpm_reserved) FROM provider_budget_buckets")
            .await,
        300
    );
    drop(store);
    let future = window(next).unwrap().1 + 1;
    admit(&fixture.store, 60, 100, future).await.unwrap();
    admit(&fixture.store, 61, 100, future).await.unwrap();
    finish(
        &fixture.store,
        60,
        exact(i64::MAX as u64, 0),
        ProviderOutcome::Completed,
        future + 1,
    )
    .await;
    let overflow = finish(
        &fixture.store,
        61,
        exact(10, 0),
        ProviderOutcome::Completed,
        future + 2,
    )
    .await;
    assert_eq!(overflow.usage, exact(10, 0));
    assert_eq!(overflow.diagnostic, Some(ProviderErrorCode::BudgetMismatch));
    assert_eq!(fixture.observer.count("SELECT COUNT(*) FROM provider_budget_buckets WHERE tpm_exact=9223372036854775807 AND tpm_reserved=0").await,3);
    assert!(matches!(
        admit(&fixture.store, 62, 1, future + 3).await,
        Err(PortError::Domain(DomainError::RateLimited { .. }))
    ));
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_atomic_budgets_idempotency_and_unknown_spend() {
    accounting(false).await;
}
#[tokio::test]
async fn postgres_atomic_budgets_idempotency_and_unknown_spend() {
    accounting(true).await;
}

struct NoEgress;
impl ProviderEgressCatalogPort for NoEgress {
    fn acquire_egress(
        &self,
        _: AccountContext,
        _: ProviderEgressRequest,
        _: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        panic!("recovery must not load canonical content")
    }
}
async fn recovery(pg: bool) {
    use crate::{
        keyring::{Keyring, KeyringLocation},
        outbound::{NetworkPolicy, OutboundTransport},
        service::{AuthenticationMode, provider::ProviderConfig},
    };
    use notarium_core::ports::control::ControlPageRequest;
    use std::{path::PathBuf, sync::atomic::Ordering};
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_recovery").await;
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/keyring/vectors.json")).unwrap();
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
            &[TargetRecord::SecretKeyring(SecretKeyringRow {
                key_id: value["keyId"].as_str().unwrap().into(),
                key_hash: value["keyHash"].as_str().unwrap().into(),
                generation: 1,
                state: "active".into(),
                canary: value["canaryEnvelope"].as_str().unwrap().into(),
                created_at: 0,
                retired_at: None,
            })],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    let keys = Arc::new(
        Keyring::open(
            fixture.store.clone(),
            KeyringLocation::External(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
            ),
            budget(),
        )
        .await
        .unwrap(),
    );
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let provider = ProviderService::new(
        control.clone(),
        keys.clone(),
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    let now = 1_700_000_000_000;
    admit(&fixture.store, 20, 100, now).await.unwrap();
    admit(&fixture.store, 21, 100, now).await.unwrap();
    let mut tx = fixture
        .store
        .write(OperationBudget::new(budget()))
        .await
        .unwrap();
    reserve(tx.inner_mut(), row(22, 100), budgets(), now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let cancellation = Cancellation::default();
    let active = fixture
        .revoker
        .register_provider(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            vec![RevocationSelector::ProviderCall(RequestId::from_bytes(
                [20; 16],
            ))],
            cancellation.clone(),
        )
        .await
        .unwrap();
    fixture.clock.0.store(now + 300_001, Ordering::SeqCst);
    let mut after = None;
    let mut inspected = 0;
    let mut settled = 0;
    loop {
        let page = provider
            .recover_calls(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::ProviderRecovery),
                    budget: budget(),
                },
                ControlPageRequest::new(1, after).unwrap(),
            )
            .await
            .unwrap();
        inspected += page.inspected;
        settled += page.settled;
        if page.continuation.is_none() {
            break;
        }
        after = page.continuation;
    }
    assert_eq!(inspected, 3);
    assert_eq!(settled, 2);
    assert!(!cancellation.is_cancelled());
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_call_log WHERE delivery_state='sending'")
            .await,
        1
    );
    drop(active);
    let page = provider
        .recover_calls(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::ProviderRecovery),
                budget: budget(),
            },
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(page.settled, 1);
    assert_eq!(fixture.observer.count("SELECT count(*) FROM provider_call_log WHERE outcome='unknown' AND usage_source='unknown'").await,3);
    assert_eq!(
        fixture
            .observer
            .count("SELECT CAST(sum(tpm_reserved) AS BIGINT) FROM provider_budget_buckets")
            .await,
        900
    );
    drop(provider);
    drop(control);
    drop(keys);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_recovery_preserves_active_registration_and_unknown_reserve() {
    recovery(false).await;
}
#[tokio::test]
async fn postgres_recovery_preserves_active_registration_and_unknown_reserve() {
    recovery(true).await;
}

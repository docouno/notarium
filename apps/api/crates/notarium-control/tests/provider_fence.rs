#[allow(dead_code)]
mod support;
use notarium_control::service::AuthenticationMode;
use notarium_core::{auth::SecretString, error::PortError, ports::*};
use std::time::Duration;
use support::*;

fn maintenance() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: budget(),
    }
}

async fn logout_waits_for_socket_release(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_fence").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("initial password".into())),
            },
        )
        .await
        .unwrap();
    let session = bootstrap.session.unwrap();
    let selector = RevocationSelector::Session(session.id.clone());
    let cancelled = Cancellation::default();
    let active = fixture
        .revoker
        .register_provider(maintenance(), vec![selector.clone()], cancelled.clone())
        .await
        .unwrap();
    let other = fixture.service(AuthenticationMode::Password).await.unwrap();
    let token = session.token.expose().to_owned();
    let logout = tokio::spawn(async move {
        other
            .logout(evidence(AuthEvidenceKind::Session, &token))
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !cancelled.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert!(active.check().is_err());
    assert!(
        !logout.is_finished(),
        "COMMIT must wait for the active socket lease"
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL")
            .await,
        0
    );
    // A concurrent registration cannot pass the same mutation fence.
    let registry = fixture.revoker.clone();
    let registering = tokio::spawn(async move {
        registry
            .register_provider(maintenance(), vec![selector], Cancellation::default())
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!registering.is_finished());
    drop(active);
    tokio::time::timeout(Duration::from_secs(2), logout)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let registration = tokio::time::timeout(Duration::from_secs(2), registering)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    // The registry is an admission fence, not an authority cache. A real caller
    // must revalidate under SQL locks before acquiring this lease.
    assert!(matches!(
        service
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await,
        Err(PortError::Domain(
            notarium_core::DomainError::AuthenticationFailed
        ))
    ));
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL")
            .await,
        1
    );
    drop(registration);
    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_logout_fences_provider_registration() {
    logout_waits_for_socket_release(false).await;
}
#[tokio::test]
async fn postgres_logout_fences_provider_registration() {
    logout_waits_for_socket_release(true).await;
}

use crate::support::{Fixture, budget};
use notarium_control::{
    keyring::{Keyring, KeyringLocation},
    service::provider::ProviderService,
    store::TargetRecord,
};
use notarium_core::{
    DomainError,
    auth::SecretString,
    classes::DocClass,
    ids::*,
    ports::{control::*, *},
};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

pub struct NoEgress;
impl ProviderEgressCatalogPort for NoEgress {
    fn acquire_egress(
        &self,
        _: AccountContext,
        _: ProviderEgressRequest,
        _: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async { Err(DomainError::AccessDenied.into()) })
    }
}
pub async fn keyring(fixture: &mut Fixture) -> Arc<Keyring> {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/keyring/vectors.json")).unwrap();
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
            &[TargetRecord::SecretKeyring {
                key_id: value["keyId"].as_str().unwrap().into(),
                key_hash: value["keyHash"].as_str().unwrap().into(),
                generation: 1,
                state: "active".into(),
                canary: value["canaryEnvelope"].as_str().unwrap().into(),
                created_at: 0,
                retired_at: None,
            }],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    Arc::new(
        Keyring::open(
            fixture.store.clone(),
            KeyringLocation::External(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
            ),
            budget(),
        )
        .await
        .unwrap(),
    )
}
pub fn credential_input(secret: &str) -> NewProviderCredential {
    NewProviderCredential {
        id: CredentialId::from_bytes([1; 16]),
        name: "Primary credential".into(),
        injection: CredentialInjection {
            header: "Authorization".into(),
            prefix: "Bearer ".into(),
        },
        secret: SecretString::new(secret.into()),
        limits: ProviderLimits {
            requests_per_minute: Some(30),
            tokens_per_minute: Some(100_000),
        },
    }
}
pub fn resource_input() -> ProviderResourceSpec {
    ProviderResourceSpec {
        id: ProviderResourceId::from_bytes([2; 16]),
        name: "Primary resource".into(),
        wire: ProviderWireKind::OpenaiCompatible,
        base_url: "https://provider.example/v1".into(),
        credential: Some(CredentialId::from_bytes([1; 16])),
        headers: vec![ProviderSecretHeader {
            name: "X-Tenant-Key".into(),
            value: SecretString::new("tenant-secret".into()),
        }],
        limits: ProviderLimits::default(),
        timeout_ms: 30_000,
    }
}
pub fn consent() -> ProviderDisclosureConsent {
    ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
        classes: BTreeSet::from([DocClass::UserDoc, DocClass::AgentMemory]),
    })
}
pub async fn current_resource(
    provider: &ProviderService,
    ctx: &AccountContext,
) -> ProviderResourceInfo {
    provider
        .list_resources(ctx.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .remove(0)
}

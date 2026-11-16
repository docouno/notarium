#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;
use notarium_control::{
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode,
        provider::{ProviderConfig, ProviderService},
    },
};
use notarium_core::{
    DomainError,
    auth::SecretString,
    error::PortError,
    ids::*,
    ports::{control::*, *},
};
use provider::*;
use std::sync::Arc;
use support::*;

async fn administration(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_admin").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = control
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
    let owner = bootstrap.account.id;
    let personal = bootstrap.account.personal_space.unwrap();
    let session = bootstrap.session.unwrap();
    let ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let provider = ProviderService::new(
        control.clone(),
        keys.clone(),
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    let first = command(&owner, &owner, 1, bootstrap.account.revision);
    let created = provider
        .create_credential(
            ctx.clone(),
            AccountMutation {
                identity: first.clone(),
                input: credential_input("provider-secret"),
            },
        )
        .await
        .unwrap();
    assert!(created.value.has_secret);
    assert_eq!(created.value.injection.header, "authorization");
    let mut revision = created.revision;
    let replay = provider
        .create_credential(
            ctx.clone(),
            AccountMutation {
                identity: first.clone(),
                input: credential_input("provider-secret"),
            },
        )
        .await
        .unwrap();
    assert_eq!(replay.revision, revision);
    assert!(matches!(
        provider
            .create_credential(
                ctx.clone(),
                AccountMutation {
                    identity: first,
                    input: credential_input("different-secret")
                }
            )
            .await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    let encrypted = fixture
        .observer
        .text("SELECT secret FROM credentials")
        .await;
    assert!(encrypted.starts_with("v1."));
    assert!(!encrypted.contains("provider-secret"));
    let resource = provider
        .create_resource(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 2, revision),
                input: resource_input(),
            },
        )
        .await
        .unwrap();
    revision = resource.revision;
    assert_eq!(resource.value.secret_headers, ["x-tenant-key"]);
    assert!(
        !serde_json::to_string(&resource.value)
            .unwrap()
            .contains("tenant-secret")
    );
    let stored = fixture
        .observer
        .text("SELECT headers FROM provider_resources")
        .await;
    assert!(!stored.contains("tenant-secret"));
    let model = ProviderModelSpec {
        id: ModelProfileId::from_bytes([3; 16]),
        wire_name: "model-one".into(),
        kind: ProviderModelKind::Completion,
        accounting: TokenAccountingProfile::ConservativeModelCapV1,
        max_input_tokens: 8192,
        max_output_tokens: 512,
        tools: true,
    };
    let saved = provider
        .put_model(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 3, revision),
                input: PutProviderModel {
                    resource: resource.value.id.clone(),
                    expected: resource.value.revision,
                    model: model.clone(),
                    default: true,
                },
            },
        )
        .await
        .unwrap();
    revision = saved.revision;
    let resource = current_resource(&provider, &ctx).await;
    assert_eq!(resource.consent_epoch, 2);
    let id = RequestId::from_bytes([4; 16]);
    let confirmation =
        |resource_consent_epoch, credential_consent_epoch| RequestProviderAttachment {
            id: id.clone(),
            expected: None,
            resource: resource.id.clone(),
            resource_consent_epoch,
            credential_consent_epoch,
            target: ProviderAttachmentTarget::Personal {
                owner: owner.clone(),
                space: personal.clone(),
            },
            consent: consent(),
            expires_at_ms: None,
        };
    let attachment_command = command(&owner, &owner, 4, revision);
    // A valid account revision must not turn a stale configuration confirmation
    // into new consent. Each version, including credential absence, is binding.
    for (resource_epoch, credential_epoch) in [(1, Some(1)), (2, None), (2, Some(2))] {
        assert!(matches!(
            provider
                .request_attachment(
                    ctx.clone(),
                    AccountMutation {
                        identity: attachment_command.clone(),
                        input: confirmation(resource_epoch, credential_epoch),
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert_eq!(
            fixture
                .observer
                .count("SELECT count(*) FROM provider_attachments")
                .await,
            0
        );
    }
    let attached = provider
        .request_attachment(
            ctx.clone(),
            AccountMutation {
                identity: attachment_command.clone(),
                input: confirmation(resource.consent_epoch, Some(created.value.consent_epoch)),
            },
        )
        .await
        .unwrap();
    revision = attached.revision;
    assert_eq!(attached.value.state, ProviderAttachmentState::Approved);
    assert_eq!(attached.value.credential_consent_epoch, Some(1));
    for (resource_epoch, credential_epoch) in [(1, Some(1)), (2, None), (2, Some(2))] {
        assert!(matches!(
            provider
                .request_attachment(
                    ctx.clone(),
                    AccountMutation {
                        identity: attachment_command.clone(),
                        input: confirmation(resource_epoch, credential_epoch),
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
    }
    let scope = fixture
        .catalog
        .space(budget(), personal.clone())
        .await
        .unwrap()
        .history;
    let space_ctx = SpaceContext::new(ctx.auth().clone(), scope, budget()).unwrap();
    let select = SelectProvider {
        kind: PreferenceModelKind::Completion,
        resource: Some(resource.id.clone()),
        model: Some(model.id.clone()),
        project: None,
    };
    assert_eq!(
        provider
            .select_provider(space_ctx.clone(), select.clone())
            .await
            .unwrap()
            .model,
        model.id
    );
    assert!(
        provider
            .select_provider(
                space_ctx.clone(),
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: None,
                    model: None,
                    project: None
                }
            )
            .await
            .is_err()
    );
    let preferred = provider
        .set_preference(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 30, revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Completion,
                    resource: resource.id.clone(),
                    model: model.id.clone(),
                },
            },
        )
        .await
        .unwrap();
    revision = preferred.revision;
    assert_eq!(
        provider
            .select_provider(
                space_ctx.clone(),
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: None,
                    model: None,
                    project: None
                }
            )
            .await
            .unwrap()
            .provider,
        resource.id
    );

    let rotated = provider
        .update_credential(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 5, revision),
                input: UpdateProviderCredential {
                    id: created.value.id.clone(),
                    expected: created.value.revision,
                    name: "Primary credential".into(),
                    injection: created.value.injection.clone(),
                    secret: Some(SecretString::new("rotated-secret".into())),
                    limits: created.value.limits,
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    revision = rotated.revision;
    let review = provider
        .inspect_attachment(ctx.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(review.current_credential_consent_epoch, Some(1));
    assert_eq!(review.attachment.credential_consent_epoch, Some(1));
    let changed = provider
        .update_credential(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 6, revision),
                input: UpdateProviderCredential {
                    id: created.value.id.clone(),
                    expected: rotated.value.revision,
                    name: "Primary credential".into(),
                    injection: CredentialInjection {
                        header: "x-api-key".into(),
                        prefix: String::new(),
                    },
                    secret: None,
                    limits: created.value.limits,
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    revision = changed.revision;
    let review = provider
        .inspect_attachment(ctx.clone(), id.clone())
        .await
        .unwrap();
    assert!(
        provider
            .select_provider(space_ctx.clone(), select.clone())
            .await
            .is_err()
    );
    assert_eq!(review.current_credential_consent_epoch, Some(2));
    assert_eq!(review.attachment.credential_consent_epoch, Some(1));
    for (resource_epoch, credential_epoch) in [(1, Some(2)), (2, Some(1)), (2, None)] {
        assert!(matches!(
            provider
                .request_attachment(
                    ctx.clone(),
                    AccountMutation {
                        identity: command(&owner, &owner, 7, revision),
                        input: RequestProviderAttachment {
                            expected: Some(attached.value.revision),
                            ..confirmation(resource_epoch, credential_epoch)
                        },
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        let unchanged = provider
            .inspect_attachment(ctx.clone(), id.clone())
            .await
            .unwrap();
        assert_eq!(unchanged.attachment.revision, attached.value.revision);
        assert_eq!(unchanged.attachment.credential_consent_epoch, Some(1));
        assert_eq!(
            fixture
                .observer
                .count("SELECT count(*) FROM provider_call_log")
                .await,
            0
        );
    }
    let attached = provider
        .request_attachment(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 7, revision),
                input: RequestProviderAttachment {
                    id: id.clone(),
                    expected: Some(attached.value.revision),
                    resource: resource.id.clone(),
                    resource_consent_epoch: review.resource.consent_epoch,
                    credential_consent_epoch: review.current_credential_consent_epoch,
                    target: ProviderAttachmentTarget::Personal {
                        owner: owner.clone(),
                        space: personal.clone(),
                    },
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    revision = attached.revision;
    assert_eq!(attached.value.credential_consent_epoch, Some(2));
    assert!(
        provider
            .select_provider(space_ctx.clone(), select.clone())
            .await
            .is_ok()
    );
    let resource = current_resource(&provider, &ctx).await;
    let mut changed_resource = resource_input();
    changed_resource.base_url = "https://another.example/v2".into();
    let changed = provider
        .update_resource(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 8, revision),
                input: UpdateProviderResource {
                    expected: resource.revision,
                    spec: changed_resource,
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    revision = changed.revision;
    assert_eq!(changed.value.consent_epoch, 3);
    assert!(provider.select_provider(space_ctx, select).await.is_err());
    assert_eq!(
        provider
            .inspect_attachment(ctx.clone(), id.clone())
            .await
            .unwrap()
            .attachment
            .resource_consent_epoch,
        2
    );
    let mut invalid = resource_input();
    invalid.id = ProviderResourceId::from_bytes([9; 16]);
    invalid.name = "Forbidden headers".into();
    invalid.headers[0].name = "Host".into();
    assert!(
        provider
            .create_resource(
                ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 9, revision),
                    input: invalid
                }
            )
            .await
            .is_err()
    );
    assert!(
        provider
            .delete_credential(
                ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 10, revision),
                    input: DeleteProviderCredential {
                        credential: created.value.id.clone(),
                        expected: changed_credential_revision()
                    }
                }
            )
            .await
            .is_err()
    );
    // Resource deletion removes dependent preferences/models/consents while
    // leaving audit records independent of mutable configuration.
    let deleted = provider
        .delete_resource(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 11, revision),
                input: DeleteProviderResource {
                    resource: resource.id,
                    expected: changed.value.revision,
                },
            },
        )
        .await
        .unwrap();
    revision = deleted.revision;
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_models")
            .await,
        0
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_attachments")
            .await,
        0
    );
    provider
        .delete_credential(
            ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 12, revision),
                input: DeleteProviderCredential {
                    credential: created.value.id,
                    expected: changed_credential_revision(),
                },
            },
        )
        .await
        .unwrap();
    assert!(
        provider
            .list_credentials(ctx, ControlPageRequest::new(10, None).unwrap())
            .await
            .unwrap()
            .items
            .is_empty()
    );
    drop(provider);
    drop(control);
    drop(keys);
    fixture.close().await;
}
fn changed_credential_revision() -> ControlRevision {
    ControlRevision::new(2).unwrap()
}
#[tokio::test]
async fn sqlite_provider_admin_encrypts_versions_and_invalidates_consent() {
    administration(false).await;
}
#[tokio::test]
async fn postgres_provider_admin_encrypts_versions_and_invalidates_consent() {
    administration(true).await;
}

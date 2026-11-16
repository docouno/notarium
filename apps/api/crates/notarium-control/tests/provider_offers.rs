#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;
use notarium_control::{
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlPlane, ControlService,
        provider::{ProviderConfig, ProviderService},
    },
};
use notarium_core::{
    DomainError,
    auth::{SecretString, SpaceKind, SpaceLifecycle, SpaceRole},
    error::{PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope},
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use provider::*;
use std::{
    collections::BTreeSet,
    sync::{Arc, atomic::Ordering},
};
use support::*;

async fn identity(
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
fn page(limit: u16, continuation: Option<String>) -> ControlPageRequest {
    ControlPageRequest::new(limit, continuation).unwrap()
}
fn scope(ctx: &AccountContext, history: &HistoryScope) -> SpaceContext {
    SpaceContext::new(ctx.auth().clone(), history.clone(), budget()).unwrap()
}
async fn offer(
    control: &ControlService,
    provider: &ProviderService,
    ctx: &AccountContext,
    key: u8,
    target: ProviderAttachmentTarget,
    expires: Option<i64>,
) -> ProviderAttachmentInfo {
    let resource = current_resource(provider, ctx).await;
    let credential = provider
        .list_credentials(ctx.clone(), page(10, None))
        .await
        .unwrap()
        .items
        .remove(0);
    provider
        .request_attachment(
            ctx.clone(),
            AccountMutation {
                identity: identity(control, ctx, key).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([key; 16]),
                    expected: None,
                    resource: resource.id,
                    resource_consent_epoch: resource.consent_epoch,
                    credential_consent_epoch: Some(credential.consent_epoch),
                    target,
                    consent: consent(),
                    expires_at_ms: expires,
                },
            },
        )
        .await
        .unwrap()
        .value
}
async fn approve(
    control: &ControlService,
    provider: &ProviderService,
    ctx: &AccountContext,
    key: u8,
    offered: &ProviderAttachmentInfo,
) -> ProviderAttachmentInfo {
    provider
        .approve_attachment(
            ctx.clone(),
            AccountMutation {
                identity: identity(control, ctx, key).await,
                input: ApproveProviderAttachment {
                    id: offered.id.clone(),
                    expected: offered.revision,
                    resource_consent_epoch: offered.resource_consent_epoch,
                    credential_consent_epoch: offered.credential_consent_epoch,
                    consent: consent(),
                },
            },
        )
        .await
        .unwrap()
        .value
}
async fn concurrent_selection(
    control: &ControlService,
    provider: &ProviderService,
    owner: &AccountContext,
    actors: &[AccountContext],
    history: &HistoryScope,
    resource: ProviderResourceId,
) {
    let port: &dyn ProviderAdminPort = provider;
    let select = |actor: &AccountContext| {
        provider.select_provider(
            scope(actor, history),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(resource.clone()),
                model: Some(ModelProfileId::from_bytes([40; 16])),
                project: None,
            },
        )
    };
    // Each principal has current personal consent. Neither reader may upgrade
    // a shared Space lock while another reader waits for the same resource.
    for _ in 0..20 {
        let (editor, viewer) = tokio::join!(select(&actors[0]), select(&actors[1]));
        assert_eq!(editor.unwrap().provider, resource);
        assert_eq!(viewer.unwrap().provider, resource);
    }
    let personal = RequestId::from_bytes([70; 16]);
    for index in 0..10 {
        // A foreign-resource attachment inspection also takes Space admission
        // before configuration rows, even though it does not revalidate scopes.
        let (review, selected) = tokio::join!(
            port.inspect_attachment(actors[0].clone(), personal.clone()),
            select(&actors[1]),
        );
        assert_eq!(selected.unwrap().provider, resource);
        let review = review.unwrap();
        let request = AccountMutation {
            identity: identity(control, &actors[0], 220 + index).await,
            input: RequestProviderAttachment {
                id: personal.clone(),
                expected: Some(review.attachment.revision),
                resource: resource.clone(),
                resource_consent_epoch: review.resource.consent_epoch,
                credential_consent_epoch: review.current_credential_consent_epoch,
                target: review.attachment.target,
                consent: ProviderDisclosureConsent::attest_checked(review.attachment.disclosure),
                expires_at_ms: None,
            },
        };
        let (confirmed, selected) = tokio::join!(
            port.request_attachment(actors[0].clone(), request),
            select(&actors[1]),
        );
        assert_eq!(
            confirmed.unwrap().value.state,
            ProviderAttachmentState::Approved
        );
        assert_eq!(selected.unwrap().provider, resource);

        let review = port
            .inspect_attachment(owner.clone(), RequestId::from_bytes([60; 16]))
            .await
            .unwrap();
        let request = AccountMutation {
            identity: identity(control, owner, 240 + index).await,
            input: ApproveProviderAttachment {
                id: review.attachment.id,
                expected: review.attachment.revision,
                resource_consent_epoch: review.resource.consent_epoch,
                credential_consent_epoch: review.current_credential_consent_epoch,
                consent: ProviderDisclosureConsent::attest_checked(review.attachment.disclosure),
            },
        };
        let (approved, selected) = tokio::join!(
            port.approve_attachment(owner.clone(), request),
            select(&actors[1]),
        );
        assert_eq!(
            approved.unwrap().value.state,
            ProviderAttachmentState::Approved
        );
        assert_eq!(selected.unwrap().provider, resource);

        // Shared default replacement retains exclusive scope serialization,
        // acquired before the resource. It must coexist with current selectors.
        let request = AccountMutation {
            identity: identity(control, owner, 230 + index).await,
            input: SetProviderPreference {
                scope: ProviderPreferenceScope::Space(history.space_id.clone()),
                kind: PreferenceModelKind::Completion,
                resource: resource.clone(),
                model: ModelProfileId::from_bytes([40; 16]),
            },
        };
        let (updated, selected) = tokio::join!(
            port.set_preference(owner.clone(), request),
            select(&actors[1]),
        );
        assert_eq!(updated.unwrap().value.resource, resource);
        assert_eq!(selected.unwrap().provider, resource);
    }
}

async fn offers(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_offers").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("owner password".into())),
            },
        )
        .await
        .unwrap();
    let owner_token = boot.session.unwrap().token;
    let mut owner = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, owner_token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let mut sessions = Vec::new();
    for (key, name) in [(1, "editor"), (2, "viewer"), (3, "outsider")] {
        let created = control
            .create_account(
                owner.clone(),
                AccountMutation {
                    identity: identity(&control, &owner, key).await,
                    input: NewAccount {
                        username: name.into(),
                        email: None,
                        display_name: name.into(),
                    },
                },
            )
            .await
            .unwrap();
        let invite = control
            .issue_one_time(
                owner.clone(),
                IssueOneTime {
                    account: created.value.id,
                    purpose: OneTimePurpose::Invite,
                    expected: created.value.revision,
                },
            )
            .await
            .unwrap();
        sessions.push(
            control
                .consume_one_time(
                    budget(),
                    ConsumeOneTime {
                        token: invite.value.token,
                        purpose: OneTimePurpose::Invite,
                        password: SecretString::new("member password".into()),
                    },
                )
                .await
                .unwrap(),
        );
    }
    let shared = control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(&control, &owner, 20).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([20; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    owner = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, owner_token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let mut membership_revision = ControlRevision::ZERO;
    for (index, role) in [SpaceRole::Editor, SpaceRole::Viewer]
        .into_iter()
        .enumerate()
    {
        let changed = control
            .change_membership(
                scope(&owner, &shared.history),
                MembershipChange {
                    command: CommandKey::from_bytes([21 + index as u8; 16]),
                    member: sessions[index].account.id.clone(),
                    role: Some(role),
                    expected: membership_revision,
                },
            )
            .await
            .unwrap();
        membership_revision = changed.revision;
    }
    let mut actors = Vec::new();
    for session in &sessions {
        actors.push(AccountContext::new(
            control
                .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
                .await
                .unwrap(),
            budget(),
        ));
    }
    let provider = ProviderService::new(
        control.clone(),
        keys,
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    let port: &dyn ProviderAdminPort = &provider;
    provider
        .create_credential(
            owner.clone(),
            AccountMutation {
                identity: identity(&control, &owner, 10).await,
                input: credential_input("provider-secret"),
            },
        )
        .await
        .unwrap();
    provider
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(&control, &owner, 11).await,
                input: resource_input(),
            },
        )
        .await
        .unwrap();
    for key in [40, 41] {
        let current = current_resource(&provider, &owner).await;
        provider
            .put_model(
                owner.clone(),
                AccountMutation {
                    identity: identity(&control, &owner, key).await,
                    input: PutProviderModel {
                        resource: current.id,
                        expected: current.revision,
                        model: ProviderModelSpec {
                            id: ModelProfileId::from_bytes([key; 16]),
                            wire_name: format!("model-{key}"),
                            kind: ProviderModelKind::Completion,
                            accounting: TokenAccountingProfile::ConservativeModelCapV1,
                            max_input_tokens: 8192,
                            max_output_tokens: 512,
                            tools: false,
                        },
                        default: key == 40,
                    },
                },
            )
            .await
            .unwrap();
    }
    let project_a = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([51; 16]),
    };
    let project_b = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([52; 16]),
    };
    for project in [&project_a, &project_b] {
        fixture.catalog.project_entries.lock().unwrap().insert(
            (project.space_id.clone(), project.folder_id.clone()),
            ProjectInfo {
                folder: project.clone(),
                name: "Project".into(),
            },
        );
    }
    let private = offer(
        &control,
        &provider,
        &owner,
        25,
        ProviderAttachmentTarget::Personal {
            owner: owner.auth().principal().clone(),
            space: shared.space.id.clone(),
        },
        None,
    )
    .await;
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let mut space_offer = offer(
        &control,
        &provider,
        &owner,
        60,
        ProviderAttachmentTarget::Space(shared.space.id.clone()),
        Some(now + 60_000),
    )
    .await;
    let editor = scope(&actors[0], &shared.history);
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: None,
                page: page(10, None)
            }
        )
        .await
        .unwrap()
        .items
        .is_empty()
    );
    assert!(
        port.list_offer_models(editor.clone(), space_offer.id.clone(), page(10, None))
            .await
            .is_err()
    );
    space_offer = approve(&control, &provider, &owner, 160, &space_offer).await;
    let a = offer(
        &control,
        &provider,
        &owner,
        61,
        ProviderAttachmentTarget::Project(project_a.clone()),
        None,
    )
    .await;
    let a = approve(&control, &provider, &owner, 161, &a).await;
    let b = offer(
        &control,
        &provider,
        &owner,
        62,
        ProviderAttachmentTarget::Project(project_b.clone()),
        None,
    )
    .await;
    let b = approve(&control, &provider, &owner, 162, &b).await;

    // Distinct members can read a shared offer concurrently without upgrading
    // their shared admission locks to exclusive Space locks.
    for _ in 0..20 {
        let query = || ProviderOfferQuery {
            project: None,
            page: page(10, None),
        };
        let (editor_read, viewer_read) = tokio::join!(
            port.list_offers(scope(&actors[0], &shared.history), query()),
            port.list_offers(scope(&actors[1], &shared.history), query()),
        );
        assert_eq!(editor_read.unwrap().items.len(), 1);
        assert_eq!(viewer_read.unwrap().items.len(), 1);
    }

    // First review is a real public-port read by distinct ordinary members. Both
    // may inspect the offered metadata before any personal consent exists.
    let mut model_cursor = None;
    for (index, actor) in actors[..2].iter().enumerate() {
        let ctx = scope(actor, &shared.history);
        let read = port
            .list_offers(
                ctx.clone(),
                ProviderOfferQuery {
                    project: None,
                    page: page(10, None),
                },
            )
            .await
            .unwrap();
        assert_eq!(read.items.len(), 1);
        let review = &read.items[0];
        assert_eq!(review.attachment.id, space_offer.id);
        assert_eq!(review.resource.owner, owner.auth().principal().clone());
        let safe = serde_json::to_string(&review.resource).unwrap();
        assert!(
            !safe.contains("provider-secret")
                && !safe.contains("tenant-secret")
                && !safe.contains("v1.")
        );
        assert!(
            port.list_credentials(actor.clone(), page(10, None))
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            port.list_resources(actor.clone(), page(10, None))
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            port.list_offer_models(ctx.clone(), private.id.clone(), page(10, None))
                .await
                .is_err()
        );
        assert!(
            port.inspect_attachment(actor.clone(), private.id.clone())
                .await
                .is_err()
        );
        let first = port
            .list_offer_models(ctx.clone(), space_offer.id.clone(), page(1, None))
            .await
            .unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(
            first.items[0].model.id,
            ModelProfileId::from_bytes([40; 16])
        );
        let next = first.continuation.unwrap();
        let second = port
            .list_offer_models(
                ctx.clone(),
                space_offer.id.clone(),
                page(1, Some(next.clone())),
            )
            .await
            .unwrap();
        assert_eq!(
            second.items[0].model.id,
            ModelProfileId::from_bytes([41; 16])
        );
        assert!(second.continuation.is_none());
        if index == 0 {
            model_cursor = Some(next);
        }
        let personal = port
            .request_attachment(
                actor.clone(),
                AccountMutation {
                    identity: identity(&control, actor, 70).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([70 + index as u8; 16]),
                        expected: None,
                        resource: review.resource.id.clone(),
                        resource_consent_epoch: review.resource.consent_epoch,
                        credential_consent_epoch: review.current_credential_consent_epoch,
                        target: ProviderAttachmentTarget::Personal {
                            owner: actor.auth().principal().clone(),
                            space: shared.space.id.clone(),
                        },
                        consent: ProviderDisclosureConsent::attest_checked(
                            review.attachment.disclosure.clone(),
                        ),
                        expires_at_ms: None,
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(personal.value.state, ProviderAttachmentState::Approved);
        let selected = provider
            .select_provider(
                ctx,
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: Some(review.resource.id.clone()),
                    model: Some(ModelProfileId::from_bytes([40; 16])),
                    project: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(selected.provider, review.resource.id);
    }
    let resource = current_resource(&provider, &owner).await;
    concurrent_selection(
        &control,
        &provider,
        &owner,
        &actors,
        &shared.history,
        resource.id.clone(),
    )
    .await;
    // The same metadata capability does not grant modification authority.
    let resource = current_resource(&provider, &owner).await;
    assert!(matches!(
        port.delete_resource(
            actors[0].clone(),
            AccountMutation {
                identity: identity(&control, &actors[0], 80).await,
                input: DeleteProviderResource {
                    resource: resource.id.clone(),
                    expected: resource.revision
                },
            }
        )
        .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        port.list_offer_models(
            editor.clone(),
            space_offer.id.clone(),
            page(1, model_cursor)
        )
        .await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorStale
    ));

    let first = port
        .list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_a.clone()),
                page: page(1, None),
            },
        )
        .await
        .unwrap();
    let next = first.continuation.clone().unwrap();
    let second = port
        .list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_a.clone()),
                page: page(1, Some(next.clone())),
            },
        )
        .await
        .unwrap();
    let ids = first
        .items
        .iter()
        .chain(&second.items)
        .map(|item| item.attachment.id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(ids, BTreeSet::from([space_offer.id.clone(), a.id.clone()]));
    assert!(second.continuation.is_none());
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_b.clone()),
                page: page(1, Some(next.clone()))
            }
        )
        .await
        .is_err()
    );
    assert!(
        port.list_offers(
            scope(&actors[1], &shared.history),
            ProviderOfferQuery {
                project: Some(project_a.clone()),
                page: page(1, Some(next))
            }
        )
        .await
        .is_err()
    );
    let removed = fixture
        .catalog
        .project_entries
        .lock()
        .unwrap()
        .remove(&(project_a.space_id.clone(), project_a.folder_id.clone()))
        .unwrap();
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_a.clone()),
                page: page(10, None)
            }
        )
        .await
        .is_err()
    );
    assert!(
        port.list_offer_models(editor.clone(), a.id.clone(), page(10, None))
            .await
            .is_err()
    );
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project_a.space_id.clone(), project_a.folder_id.clone()),
        removed,
    );

    // An unrelated principal cannot manufacture the requested Space context.
    assert!(SpaceContext::new(actors[2].auth().clone(), shared.history.clone(), budget()).is_err());
    let outsider_space = sessions[2].account.personal_space.clone().unwrap();
    let outsider_history = fixture
        .catalog
        .space(budget(), outsider_space)
        .await
        .unwrap()
        .history;
    assert!(
        port.list_offers(
            scope(&actors[2], &outsider_history),
            ProviderOfferQuery {
                project: None,
                page: page(10, None)
            }
        )
        .await
        .unwrap()
        .items
        .is_empty()
    );
    assert!(
        port.list_offer_models(
            scope(&actors[2], &outsider_history),
            space_offer.id.clone(),
            page(10, None)
        )
        .await
        .is_err()
    );
    let foreign = FolderRef {
        space_id: outsider_history.space_id,
        folder_id: project_a.folder_id.clone(),
    };
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(foreign),
                page: page(10, None)
            }
        )
        .await
        .is_err()
    );

    let removed_member = control
        .change_membership(
            scope(&owner, &shared.history),
            MembershipChange {
                command: CommandKey::from_bytes([183; 16]),
                member: sessions[1].account.id.clone(),
                role: None,
                expected: membership_revision,
            },
        )
        .await
        .unwrap();
    assert!(
        port.list_offers(
            scope(&actors[1], &shared.history),
            ProviderOfferQuery {
                project: None,
                page: page(10, None)
            }
        )
        .await
        .is_err()
    );
    assert!(
        port.list_offer_models(
            scope(&actors[1], &shared.history),
            space_offer.id.clone(),
            page(10, None)
        )
        .await
        .is_err()
    );

    port.revoke_attachment(
        owner.clone(),
        AccountMutation {
            identity: identity(&control, &owner, 180).await,
            input: RevokeProviderAttachment {
                id: b.id.clone(),
                expected: b.revision,
            },
        },
    )
    .await
    .unwrap();
    assert!(
        port.list_offer_models(editor.clone(), b.id, page(10, None))
            .await
            .is_err()
    );
    fixture.clock.0.fetch_add(60_001, Ordering::SeqCst);
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: None,
                page: page(10, None)
            }
        )
        .await
        .unwrap()
        .items
        .is_empty()
    );
    assert!(
        port.list_offer_models(editor.clone(), space_offer.id, page(10, None))
            .await
            .is_err()
    );
    assert_eq!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_a.clone()),
                page: page(10, None)
            }
        )
        .await
        .unwrap()
        .items
        .len(),
        1
    );

    let credential = provider
        .list_credentials(owner.clone(), page(10, None))
        .await
        .unwrap()
        .items
        .remove(0);
    provider
        .update_credential(
            owner.clone(),
            AccountMutation {
                identity: identity(&control, &owner, 181).await,
                input: UpdateProviderCredential {
                    id: credential.id,
                    expected: credential.revision,
                    name: credential.name,
                    injection: CredentialInjection {
                        header: "x-api-key".into(),
                        prefix: String::new(),
                    },
                    secret: None,
                    limits: credential.limits,
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    assert!(
        port.list_offers(
            editor.clone(),
            ProviderOfferQuery {
                project: Some(project_a),
                page: page(10, None)
            }
        )
        .await
        .unwrap()
        .items
        .is_empty()
    );
    assert!(
        port.list_offer_models(editor, a.id, page(10, None))
            .await
            .is_err()
    );
    control
        .change_space_lifecycle(
            scope(&owner, &shared.history),
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([190; 16]),
                lifecycle: SpaceLifecycle::Archived,
                expected: removed_member.revision,
            },
        )
        .await
        .unwrap();
    assert!(
        port.list_offers(
            scope(&actors[0], &shared.history),
            ProviderOfferQuery {
                project: None,
                page: page(10, None)
            }
        )
        .await
        .is_err()
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_call_log")
            .await,
        0
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM provider_budget_buckets")
            .await,
        0
    );
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_offers_support_first_consent_without_management_authority() {
    offers(false).await;
}
#[tokio::test]
async fn postgres_offers_support_first_consent_without_management_authority() {
    offers(true).await;
}

async fn preferences_by_model_kind(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "provider_preferences_by_kind").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new(
                    "provider preference fixture password".into(),
                )),
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

    let provider = ProviderService::new(
        control.clone(),
        keys,
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    provider
        .create_credential(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 1).await,
                input: credential_input("secret-key"),
            },
        )
        .await
        .unwrap();
    let mut res_spec = resource_input();
    res_spec.timeout_ms = 90_000;
    let resource = provider
        .create_resource(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 2).await,
                input: res_spec,
            },
        )
        .await
        .unwrap()
        .value;
    assert_eq!(resource.timeout_ms, 90_000);

    let completion_model = ModelProfileId::from_bytes([31; 16]);
    let embedding_model = ModelProfileId::from_bytes([32; 16]);
    provider
        .put_model(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 3).await,
                input: PutProviderModel {
                    resource: resource.id.clone(),
                    expected: resource.revision,
                    model: ProviderModelSpec {
                        id: completion_model.clone(),
                        wire_name: "gpt-4o".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 128_000,
                        max_output_tokens: 4_096,
                        tools: true,
                    },
                    default: true,
                },
            },
        )
        .await
        .unwrap();
    let current_res = current_resource(&provider, &ctx).await;
    provider
        .put_model(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 4).await,
                input: PutProviderModel {
                    resource: resource.id.clone(),
                    expected: current_res.revision,
                    model: ProviderModelSpec {
                        id: embedding_model.clone(),
                        wire_name: "text-embedding-3-small".into(),
                        kind: ProviderModelKind::Embedding { dimension: 1536 },
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 8_192,
                        max_output_tokens: 0,
                        tools: false,
                    },
                    default: false,
                },
            },
        )
        .await
        .unwrap();

    let _attachment = offer(
        &control,
        &provider,
        &ctx,
        5,
        ProviderAttachmentTarget::Personal {
            owner,
            space: personal_id.clone(),
        },
        None,
    )
    .await;

    let plane = ControlPlane::new(provider);
    plane
        .update_provider_preference(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 6).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Completion,
                    resource: resource.id.clone(),
                    model: completion_model.clone(),
                },
            },
        )
        .await
        .unwrap();
    plane
        .update_provider_preference(
            ctx.clone(),
            AccountMutation {
                identity: identity(&control, &ctx, 7).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Embedding,
                    resource: resource.id,
                    model: embedding_model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let personal_history = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&personal_id)
        .unwrap()
        .2
        .history
        .clone();
    let space_ctx = scope(&ctx, &personal_history);
    let selected_completion = plane
        .select_provider(
            space_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: None,
                model: None,
                project: None,
            },
        )
        .await
        .unwrap();
    let selected_embedding = plane
        .select_provider(
            space_ctx,
            SelectProvider {
                kind: PreferenceModelKind::Embedding,
                resource: None,
                model: None,
                project: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(selected_completion.model, completion_model);
    assert_eq!(selected_embedding.model, embedding_model);

    drop(plane);
    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_completion_and_embedding_preferences_coexist_by_kind() {
    preferences_by_model_kind(false).await;
}
#[tokio::test]
async fn postgres_completion_and_embedding_preferences_coexist_by_kind() {
    preferences_by_model_kind(true).await;
}

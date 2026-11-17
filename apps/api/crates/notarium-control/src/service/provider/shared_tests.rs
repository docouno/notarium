use super::*;
use notarium_core::auth::SpaceKind;

fn consent() -> ProviderDisclosureConsent {
    ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
        classes: BTreeSet::from([DocClass::UserDoc]),
    })
}
async fn shared(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let server = HttpsFixture::start(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
        completion_reply(ProviderWireKind::OpenaiCompatible, 0)
    });
    let mut setup = Setup::new(
        pg,
        "dispatch_shared",
        ProviderWireKind::OpenaiCompatible,
        &server,
    )
    .await;
    let owner = setup.ctx.auth().principal().clone();
    let shared = setup
        .provider
        .control
        .create_space(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 90, setup.revision),
                input: CreateSpace {
                    id: SpaceId::from_bytes([90; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared".into(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = shared.revision;
    setup.ctx = AccountContext::new(
        setup
            .provider
            .control
            .resolve(evidence(AuthEvidenceKind::Session, setup.session.expose()))
            .await
            .unwrap(),
        budget(),
    );
    setup.space =
        SpaceContext::new(setup.ctx.auth().clone(), shared.value.history, budget()).unwrap();
    let catalog = setup
        .fixture
        .catalog
        .space(budget(), setup.space.scope().space_id.clone())
        .await
        .unwrap();
    setup.document = ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: catalog.space.id.clone(),
            note_id: NoteId::from_bytes([91; 16]),
        },
        RevisionId::from_bytes([91; 16]),
        ResourceFacts {
            space: catalog.space.clone(),
            class: DocClass::UserDoc,
            ancestor_folders: vec![],
            folder_write_locked: false,
            ability_package: None,
        },
        Lifecycle::Active,
        "private source".into(),
        ContentDigest::from_bytes(*blake3::hash(b"private source").as_bytes()),
    )
    .unwrap();
    *setup.egress.current.lock().unwrap() =
        vec![ProviderCurrentContent::Note(setup.document.metadata())];
    // The wrapper may carry an old or asserted disclosure policy. Only current
    // SQL sender consent and approved shared attachment authorize the wire.
    setup.selection.policy = ProviderPolicy {
        provider: setup.selection.provider.clone(),
        audience: ProviderAudience::Shared {
            space: catalog.space.id.clone(),
            attached: true,
            space_consented: true,
            sender_consented: true,
        },
        allowed_classes: BTreeSet::from([DocClass::UserDoc]),
    };
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(91))
            .await
            .is_err()
    );
    let reviewed = setup
        .provider
        .inspect_attachment(setup.ctx.clone(), RequestId::from_bytes([5; 16]))
        .await
        .unwrap();
    let offered = setup
        .provider
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 92, setup.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([92; 16]),
                    expected: None,
                    resource: setup.selection.provider.clone(),
                    resource_consent_epoch: reviewed.resource.consent_epoch,
                    credential_consent_epoch: reviewed.current_credential_consent_epoch,
                    target: ProviderAttachmentTarget::Space(catalog.space.id.clone()),
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = offered.revision;
    assert_eq!(offered.value.state, ProviderAttachmentState::Pending);
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(91))
            .await
            .is_err()
    );
    let approved = setup
        .provider
        .approve_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 93, setup.revision),
                input: ApproveProviderAttachment {
                    id: offered.value.id.clone(),
                    expected: offered.value.revision,
                    resource_consent_epoch: offered.value.resource_consent_epoch,
                    credential_consent_epoch: offered.value.credential_consent_epoch,
                    consent: consent(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = approved.revision;
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(91))
            .await
            .is_err(),
        "Space owner approval does not replace sender consent"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    let sender = setup
        .provider
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 94, setup.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([94; 16]),
                    expected: None,
                    resource: setup.selection.provider.clone(),
                    resource_consent_epoch: approved.value.resource_consent_epoch,
                    credential_consent_epoch: approved.value.credential_consent_epoch,
                    target: ProviderAttachmentTarget::Personal {
                        owner: owner.clone(),
                        space: catalog.space.id.clone(),
                    },
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = sender.revision;
    let preference = setup
        .provider
        .set_preference(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 95, setup.revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Space(catalog.space.id.clone()),
                    kind: PreferenceModelKind::Completion,
                    resource: setup.selection.provider.clone(),
                    model: setup.selection.model.clone(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = preference.revision;
    let selected = setup
        .provider
        .select_provider(
            setup.space.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: None,
                model: None,
                project: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(selected.provider, setup.selection.provider);
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(91))
            .await
            .is_ok()
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let revoked = setup
        .provider
        .revoke_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 96, setup.revision),
                input: RevokeProviderAttachment {
                    id: approved.value.id,
                    expected: approved.value.revision,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = revoked.revision;
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(97))
            .await
            .is_err()
    );
    assert!(
        setup
            .provider
            .select_provider(
                setup.space.clone(),
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
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.close().await;
}
#[tokio::test]
async fn sqlite_shared_sender_and_owner_consent() {
    shared(false).await;
}
#[tokio::test]
async fn postgres_shared_sender_and_owner_consent() {
    shared(true).await;
}

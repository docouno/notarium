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
    // Shared Space 2-step deterministic search embedding resolution:
    // space attachment -> project: None; single project -> Some(p1); two projects -> None.
    let embedding_model = ModelProfileId::from_bytes([4; 16]);
    let space_explicit = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            Some(embedding_model.clone()),
            budget(),
        )
        .await
        .unwrap()
        .expect("shared space attachment resolves explicit embedding model");
    assert_eq!(space_explicit.provider, setup.selection.provider);
    assert_eq!(space_explicit.model, embedding_model);
    assert_eq!(space_explicit.project, None);

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
        setup
            .provider
            .resolve_search_embedding_model(
                &ServiceAuthority::admit(ServicePurpose::Search),
                setup.space.scope().clone(),
                Some(embedding_model.clone()),
                budget(),
            )
            .await
            .unwrap()
            .is_none(),
        "revoked space attachment yields Ok(None)"
    );
    // Register two projects in the catalog and verify unique vs ambiguous project preferences/attachments.
    let p1 = FolderRef {
        space_id: catalog.space.id.clone(),
        folder_id: FolderId::from_bytes([201; 16]),
    };
    let p2 = FolderRef {
        space_id: catalog.space.id.clone(),
        folder_id: FolderId::from_bytes([202; 16]),
    };
    {
        let mut projects = setup.fixture.catalog.project_entries.lock().unwrap();
        projects.insert(
            (p1.space_id.clone(), p1.folder_id.clone()),
            ProjectInfo {
                folder: p1.clone(),
                name: "Project One".into(),
            },
        );
        projects.insert(
            (p2.space_id.clone(), p2.folder_id.clone()),
            ProjectInfo {
                folder: p2.clone(),
                name: "Project Two".into(),
            },
        );
    }
    let offer_p1 = setup
        .provider
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 98, setup.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([98; 16]),
                    expected: None,
                    resource: setup.selection.provider.clone(),
                    resource_consent_epoch: reviewed.resource.consent_epoch,
                    credential_consent_epoch: reviewed.current_credential_consent_epoch,
                    target: ProviderAttachmentTarget::Project(p1.clone()),
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = offer_p1.revision;
    let approve_p1 = setup
        .provider
        .approve_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 99, setup.revision),
                input: ApproveProviderAttachment {
                    id: offer_p1.value.id,
                    expected: offer_p1.value.revision,
                    resource_consent_epoch: offer_p1.value.resource_consent_epoch,
                    credential_consent_epoch: offer_p1.value.credential_consent_epoch,
                    consent: consent(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = approve_p1.revision;
    let pref_p1 = setup
        .provider
        .set_preference(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 100, setup.revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(p1.clone()),
                    kind: PreferenceModelKind::Embedding,
                    resource: setup.selection.provider.clone(),
                    model: embedding_model.clone(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = pref_p1.revision;
    let resolved_p1 = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            None,
            budget(),
        )
        .await
        .unwrap()
        .expect("unique active project preference resolves");
    assert_eq!(resolved_p1.project, Some(p1.clone()));
    let explicit_p1 = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            Some(embedding_model.clone()),
            budget(),
        )
        .await
        .unwrap()
        .expect("unique active project attachment resolves explicit model");
    assert_eq!(explicit_p1.project, Some(p1));

    // Adding a second active project attachment & preference makes both lookups ambiguous -> Ok(None).
    let offer_p2 = setup
        .provider
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 101, setup.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([101; 16]),
                    expected: None,
                    resource: setup.selection.provider.clone(),
                    resource_consent_epoch: reviewed.resource.consent_epoch,
                    credential_consent_epoch: reviewed.current_credential_consent_epoch,
                    target: ProviderAttachmentTarget::Project(p2.clone()),
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = offer_p2.revision;
    let approve_p2 = setup
        .provider
        .approve_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 102, setup.revision),
                input: ApproveProviderAttachment {
                    id: offer_p2.value.id,
                    expected: offer_p2.value.revision,
                    resource_consent_epoch: offer_p2.value.resource_consent_epoch,
                    credential_consent_epoch: offer_p2.value.credential_consent_epoch,
                    consent: consent(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = approve_p2.revision;
    let pref_p2 = setup
        .provider
        .set_preference(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 103, setup.revision),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(p2),
                    kind: PreferenceModelKind::Embedding,
                    resource: setup.selection.provider.clone(),
                    model: embedding_model.clone(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = pref_p2.revision;
    assert!(
        setup
            .provider
            .resolve_search_embedding_model(
                &ServiceAuthority::admit(ServicePurpose::Search),
                setup.space.scope().clone(),
                None,
                budget(),
            )
            .await
            .unwrap()
            .is_none(),
        "two active project preferences must return Ok(None)"
    );
    assert!(
        setup
            .provider
            .resolve_search_embedding_model(
                &ServiceAuthority::admit(ServicePurpose::Search),
                setup.space.scope().clone(),
                Some(embedding_model),
                budget(),
            )
            .await
            .unwrap()
            .is_none(),
        "two active project attachments must return Ok(None)"
    );
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

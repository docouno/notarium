use super::*;

async fn switch_default(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let seen = Arc::new(AtomicUsize::new(0));
    let registered = Arc::new(tokio::sync::Notify::new());
    let count = seen.clone();
    let entered = registered.clone();
    let server = HttpsFixture::start_io(move |_, stream| {
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            // Keep an admitted request active until Control drains its registration.
            entered.notify_one();
            let _ = stream.read(&mut [0; 1]);
            return Ok(());
        }
        crate::outbound::test_https::write_reply(
            stream,
            Reply::json(json!({
                "model": "fixture-embedding",
                "data": [{"index": 0, "embedding": [0.25, -0.5]}],
                "usage": {"prompt_tokens": 3, "total_tokens": 3}
            })),
        )
    });
    let setup = Setup::new(
        pg,
        "search_default",
        ProviderWireKind::OpenaiCompatible,
        &server,
    )
    .await;
    let owner = setup.ctx.auth().principal().clone();
    let a = setup.selection.provider.clone();
    let b = ProviderResourceId::from_bytes([42; 16]);
    let model = ModelProfileId::from_bytes([4; 16]);
    let identity = |id, revision| command(&owner, &owner, id, revision);
    let created = setup
        .other
        .create_resource(
            setup.ctx.clone(),
            AccountMutation {
                identity: identity(41, setup.revision),
                input: ProviderResourceSpec {
                    id: b.clone(),
                    name: "Other recipient".into(),
                    wire: ProviderWireKind::OpenaiCompatible,
                    base_url: server.origin.clone(),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 30_000,
                },
            },
        )
        .await
        .unwrap();
    let profile = setup
        .provider
        .list_models(
            setup.ctx.clone(),
            a.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|row| row.model.id == model)
        .unwrap()
        .model;
    let configured = setup
        .other
        .put_model(
            setup.ctx.clone(),
            AccountMutation {
                identity: identity(42, created.revision),
                input: PutProviderModel {
                    resource: b.clone(),
                    expected: created.value.revision,
                    model: profile,
                    default: true,
                },
            },
        )
        .await
        .unwrap();
    let offered = setup
        .other
        .list_resources(
            setup.ctx.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|resource| resource.id == b)
        .unwrap();
    let consent = setup
        .other
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: identity(43, configured.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([43; 16]),
                    expected: None,
                    resource: b.clone(),
                    resource_consent_epoch: offered.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: owner.clone(),
                        space: setup.space.scope().space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: BTreeSet::from([DocClass::UserDoc]),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();
    let pref = |resource, id, revision| AccountMutation {
        identity: identity(id, revision),
        input: SetProviderPreference {
            scope: ProviderPreferenceScope::Personal,
            kind: PreferenceModelKind::Embedding,
            resource,
            model: model.clone(),
        },
    };
    let original = setup
        .other
        .set_preference(setup.ctx.clone(), pref(a.clone(), 44, consent.revision))
        .await
        .unwrap();
    let input = |id, selection| {
        let mut request = EmbeddingRequest::query(
            CommandKey::from_bytes([id; 16]),
            model.clone(),
            a.clone(),
            EmbeddingQueryInput {
                text: "related search".into(),
                tokens: 3,
                classes: BTreeSet::from([DocClass::UserDoc]),
                project_scope: None,
                folder: None,
            },
        );
        request.selection = selection;
        request.with_runtime_epochs(setup.selection.runtime_epochs)
    };
    let implicit = || EmbeddingSelection::SearchDefault { project: None };
    // This admission to A remains valid as an explicit call after the switch.
    assert!(
        setup
            .provider
            .query_disclosure(setup.space.clone(), a.clone(), model.clone(), None, None)
            .await
            .unwrap()
            .contains(&DocClass::UserDoc)
    );
    let stale = input(47, implicit());
    let active = setup
        .provider
        .embed(setup.space.clone(), input(45, implicit()));
    let switch = async {
        registered.notified().await;
        let same = setup
            .other
            .set_preference(setup.ctx.clone(), pref(a.clone(), 50, original.revision))
            .await
            .unwrap();
        assert_eq!(setup.egress.active.load(Ordering::SeqCst), 1);
        setup
            .other
            .set_preference(setup.ctx.clone(), pref(b.clone(), 46, same.revision))
            .await
            .unwrap();
    };
    let (active, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(active, switch)
    })
    .await
    .unwrap();
    assert!(active.is_err());
    let selected = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            None,
            budget(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.provider, b);
    assert!(
        matches!(setup.provider.embed(setup.space.clone(), stale).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::NotReady)
    );
    let mut parts = setup.embedding(48, &setup.document);
    parts.selection = implicit();
    assert!(
        matches!(setup.provider.embed(setup.space.clone(), parts).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::NotReady)
    );
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert!(
        setup
            .provider
            .embed(setup.space.clone(), input(49, EmbeddingSelection::Explicit))
            .await
            .is_ok()
    );
    assert_eq!(seen.load(Ordering::SeqCst), 2);
    setup.close().await;
}

#[tokio::test]
async fn sqlite_default_change_drains_only_implicit_search_dispatch() {
    switch_default(false).await;
}

#[tokio::test]
async fn postgres_default_change_drains_only_implicit_search_dispatch() {
    switch_default(true).await;
}

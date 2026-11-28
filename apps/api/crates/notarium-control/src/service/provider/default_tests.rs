use super::*;

async fn other_resource(
    setup: &Setup,
    ctx: &AccountContext,
    server: &HttpsFixture,
    revision: ControlRevision,
) -> (ProviderResourceInfo, ControlRevision) {
    let b = ProviderResourceId::from_bytes([42; 16]);
    let model = ModelProfileId::from_bytes([4; 16]);
    let owner = ctx.auth().principal();
    let identity = |id, revision| command(owner, owner, id, revision);
    let created = setup
        .other
        .create_resource(
            ctx.clone(),
            AccountMutation {
                identity: identity(41, revision),
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
            setup.selection.provider.clone(),
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
            ctx.clone(),
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
        .list_resources(ctx.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|resource| resource.id == b)
        .unwrap();
    (offered, configured.revision)
}

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
    let (offered, revision) = other_resource(&setup, &setup.ctx, &server, setup.revision).await;
    let consent = setup
        .other
        .request_attachment(
            setup.ctx.clone(),
            AccountMutation {
                identity: identity(43, revision),
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

async fn mutation<T>(
    setup: &Setup,
    actor: &AccountContext,
    key: u8,
    input: T,
) -> AccountMutation<T> {
    let id = actor.auth().principal();
    let revision = setup
        .other
        .control
        .account(actor.clone(), id.clone())
        .await
        .unwrap()
        .revision;
    AccountMutation {
        identity: command(id, id, key, revision),
        input,
    }
}

fn consent() -> ProviderDisclosureConsent {
    ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
        classes: BTreeSet::from([DocClass::UserDoc]),
    })
}

async fn approve(setup: &Setup, row: &ProviderAttachmentInfo, key: u8) -> ProviderAttachmentInfo {
    let input = ApproveProviderAttachment {
        id: row.id.clone(),
        expected: row.revision,
        resource_consent_epoch: row.resource_consent_epoch,
        credential_consent_epoch: row.credential_consent_epoch,
        consent: consent(),
    };
    setup
        .other
        .approve_attachment(
            setup.ctx.clone(),
            mutation(setup, &setup.ctx, key, input).await,
        )
        .await
        .unwrap()
        .value
}

async fn set_owner_disabled(setup: &Setup, account: &PrincipalId, disabled: bool, key: u8) {
    let actor = setup.ctx.auth().principal();
    let control = &setup.other.control;
    let revision = control
        .account(setup.ctx.clone(), account.clone())
        .await
        .unwrap()
        .revision;
    control
        .set_disabled(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(actor, account, key, revision),
                input: SetAccountDisabled {
                    account: account.clone(),
                    disabled,
                },
            },
        )
        .await
        .unwrap();
}

async fn project_activation(pg: bool) {
    use notarium_core::auth::{SpaceKind, SpaceRole};

    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let seen = Arc::new(AtomicUsize::new(0));
    let registered = Arc::new(tokio::sync::Notify::new());
    let explicit_registered = Arc::new(tokio::sync::Notify::new());
    let explicit_entered = explicit_registered.clone();
    let (release, wait) = std::sync::mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let count = seen.clone();
    let entered = registered.clone();
    let server = HttpsFixture::start_io(move |request, stream| {
        count.fetch_add(1, Ordering::SeqCst);
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        if body["input"][0] == "implicit" {
            entered.notify_one();
            let _ = stream.read(&mut [0; 1]);
            return Ok(());
        }
        explicit_entered.notify_one();
        wait.lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        crate::outbound::test_https::write_reply(
            stream,
            Reply::json(json!({
                "model":"fixture-embedding", "data":[{"index":0,"embedding":[0.25,-0.5]}],
                "usage":{"prompt_tokens":3,"total_tokens":3}
            })),
        )
    });
    let mut setup = Setup::new(
        pg,
        "project_activation",
        ProviderWireKind::OpenaiCompatible,
        &server,
    )
    .await;
    let control = setup.provider.control.clone();
    let owner = setup.ctx.auth().principal().clone();
    let other = control
        .create_account(
            setup.ctx.clone(),
            mutation(
                &setup,
                &setup.ctx,
                60,
                NewAccount {
                    username: "contributor".into(),
                    display_name: "Contributor".into(),
                    email: None,
                },
            )
            .await,
        )
        .await
        .unwrap()
        .value;
    let invite = control
        .issue_one_time(
            setup.ctx.clone(),
            IssueOneTime {
                account: other.id.clone(),
                purpose: OneTimePurpose::Invite,
                expected: other.revision,
            },
        )
        .await
        .unwrap();
    let session = control
        .consume_one_time(
            budget(),
            ConsumeOneTime {
                token: invite.value.token,
                purpose: OneTimePurpose::Invite,
                password: SecretString::new("member password".into()),
            },
        )
        .await
        .unwrap();
    let shared = control
        .create_space(
            setup.ctx.clone(),
            mutation(
                &setup,
                &setup.ctx,
                61,
                CreateSpace {
                    id: SpaceId::from_bytes([61; 16]),
                    kind: SpaceKind::Shared,
                    name: "Two projects".into(),
                },
            )
            .await,
        )
        .await
        .unwrap()
        .value;
    setup.ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, setup.session.expose()))
            .await
            .unwrap(),
        budget(),
    );
    setup.space = SpaceContext::new(setup.ctx.auth().clone(), shared.history, budget()).unwrap();
    control
        .change_membership(
            setup.space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([62; 16]),
                member: other.id.clone(),
                role: Some(SpaceRole::Editor),
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    let contributor = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let revision = control
        .account(contributor.clone(), other.id.clone())
        .await
        .unwrap()
        .revision;
    let (b, _) = other_resource(&setup, &contributor, &server, revision).await;
    let a = setup
        .provider
        .inspect_attachment(setup.ctx.clone(), RequestId::from_bytes([5; 16]))
        .await
        .unwrap();
    let project = |id| FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([id; 16]),
    };
    let p1 = project(1);
    let p2 = project(2);
    for p in [&p1, &p2] {
        setup
            .fixture
            .catalog
            .project_entries
            .lock()
            .unwrap()
            .insert(
                (p.space_id.clone(), p.folder_id.clone()),
                ProjectInfo {
                    folder: p.clone(),
                    name: "Catalog project".into(),
                    project_slug: "catalog-project".into(),
                },
            );
    }
    let offer = |id, r: &ProviderResourceInfo, credential, target| RequestProviderAttachment {
        id: RequestId::from_bytes([id; 16]),
        expected: None,
        resource: r.id.clone(),
        resource_consent_epoch: r.consent_epoch,
        credential_consent_epoch: credential,
        target,
        consent: consent(),
        expires_at_ms: None,
    };
    let model = ModelProfileId::from_bytes([4; 16]);
    let mut other_offer = None;
    for (k, actor, r, epoch, p) in [
        (
            63,
            &setup.ctx,
            &a.resource,
            a.current_credential_consent_epoch,
            &p1,
        ),
        (66, &contributor, &b, None, &p2),
    ] {
        let input = offer(k, r, epoch, ProviderAttachmentTarget::Project(p.clone()));
        let pending = setup
            .other
            .request_attachment(actor.clone(), mutation(&setup, actor, k, input).await)
            .await
            .unwrap()
            .value;
        let approved = approve(&setup, &pending, k + 1).await;
        if r.id == b.id {
            other_offer = Some(approved);
        }
        let pref = SetProviderPreference {
            scope: ProviderPreferenceScope::Project(p.clone()),
            kind: PreferenceModelKind::Embedding,
            resource: r.id.clone(),
            model: model.clone(),
        };
        setup
            .other
            .set_preference(
                setup.ctx.clone(),
                mutation(&setup, &setup.ctx, k + 2, pref).await,
            )
            .await
            .unwrap();
    }
    let personal = offer(
        69,
        &a.resource,
        a.current_credential_consent_epoch,
        ProviderAttachmentTarget::Personal {
            owner,
            space: shared.space.id.clone(),
        },
    );
    setup
        .other
        .request_attachment(
            setup.ctx.clone(),
            mutation(&setup, &setup.ctx, 69, personal).await,
        )
        .await
        .unwrap();
    let other_offer = other_offer.unwrap();
    for (round, reactivate_owner) in [false, true].into_iter().enumerate() {
        let pending = if reactivate_owner {
            set_owner_disabled(&setup, &other.id, true, 74).await;
            None
        } else {
            let mut renew = offer(66, &b, None, ProviderAttachmentTarget::Project(p2.clone()));
            renew.expected = Some(other_offer.revision);
            Some(
                setup
                    .other
                    .request_attachment(
                        contributor.clone(),
                        mutation(&setup, &contributor, 70, renew).await,
                    )
                    .await
                    .unwrap()
                    .value,
            )
        };
        let authority = ServiceAuthority::admit(ServicePurpose::Search);
        let resolve = || {
            setup.provider.resolve_search_embedding_model(
                &authority,
                setup.space.scope().clone(),
                None,
                budget(),
            )
        };
        let selected = resolve().await.unwrap().unwrap();
        assert_eq!(
            (&selected.provider, &selected.project),
            (&a.resource.id, &Some(p1.clone()))
        );
        let query = |id, implicit| {
            let mut request = EmbeddingRequest::query(
                CommandKey::from_bytes([id; 16]),
                model.clone(),
                a.resource.id.clone(),
                EmbeddingQueryInput {
                    text: if implicit { "implicit" } else { "explicit" }.into(),
                    tokens: 3,
                    classes: BTreeSet::from([DocClass::UserDoc]),
                    project_scope: Some(p1.clone()),
                    folder: None,
                },
            );
            if implicit {
                request.selection = EmbeddingSelection::SearchDefault {
                    project: Some(p1.clone()),
                };
            }
            request.with_runtime_epochs(selected.runtime_epochs)
        };
        let k = 80 + 3 * round as u8;
        let activate = async {
            registered.notified().await;
            explicit_registered.notified().await;
            if let Some(pending) = pending {
                approve(&setup, &pending, 71).await;
            } else {
                set_owner_disabled(&setup, &other.id, false, 75).await;
            }
            let cancellations = setup.egress.cancellations.lock().unwrap();
            assert_eq!(
                cancellations
                    .iter()
                    .rev()
                    .take(2)
                    .filter(|call| call.is_cancelled())
                    .count(),
                1
            );
            release.send(()).unwrap();
        };
        let (result, explicit, ()) =
            tokio::time::timeout(std::time::Duration::from_secs(8), async {
                tokio::join!(
                    setup.provider.embed(setup.space.clone(), query(k, true)),
                    setup
                        .provider
                        .embed(setup.space.clone(), query(k + 2, false)),
                    activate
                )
            })
            .await
            .unwrap();
        assert!(result.is_err());
        assert!(resolve().await.unwrap().is_none());
        assert!(
            matches!(setup.provider.embed(setup.space.clone(),query(k+1,true)).await,
            Err(PortError::Domain(DomainError::ValidationFailed{diagnostic})) if diagnostic.reason==ValidationReason::NotReady)
        );
        assert!(explicit.is_ok());
        assert_eq!(seen.load(Ordering::SeqCst), 2 * (round + 1));
    }
    setup.close().await;
}

#[tokio::test]
async fn sqlite_project_activation_drains_implicit_search() {
    project_activation(false).await
}

#[tokio::test]
async fn postgres_project_activation_drains_implicit_search() {
    project_activation(true).await
}

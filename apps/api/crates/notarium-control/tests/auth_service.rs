mod support;
use notarium_control::service::AuthenticationMode;
use notarium_core::{
    DomainError,
    auth::*,
    classes::{AbilityKind, DocClass},
    error::{CommitEffect, Diagnostic, PortError, ValidationReason},
    ids::*,
    model::*,
    ports::{control::*, *},
};
use std::sync::atomic::Ordering;
use support::*;

fn secret(value: &str) -> SecretString {
    SecretString::new(value.into())
}
fn denied<T: std::fmt::Debug>(result: Result<T, PortError>) {
    assert!(
        matches!(
            result,
            Err(PortError::Domain(DomainError::AuthenticationFailed))
        ),
        "{result:?}"
    );
}
fn unknown<T: std::fmt::Debug>(result: Result<T, PortError>) {
    match result {
        Err(PortError::Unavailable(failure)) => assert_eq!(failure.effect(), CommitEffect::Unknown),
        other => panic!("expected unknown commit, got {other:?}"),
    }
}
async fn account_context(
    service: &notarium_control::service::ControlService,
    token: &str,
) -> AccountContext {
    AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token))
            .await
            .unwrap(),
        budget(),
    )
}
async fn lifecycle(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "lifecycle").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "admin".into(),
                email: Some(" Admin@Example.test ".into()),
                display_name: "Administrator".into(),
                password: Some(secret("initial password")),
            },
        )
        .await
        .unwrap();
    let admin = bootstrap.account;
    let initial = bootstrap.session.unwrap();
    assert_eq!(admin.email.as_deref(), Some("admin@example.test"));
    assert_eq!(fixture.catalog.entries.lock().unwrap().len(), 1);
    let actor = account_context(&service, initial.token.expose()).await;
    assert_eq!(actor.auth().spaces().len(), 1);
    assert!(actor.auth().human_management());
    assert!(!actor.auth().has_cap(Cap::AbilityWrite));
    let ambient = service
        .resolve(unconfirmed_evidence(
            AuthEvidenceKind::Session,
            initial.token.expose(),
        ))
        .await
        .unwrap();
    assert!(!ambient.human_management());
    assert!(!ambient.has_cap(Cap::AbilityWrite));
    let mut interactive = evidence(AuthEvidenceKind::Session, initial.token.expose());
    interactive.evidence = interactive
        .evidence
        .with_human_management()
        .with_ability_write();
    let interactive_auth = service.resolve(interactive).await.unwrap();
    assert!(interactive_auth.human_management());
    assert!(interactive_auth.has_cap(Cap::AbilityWrite));
    denied(
        service
            .login(
                budget(),
                PasswordLogin {
                    identifier: "absent".into(),
                    password: secret("wrong"),
                },
            )
            .await,
    );
    denied(
        service
            .login(
                budget(),
                PasswordLogin {
                    identifier: "admin".into(),
                    password: secret("wrong"),
                },
            )
            .await,
    );
    let email_login = service
        .login(
            budget(),
            PasswordLogin {
                identifier: " ADMIN@EXAMPLE.TEST ".into(),
                password: secret("initial password"),
            },
        )
        .await
        .unwrap();
    assert_eq!(email_login.account.id, admin.id);
    let bob_command = AccountMutation {
        identity: command(&admin.id, &admin.id, 2, admin.revision),
        input: NewAccount {
            username: "bob".into(),
            email: None,
            display_name: "Bob".into(),
        },
    };
    let created = service
        .create_account(actor.clone(), bob_command.clone())
        .await
        .unwrap();
    let bob = created.value;
    assert_ne!(bob.personal_space, admin.personal_space);
    let replay = service
        .create_account(actor.clone(), bob_command)
        .await
        .unwrap();
    assert_eq!(replay.value.id, bob.id);
    assert_eq!(fixture.catalog.entries.lock().unwrap().len(), 2);
    let invitation = service
        .issue_one_time(
            actor.clone(),
            IssueOneTime {
                account: bob.id.clone(),
                purpose: OneTimePurpose::Invite,
                expected: bob.revision,
            },
        )
        .await
        .unwrap();
    denied(
        service
            .consume_one_time(
                budget(),
                ConsumeOneTime {
                    token: secret(invitation.value.token.expose()),
                    purpose: OneTimePurpose::Reset,
                    password: secret("bob password"),
                },
            )
            .await,
    );
    let bob_session = service
        .consume_one_time(
            budget(),
            ConsumeOneTime {
                token: secret(invitation.value.token.expose()),
                purpose: OneTimePurpose::Invite,
                password: secret("bob password"),
            },
        )
        .await
        .unwrap();
    denied(
        service
            .consume_one_time(
                budget(),
                ConsumeOneTime {
                    token: secret(invitation.value.token.expose()),
                    purpose: OneTimePurpose::Invite,
                    password: secret("bob password"),
                },
            )
            .await,
    );
    let bob_actor = account_context(&service, bob_session.token.expose()).await;
    assert_eq!(bob_actor.auth().spaces().len(), 1);
    assert!(
        !actor
            .auth()
            .spaces()
            .contains_key(bob.personal_space.as_ref().unwrap())
    );
    let pat = service
        .create_pat(
            bob_actor.clone(),
            CreatePat {
                ability_write: false,
                name: "read client".into(),
                scope: BearerScope::Read,
                selected_spaces: None,
                expires_at_ms: None,
                expected: bob_session.account.revision,
            },
        )
        .await
        .unwrap();
    let mut pat_evidence = evidence(AuthEvidenceKind::Pat, pat.value.token.expose());
    pat_evidence.evidence = pat_evidence
        .evidence
        .with_human_management()
        .with_ability_write();
    let pat_auth = service.resolve(pat_evidence).await.unwrap();
    assert_eq!(pat_auth.kind(), &PrincipalKind::Pat);
    assert!(!pat_auth.human_management());
    assert!(!pat_auth.has_cap(Cap::AbilityWrite));
    assert!(
        pat_auth
            .spaces()
            .values()
            .all(|space| space.write_classes.is_empty())
    );
    assert!(
        service
            .account(AccountContext::new(pat_auth, budget()), bob.id.clone())
            .await
            .is_err()
    );
    let listed = service
        .list_pats(
            bob_actor.clone(),
            bob.id.clone(),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, pat.value.metadata.id);
    fixture
        .revoker
        .entered
        .forget_permits(fixture.revoker.entered.available_permits());
    fixture.revoker.gate.store(true, Ordering::SeqCst);
    let request = AccountMutation {
        identity: command(&bob.id, &bob.id, 3, pat.revision),
        input: RevokePat {
            account: bob.id.clone(),
            token: pat.value.metadata.id.clone(),
        },
    };
    let worker = {
        let service = service.clone();
        let actor = bob_actor.clone();
        let request = request.clone();
        tokio::spawn(async move { service.revoke_pat(actor, request).await })
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.revoker.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    assert!(!worker.is_finished());
    denied(
        service
            .resolve(evidence(AuthEvidenceKind::Pat, pat.value.token.expose()))
            .await,
    );
    fixture.revoker.release.add_permits(1);
    let revoked = worker.await.unwrap().unwrap();
    fixture.revoker.gate.store(false, Ordering::SeqCst);
    let calls = fixture.revoker.calls.lock().unwrap().len();
    assert_eq!(
        service
            .revoke_pat(bob_actor.clone(), request.clone())
            .await
            .unwrap()
            .revision,
        revoked.revision
    );
    assert_eq!(fixture.revoker.calls.lock().unwrap().len(), calls);
    let mut altered = request;
    altered.input.token = notarium_core::ids::CredentialTokenId::parse("000000000001").unwrap();
    assert!(matches!(
        service.revoke_pat(bob_actor.clone(), altered).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    fixture.revoker.fail.store(true, Ordering::SeqCst);
    unknown(
        service
            .change_password(
                bob_actor.clone(),
                ChangePassword {
                    account: bob.id.clone(),
                    current: Some(secret("bob password")),
                    replacement: secret("replacement password"),
                    expected: revoked.revision,
                },
            )
            .await,
    );
    denied(
        service
            .resolve(evidence(
                AuthEvidenceKind::Session,
                bob_session.token.expose(),
            ))
            .await,
    );
    assert!(service.account(bob_actor, bob.id.clone()).await.is_err());
    assert!(fixture.service(AuthenticationMode::Password).await.is_err());
    assert!(
        fixture
            .observer
            .count("SELECT count(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await
            > 0
    );
    fixture.revoker.fail.store(false, Ordering::SeqCst);
    let restarted = fixture.service(AuthenticationMode::Password).await.unwrap();
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        0
    );
    let replacement = restarted
        .login(
            budget(),
            PasswordLogin {
                identifier: "bob".into(),
                password: secret("replacement password"),
            },
        )
        .await
        .unwrap();
    let disabled = restarted
        .set_disabled(
            actor.clone(),
            AccountMutation {
                identity: command(&admin.id, &bob.id, 4, replacement.account.revision),
                input: SetAccountDisabled {
                    account: bob.id.clone(),
                    disabled: true,
                },
            },
        )
        .await
        .unwrap();
    denied(
        restarted
            .resolve(evidence(
                AuthEvidenceKind::Session,
                replacement.token.expose(),
            ))
            .await,
    );
    denied(
        restarted
            .login(
                budget(),
                PasswordLogin {
                    identifier: "bob".into(),
                    password: secret("replacement password"),
                },
            )
            .await,
    );
    restarted
        .set_disabled(
            actor.clone(),
            AccountMutation {
                identity: command(&admin.id, &bob.id, 5, disabled.revision),
                input: SetAccountDisabled {
                    account: bob.id.clone(),
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    denied(
        restarted
            .resolve(evidence(
                AuthEvidenceKind::Session,
                replacement.token.expose(),
            ))
            .await,
    );
    let fresh = restarted
        .login(
            budget(),
            PasswordLogin {
                identifier: "bob".into(),
                password: secret("replacement password"),
            },
        )
        .await
        .unwrap();
    fixture.revoker.fail.store(true, Ordering::SeqCst);
    unknown(
        restarted
            .logout(evidence(AuthEvidenceKind::Session, fresh.token.expose()))
            .await,
    );
    denied(
        restarted
            .resolve(evidence(AuthEvidenceKind::Session, fresh.token.expose()))
            .await,
    );
    let event = fixture
        .revoker
        .calls
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    fixture.revoker.fail.store(false, Ordering::SeqCst);
    restarted
        .logout(evidence(AuthEvidenceKind::Session, fresh.token.expose()))
        .await
        .unwrap();
    assert_eq!(fixture.revoker.calls.lock().unwrap().last(), Some(&event));
    let none = fixture
        .service(AuthenticationMode::TrustedNone {
            owner: admin.id.clone(),
        })
        .await
        .unwrap();
    let none_auth = none
        .trusted_none(PerimeterAttestation::attest_checked(), budget())
        .await
        .unwrap();
    assert_eq!(none_auth.principal(), &admin.id);
    denied(
        none.resolve(evidence(AuthEvidenceKind::Session, "nts_invalid"))
            .await,
    );
    // A canonical failure after creation leaves one durable pending Space.
    fixture
        .catalog
        .fail_after_create
        .store(true, Ordering::SeqCst);
    let admin_current = restarted
        .account(actor.clone(), admin.id.clone())
        .await
        .unwrap();
    let creation = AccountMutation {
        identity: command(&admin.id, &admin.id, 6, admin_current.revision),
        input: NewAccount {
            username: "carol".into(),
            email: None,
            display_name: "Carol".into(),
        },
    };
    unknown(
        restarted
            .create_account(actor.clone(), creation.clone())
            .await,
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM space_admission WHERE state='pending'")
            .await,
        1
    );
    assert!(fixture.service(AuthenticationMode::Password).await.is_err());
    fixture
        .catalog
        .fail_after_create
        .store(false, Ordering::SeqCst);
    let recovered = fixture.service(AuthenticationMode::Password).await.unwrap();
    recovered.create_account(actor, creation).await.unwrap();
    assert_eq!(fixture.catalog.entries.lock().unwrap().len(), 3);
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM space_admission WHERE state='pending'")
            .await,
        0
    );
    let hash = fixture
        .observer
        .text("SELECT password_hash FROM users WHERE username='bob'")
        .await;
    assert!(hash.starts_with("$argon2id$"));
    drop((service, restarted, recovered, none));
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_auth_lifecycle_and_recovery() {
    lifecycle(false).await;
}
#[tokio::test]
async fn postgres_auth_lifecycle_and_recovery() {
    lifecycle(true).await;
}

async fn rbac(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "rbac").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(secret("owner password")),
            },
        )
        .await
        .unwrap();
    let owner = bootstrap.account;
    let owner_session = bootstrap.session.unwrap();
    let owner_ctx = account_context(&service, owner_session.token.expose()).await;
    let created = service
        .create_account(
            owner_ctx.clone(),
            AccountMutation {
                identity: command(&owner.id, &owner.id, 20, owner.revision),
                input: NewAccount {
                    username: "second".into(),
                    email: None,
                    display_name: "Second".into(),
                },
            },
        )
        .await
        .unwrap();
    let second = created.value;
    let invite = service
        .issue_one_time(
            owner_ctx.clone(),
            IssueOneTime {
                account: second.id.clone(),
                purpose: OneTimePurpose::Invite,
                expected: second.revision,
            },
        )
        .await
        .unwrap();
    let second_session = service
        .consume_one_time(
            budget(),
            ConsumeOneTime {
                token: invite.value.token,
                purpose: OneTimePurpose::Invite,
                password: secret("second password"),
            },
        )
        .await
        .unwrap();
    let shared = service
        .create_space(
            owner_ctx.clone(),
            AccountMutation {
                identity: command(&owner.id, &owner.id, 21, created.revision),
                input: CreateSpace {
                    id: SpaceId::from_bytes([21; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared".into(),
                },
            },
        )
        .await
        .unwrap();
    let owner_ctx = account_context(&service, owner_session.token.expose()).await;
    let owner_space = SpaceContext::new(
        owner_ctx.auth().clone(),
        shared.value.history.clone(),
        budget(),
    )
    .unwrap();
    assert!(
        service
            .change_membership(
                owner_space.clone(),
                MembershipChange {
                    command: CommandKey::from_bytes([22; 16]),
                    member: owner.id.clone(),
                    role: None,
                    expected: ControlRevision::ZERO
                }
            )
            .await
            .is_err()
    );
    let viewer = service
        .change_membership(
            owner_space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([23; 16]),
                member: second.id.clone(),
                role: Some(SpaceRole::Viewer),
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    let second_ctx = account_context(&service, second_session.token.expose()).await;
    let second_space = SpaceContext::new(
        second_ctx.auth().clone(),
        shared.value.history.clone(),
        budget(),
    )
    .unwrap();
    assert_eq!(
        second_ctx.auth().spaces()[&shared.value.space.id].role,
        SpaceRole::Viewer
    );
    assert!(
        second_ctx.auth().spaces()[&shared.value.space.id]
            .write_classes
            .is_empty()
    );
    assert!(
        service
            .change_membership(
                second_space,
                MembershipChange {
                    command: CommandKey::from_bytes([24; 16]),
                    member: second.id.clone(),
                    role: Some(SpaceRole::Owner),
                    expected: viewer.revision
                }
            )
            .await
            .is_err()
    );
    let personal = fixture.catalog.entries.lock().unwrap()[owner.personal_space.as_ref().unwrap()]
        .2
        .history
        .clone();
    let personal = SpaceContext::new(owner_ctx.auth().clone(), personal, budget()).unwrap();
    assert!(
        service
            .change_membership(
                personal,
                MembershipChange {
                    command: CommandKey::from_bytes([25; 16]),
                    member: second.id.clone(),
                    role: Some(SpaceRole::Viewer),
                    expected: ControlRevision::ZERO
                }
            )
            .await
            .is_err()
    );
    let promoted = service
        .change_membership(
            owner_space.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([26; 16]),
                member: second.id.clone(),
                role: Some(SpaceRole::Owner),
                expected: viewer.revision,
            },
        )
        .await
        .unwrap();
    // An old viewer context remains narrowed even after the account is promoted.
    let old_spaces = service
        .list_spaces(second_ctx, ControlPageRequest::new(200, None).unwrap())
        .await
        .unwrap();
    assert_eq!(
        old_spaces
            .items
            .iter()
            .find(|space| space.space.id == shared.value.space.id)
            .unwrap()
            .role,
        SpaceRole::Viewer
    );
    let second_ctx = account_context(&service, second_session.token.expose()).await;
    let second_space = SpaceContext::new(
        second_ctx.auth().clone(),
        shared.value.history.clone(),
        budget(),
    )
    .unwrap();
    let first_request = MembershipChange {
        command: CommandKey::from_bytes([27; 16]),
        member: owner.id.clone(),
        role: Some(SpaceRole::Viewer),
        expected: promoted.revision,
    };
    let second_request = MembershipChange {
        command: CommandKey::from_bytes([28; 16]),
        member: second.id.clone(),
        role: Some(SpaceRole::Viewer),
        expected: promoted.revision,
    };
    let (first_result, second_result) = tokio::join!(
        service.change_membership(owner_space, first_request),
        service.change_membership(second_space, second_request)
    );
    assert_ne!(
        first_result.is_ok(),
        second_result.is_ok(),
        "one of two owner removals must succeed"
    );
    let (remaining_session, revision) = if let Ok(changed) = first_result {
        (&second_session, changed.revision)
    } else {
        (&owner_session, second_result.unwrap().revision)
    };
    assert_eq!(fixture.observer.count("SELECT count(*) FROM space_members WHERE space_id='sp_15151515151515151515151515151515' AND role='owner'").await,1);
    let remaining = account_context(&service, remaining_session.token.expose()).await;
    let management = service
        .admit_space_management(remaining.clone(), shared.value.history.clone())
        .await
        .unwrap();
    fixture.revoker.fail.store(true, Ordering::SeqCst);
    let archive = SpaceLifecycleChange {
        command: CommandKey::from_bytes([29; 16]),
        lifecycle: SpaceLifecycle::Archived,
        expected: revision,
    };
    unknown(
        service
            .change_space_lifecycle(management, archive.clone())
            .await,
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM space_admission WHERE state='closing'")
            .await,
        1
    );
    let closing_auth = account_context(&service, remaining_session.token.expose()).await;
    assert!(
        !closing_auth
            .auth()
            .spaces()
            .contains_key(&shared.value.space.id)
    );
    fixture.revoker.fail.store(false, Ordering::SeqCst);
    fixture
        .catalog
        .fail_after_lifecycle
        .store(true, Ordering::SeqCst);
    assert!(fixture.service(AuthenticationMode::Password).await.is_err());
    assert_eq!(
        fixture.catalog.entries.lock().unwrap()[&shared.value.space.id]
            .2
            .space
            .lifecycle,
        SpaceLifecycle::Archived
    );
    fixture
        .catalog
        .fail_after_lifecycle
        .store(false, Ordering::SeqCst);
    let recovered = fixture.service(AuthenticationMode::Password).await.unwrap();
    let management = recovered
        .admit_space_management(closing_auth, shared.value.history.clone())
        .await
        .unwrap();
    assert!(
        management.auth().spaces()[&shared.value.space.id]
            .read_classes
            .is_empty()
    );
    let archived = recovered
        .change_space_lifecycle(management.clone(), archive)
        .await
        .unwrap();
    assert_eq!(archived.value.space.lifecycle, SpaceLifecycle::Archived);
    let active = recovered
        .change_space_lifecycle(
            management,
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([30; 16]),
                lifecycle: SpaceLifecycle::Active,
                expected: archived.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(active.value.space.lifecycle, SpaceLifecycle::Active);
    let fresh = account_context(&recovered, remaining_session.token.expose()).await;
    assert!(fresh.auth().spaces().contains_key(&shared.value.space.id));
    let mut old_history = shared.value.history;
    old_history.incarnation = HistoryIncarnation::from_bytes([99; 16]);
    assert!(
        recovered
            .admit_space_management(fresh, old_history)
            .await
            .is_err()
    );
    drop((service, recovered));
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_space_rbac_and_lifecycle() {
    rbac(false).await;
}
#[tokio::test]
async fn postgres_space_rbac_and_lifecycle() {
    rbac(true).await;
}

async fn bounds(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use notarium_control::auth::token::{TokenKind, mint};
    let mut fixture = Fixture::new(pg, "bounds").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "bounded".into(),
                email: None,
                display_name: "Bounded account".into(),
                password: Some(secret("bounded password")),
            },
        )
        .await
        .unwrap();
    let issued = bootstrap.session.unwrap();
    let original_expiry = issued.expires_at_ms;
    let current = account_context(&service, issued.token.expose()).await;
    fixture.clock.0.fetch_add(59 * 60 * 1000, Ordering::SeqCst);
    service
        .resolve(evidence(AuthEvidenceKind::Session, issued.token.expose()))
        .await
        .unwrap();
    assert_eq!(
        fixture
            .observer
            .count("SELECT max(expires_at) FROM sessions")
            .await,
        original_expiry
    );
    fixture.clock.0.fetch_add(60 * 1000, Ordering::SeqCst);
    service
        .resolve(evidence(AuthEvidenceKind::Session, issued.token.expose()))
        .await
        .unwrap();
    assert_eq!(
        fixture
            .observer
            .count("SELECT max(expires_at) FROM sessions")
            .await,
        original_expiry + 60 * 60 * 1000
    );
    let pat = service
        .create_pat(
            current.clone(),
            CreatePat {
                ability_write: true,
                name: "empty selection".into(),
                scope: BearerScope::Write,
                selected_spaces: Some(vec![]),
                expires_at_ms: Some(fixture.clock.0.load(Ordering::SeqCst) + 1000),
                expected: issued.account.revision,
            },
        )
        .await
        .unwrap();
    let auth = service
        .resolve(evidence(AuthEvidenceKind::Pat, pat.value.token.expose()))
        .await
        .unwrap();
    assert!(auth.spaces().is_empty());
    assert_eq!(auth.bearer_scope(), Some(BearerScope::Write));
    assert!(!auth.has_cap(Cap::AbilityWrite));
    fixture.clock.0.fetch_add(1000, Ordering::SeqCst);
    denied(
        service
            .resolve(evidence(AuthEvidenceKind::Pat, pat.value.token.expose()))
            .await,
    );
    denied(
        service
            .resolve(evidence(AuthEvidenceKind::Oidc, "eyJ.invalid.jwt"))
            .await,
    );
    let access = mint(TokenKind::Access).unwrap();
    fixture
        .observer
        .seed_oauth_access(&issued.account.id, &access)
        .await;
    let oauth = service
        .resolve(evidence(AuthEvidenceKind::OAuth, access.secret.expose()))
        .await
        .unwrap();
    assert!(matches!(oauth.kind(), PrincipalKind::OAuth { .. }));
    assert_eq!(oauth.bearer_scope(), Some(BearerScope::Read));
    assert!(!oauth.has_cap(Cap::AbilityWrite));
    assert!(
        oauth
            .spaces()
            .values()
            .all(|space| space.write_classes.is_empty())
    );
    let delegated = oauth
        .for_agent_run(
            AgentRunId::from_bytes([1; 16]),
            issued.account.personal_space.clone().unwrap(),
            ChatAudience::Personal,
            oauth.spaces().clone(),
        )
        .unwrap();
    service
        .whoami(AccountContext::new(delegated.clone(), budget()))
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE oauth_refresh_families SET revoked_at=1700000000000")
        .await;
    denied(
        service
            .resolve(evidence(AuthEvidenceKind::OAuth, access.secret.expose()))
            .await,
    );
    denied(
        service
            .whoami(AccountContext::new(delegated, budget()))
            .await,
    );
    let mut key = [0; 32];
    scrypt::scrypt(
        b"bounded password",
        &[2; 16],
        &scrypt::Params::new(17, 8, 1).unwrap(),
        &mut key,
    )
    .unwrap();
    let native = format!(
        "scrypt:17:8:1:{}:{}",
        STANDARD.encode([2; 16]),
        STANDARD.encode(key)
    );
    fixture
        .observer
        .set_password_hash(&issued.account.id, &native)
        .await;
    denied(
        service
            .login(
                budget(),
                PasswordLogin {
                    identifier: "bounded".into(),
                    password: secret("wrong"),
                },
            )
            .await,
    );
    assert_eq!(
        fixture
            .observer
            .text("SELECT password_hash FROM users")
            .await,
        native
    );
    let migrated = service
        .login(
            budget(),
            PasswordLogin {
                identifier: "bounded".into(),
                password: secret("bounded password"),
            },
        )
        .await
        .unwrap();
    assert!(
        fixture
            .observer
            .text("SELECT password_hash FROM users")
            .await
            .starts_with("$argon2id$")
    );
    // Automatic rehash does not invalidate an already admitted native session.
    service
        .resolve(evidence(AuthEvidenceKind::Session, issued.token.expose()))
        .await
        .unwrap();
    fixture
        .clock
        .0
        .fetch_add(31 * 24 * 60 * 60 * 1000, Ordering::SeqCst);
    denied(
        service
            .resolve(evidence(AuthEvidenceKind::Session, migrated.token.expose()))
            .await,
    );
    denied(service.account(current, issued.account.id).await);
    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_auth_expiry_lineage_and_native_rehash() {
    bounds(false).await;
}
#[tokio::test]
async fn postgres_auth_expiry_lineage_and_native_rehash() {
    bounds(true).await;
}

async fn second_account(
    service: &notarium_control::service::ControlService,
    actor: AccountContext,
    admin: &AccountInfo,
) -> (IssuedSession, ControlRevision) {
    let created = service
        .create_account(
            actor.clone(),
            AccountMutation {
                identity: command(&admin.id, &admin.id, 70, admin.revision),
                input: NewAccount {
                    username: "second".into(),
                    email: None,
                    display_name: "Second".into(),
                },
            },
        )
        .await
        .unwrap();
    let invite = service
        .issue_one_time(
            actor,
            IssueOneTime {
                account: created.value.id,
                purpose: OneTimePurpose::Invite,
                expected: created.value.revision,
            },
        )
        .await
        .unwrap();
    let session = service
        .consume_one_time(
            budget(),
            ConsumeOneTime {
                token: invite.value.token,
                purpose: OneTimePurpose::Invite,
                password: secret("second password"),
            },
        )
        .await
        .unwrap();
    (session, created.revision)
}

async fn committed_recovery(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "committed_recovery").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(secret("owner password")),
            },
        )
        .await
        .unwrap();
    let owner = bootstrap.account;
    let session = bootstrap.session.unwrap();
    let actor = account_context(&service, session.token.expose()).await;
    let (second, revision) = second_account(&service, actor.clone(), &owner).await;
    let shared = service
        .create_space(
            actor,
            AccountMutation {
                identity: command(&owner.id, &owner.id, 71, revision),
                input: CreateSpace {
                    id: SpaceId::from_bytes([71; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared".into(),
                },
            },
        )
        .await
        .unwrap();
    let actor = account_context(&service, session.token.expose()).await;
    let scope = shared.value.history.clone();
    let context = SpaceContext::new(actor.auth().clone(), scope.clone(), budget()).unwrap();
    let promoted = service
        .change_membership(
            context.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([72; 16]),
                member: second.account.id.clone(),
                role: Some(SpaceRole::Owner),
                expected: ControlRevision::ZERO,
            },
        )
        .await
        .unwrap();
    let removal = MembershipChange {
        command: CommandKey::from_bytes([73; 16]),
        member: owner.id.clone(),
        role: None,
        expected: promoted.revision,
    };
    fixture.revoker.fail.store(true, Ordering::SeqCst);
    unknown(service.change_membership(context, removal.clone()).await);
    drop(actor);
    // A new request has no old SpaceContext and no membership in its fresh grants.
    let actor = account_context(&service, session.token.expose()).await;
    assert!(!actor.auth().spaces().contains_key(&scope.space_id));
    assert!(SpaceContext::new(actor.auth().clone(), scope.clone(), budget()).is_err());
    assert!(
        service
            .admit_space_management(actor.clone(), scope.clone())
            .await
            .is_err()
    );
    unknown(
        service
            .resume_membership_change(actor.clone(), scope.clone(), removal.clone())
            .await,
    );
    for changed in [
        MembershipChange {
            role: Some(SpaceRole::Owner),
            ..removal.clone()
        },
        MembershipChange {
            expected: ControlRevision::ZERO,
            ..removal.clone()
        },
        MembershipChange {
            member: second.account.id.clone(),
            ..removal.clone()
        },
    ] {
        assert!(matches!(
            service
                .resume_membership_change(actor.clone(), scope.clone(), changed)
                .await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
    }
    let mut changed_scope = scope.clone();
    changed_scope.incarnation = HistoryIncarnation::from_bytes([99; 16]);
    assert!(matches!(
        service
            .resume_membership_change(actor.clone(), changed_scope, removal.clone())
            .await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    assert!(matches!(
        service
            .resume_membership_change(
                actor.clone(),
                scope.clone(),
                MembershipChange {
                    command: CommandKey::from_bytes([74; 16]),
                    ..removal.clone()
                }
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let other = account_context(&service, second.token.expose()).await;
    assert!(matches!(
        service
            .resume_membership_change(other, scope.clone(), removal.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let pending_event = fixture
        .revoker
        .calls
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    fixture.revoker.fail.store(false, Ordering::SeqCst);
    fixture.revoker.gate.store(true, Ordering::SeqCst);
    fixture
        .revoker
        .entered
        .forget_permits(fixture.revoker.entered.available_permits());
    let task = {
        let service = service.clone();
        let (actor, scope, removal) = (actor.clone(), scope.clone(), removal.clone());
        tokio::spawn(async move {
            service
                .resume_membership_change(actor, scope, removal)
                .await
        })
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.revoker.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    assert!(
        !task.is_finished(),
        "replay must wait for revocation acknowledgement"
    );
    assert_eq!(
        fixture.revoker.calls.lock().unwrap().last(),
        Some(&pending_event)
    );
    fixture.revoker.release.add_permits(1);
    let resumed = task.await.unwrap().unwrap();
    fixture.revoker.gate.store(false, Ordering::SeqCst);
    assert_eq!(resumed.value.role, None);
    assert_eq!(resumed.value.member, owner.id);
    assert_eq!(resumed.value.space, scope.space_id);
    let calls = fixture.revoker.calls.lock().unwrap().len();
    assert_eq!(
        service
            .resume_membership_change(actor.clone(), scope, removal)
            .await
            .unwrap()
            .revision,
        resumed.revision
    );
    assert_eq!(fixture.revoker.calls.lock().unwrap().len(), calls);
    assert_eq!(fixture.observer.count("SELECT count(*) FROM space_members WHERE space_id='sp_47474747474747474747474747474747'").await, 1);
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        0
    );

    // Creation and its exact replay use the committed receipt, even if a later
    // catalog read would fail or report inconsistent metadata.
    let mut revision = shared.revision;
    for fault in 1..=3 {
        fixture
            .catalog
            .space_read_fault
            .store(fault, Ordering::SeqCst);
        let reads = fixture.catalog.space_reads.load(Ordering::SeqCst);
        let key = 74 + fault;
        let request = AccountMutation {
            identity: command(&owner.id, &owner.id, key, revision),
            input: CreateSpace {
                id: SpaceId::from_bytes([key; 16]),
                kind: SpaceKind::Shared,
                name: format!("Receipt {fault}"),
            },
        };
        let created = service
            .create_space(actor.clone(), request.clone())
            .await
            .unwrap();
        let replay = service.create_space(actor.clone(), request).await.unwrap();
        assert_eq!(replay.value.space, created.value.space);
        assert_eq!(replay.value.history, created.value.history);
        assert_eq!(replay.revision, created.revision);
        assert_eq!(fixture.catalog.space_reads.load(Ordering::SeqCst), reads);
        revision = created.revision;
    }
    assert_eq!(fixture.catalog.entries.lock().unwrap().len(), 6);
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM space_admission")
            .await,
        6
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM control_operations WHERE state='committed'")
            .await,
        6
    );
    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_committed_space_recovery() {
    committed_recovery(false).await;
}
#[tokio::test]
async fn postgres_committed_space_recovery() {
    committed_recovery(true).await;
}

async fn bootstrap_revocation(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    for disable_cycle in [false, true] {
        let mut fixture = Fixture::new(
            pg,
            if disable_cycle {
                "bootstrap_disable"
            } else {
                "bootstrap_password"
            },
        )
        .await;
        let service = fixture.service(AuthenticationMode::Password).await.unwrap();
        fixture
            .catalog
            .create_gate
            .enabled
            .store(true, Ordering::SeqCst);
        let task = {
            let service = service.clone();
            tokio::spawn(async move {
                let mut long_budget = budget();
                long_budget.remaining = std::time::Duration::from_secs(120);
                service
                    .bootstrap(
                        empty(),
                        long_budget,
                        BootstrapAccount {
                            username: "admin".into(),
                            email: None,
                            display_name: "Administrator".into(),
                            password: Some(secret("original password")),
                        },
                    )
                    .await
            })
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            fixture.catalog.create_gate.entered.acquire(),
        )
        .await
        .unwrap()
        .unwrap()
        .forget();
        let original = service
            .login(
                budget(),
                PasswordLogin {
                    identifier: "admin".into(),
                    password: secret("original password"),
                },
            )
            .await
            .unwrap();
        let actor = account_context(&service, original.token.expose()).await;
        assert!(actor.auth().spaces().is_empty());
        if disable_cycle {
            let (second, revision) = second_account(&service, actor, &original.account).await;
            // Seed a second administrator in the composition fixture; the
            // revocations themselves use the real public account commands.
            fixture
                .observer
                .execute("UPDATE users SET is_admin=1 WHERE username='second'")
                .await;
            let other = account_context(&service, second.token.expose()).await;
            let disabled = service
                .set_disabled(
                    other.clone(),
                    AccountMutation {
                        identity: command(&second.account.id, &original.account.id, 80, revision),
                        input: SetAccountDisabled {
                            account: original.account.id.clone(),
                            disabled: true,
                        },
                    },
                )
                .await
                .unwrap();
            service
                .set_disabled(
                    other,
                    AccountMutation {
                        identity: command(
                            &second.account.id,
                            &original.account.id,
                            81,
                            disabled.revision,
                        ),
                        input: SetAccountDisabled {
                            account: original.account.id.clone(),
                            disabled: false,
                        },
                    },
                )
                .await
                .unwrap();
        } else {
            service
                .change_password(
                    actor,
                    ChangePassword {
                        account: original.account.id.clone(),
                        current: Some(secret("original password")),
                        replacement: secret("replacement password"),
                        expected: original.account.revision,
                    },
                )
                .await
                .unwrap();
        }
        denied(
            service
                .resolve(evidence(AuthEvidenceKind::Session, original.token.expose()))
                .await,
        );
        assert_eq!(fixture.observer.count("SELECT count(*) FROM sessions s JOIN users u ON u.user_id=s.user_id WHERE u.username='admin' AND s.revoked_at IS NULL").await, 0);
        assert!(!task.is_finished());
        fixture.catalog.create_gate.release.add_permits(1);
        unknown(task.await.unwrap());
        assert_eq!(fixture.observer.count("SELECT count(*) FROM sessions s JOIN users u ON u.user_id=s.user_id WHERE u.username='admin' AND s.revoked_at IS NULL").await, 0);
        assert_eq!(
            fixture
                .observer
                .count("SELECT count(*) FROM revocation_events WHERE delivered_at IS NULL")
                .await,
            0
        );
        assert_eq!(
            fixture
                .observer
                .count("SELECT count(*) FROM space_admission WHERE state='pending'")
                .await,
            0
        );
        service
            .login(
                budget(),
                PasswordLogin {
                    identifier: "admin".into(),
                    password: secret(if disable_cycle {
                        "original password"
                    } else {
                        "replacement password"
                    }),
                },
            )
            .await
            .unwrap();
        drop(service);
        fixture.close().await;
    }
}
#[tokio::test]
async fn sqlite_bootstrap_concurrent_revocation() {
    bootstrap_revocation(false).await;
}
#[tokio::test]
async fn postgres_bootstrap_concurrent_revocation() {
    bootstrap_revocation(true).await;
}

async fn interactive_management_and_account_guards(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "auth_management_guards").await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(secret("management fixture password")),
            },
        )
        .await
        .unwrap();
    let owner = boot.account.id.clone();
    let personal_id = boot.account.personal_space.clone().unwrap();
    let token = boot.session.unwrap().token;

    // Ambient sessions (`human_management = false`) can read identity, cannot perform management
    // mutations or logout, and never mint `Cap::AbilityWrite` without `human_management`.
    let ambient_ctx = AccountContext::new(
        control
            .resolve(unconfirmed_evidence(
                AuthEvidenceKind::Session,
                token.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    control.whoami(ambient_ctx.clone()).await.unwrap();
    let ambient_with_ability_flag = control
        .resolve(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(AuthEvidenceKind::Session, token.expose().into())
                .with_ability_write(),
        })
        .await
        .unwrap();
    assert!(!ambient_with_ability_flag.human_management());
    assert!(
        !ambient_with_ability_flag.has_cap(Cap::AbilityWrite),
        "Cap::AbilityWrite must never be granted without human_management"
    );
    assert!(matches!(
        control
            .logout(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Session, token.expose().into()),
            })
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .create_space(
                ambient_ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 1, boot.account.revision),
                    input: CreateSpace {
                        id: SpaceId::from_bytes([21; 16]),
                        kind: SpaceKind::Shared,
                        name: "Blocked".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .create_pat(
                ambient_ctx.clone(),
                CreatePat {
                    ability_write: false,
                    name: "Blocked".into(),
                    scope: BearerScope::Read,
                    selected_spaces: None,
                    expires_at_ms: None,
                    expected: boot.account.revision,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // Interactive human session (`human_management = true`, `ability_write = false`).
    let mgmt_ctx = account_context(&control, token.expose()).await;
    let shared = control
        .create_space(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: command(
                    &owner,
                    &owner,
                    2,
                    control
                        .account(mgmt_ctx.clone(), owner.clone())
                        .await
                        .unwrap()
                        .revision,
                ),
                input: CreateSpace {
                    id: SpaceId::from_bytes([22; 16]),
                    kind: SpaceKind::Shared,
                    name: "Team".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let mgmt_ctx = account_context(&control, token.expose()).await;

    let project_ok = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([23; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project_ok.space_id.clone(), project_ok.folder_id.clone()),
        ProjectInfo {
            project_slug: "project".into(),
            folder: project_ok.clone(),
            name: "Allowed project".into(),
        },
    );
    fixture.catalog.folder_entries.lock().unwrap().insert(
        (project_ok.space_id.clone(), project_ok.folder_id.clone()),
        CatalogFolder {
            reference: project_ok.clone(),
            space: shared.space.clone(),
            lifecycle: Lifecycle::Active,
            ancestor_folders: vec![],
            write_locked: false,
        },
    );

    let ability_ref = AbilityRef {
        id: AbilityId::from_bytes([25; 16]),
        placement: AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        revision: RevisionId::from_bytes([1; 16]),
    };
    let ability_note = NoteRef {
        space_id: shared.space.id.clone(),
        note_id: NoteId::from_bytes([26; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: ability_ref.clone(),
            kind: AbilityKind::Role,
            name: "selected-guide".into(),
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: Some(ability_note.clone()),
            auxiliary_files: vec![],
        });
    fixture.catalog.note_entries.lock().unwrap().insert(
        (shared.space.id.clone(), ability_note.note_id.clone()),
        CatalogNote {
            reference: ability_note,
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: shared.space,
                class: DocClass::Skill,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: Some(ability_ref.id.clone()),
            },
        },
    );

    let rev = control
        .account(mgmt_ctx.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    control
        .set_favorite(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: command(&owner, &owner, 3, rev),
                input: SetFavorite {
                    reference: FavoriteRef::Folder(project_ok.clone()),
                    saved: true,
                    rank: 1,
                },
            },
        )
        .await
        .unwrap();
    let rev = control
        .account(mgmt_ctx.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    assert!(matches!(
        control
            .set_favorite(
                ambient_ctx,
                AccountMutation {
                    identity: command(&owner, &owner, 4, rev),
                    input: SetFavorite {
                        reference: FavoriteRef::Folder(project_ok.clone()),
                        saved: false,
                        rank: 1,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .update_ability_binding(
                mgmt_ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 5, rev),
                    input: AbilityBindingUpdate {
                        ability: ability_ref,
                        enabled: true,
                        expected: ControlRevision::ZERO,
                        projects: AbilityProjects::Selected(vec![project_ok]),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));

    // Personal Space cannot be archived; malformed email and duplicate username return typed validation errors.
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
    let personal_ctx =
        SpaceContext::new(mgmt_ctx.auth().clone(), personal_history, budget()).unwrap();
    assert!(matches!(
        control
            .change_space_lifecycle(
                personal_ctx,
                SpaceLifecycleChange {
                    command: CommandKey::from_bytes([41; 16]),
                    lifecycle: SpaceLifecycle::Archived,
                    expected: ControlRevision::ZERO,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .create_account(
                mgmt_ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 42, rev),
                    input: NewAccount {
                        username: "alice".into(),
                        email: Some("invalid-email-without-at".into()),
                        display_name: "Alice".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed {
            diagnostic: Diagnostic {
                reason: ValidationReason::InvalidQuery,
                ..
            }
        }))
    ));
    assert!(matches!(
        control
            .create_account(
                mgmt_ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 43, rev),
                    input: NewAccount {
                        username: "owner".into(),
                        email: None,
                        display_name: "Duplicate".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed {
            diagnostic: Diagnostic {
                reason: ValidationReason::DuplicateKey,
                ..
            }
        }))
    ));

    control
        .logout(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();

    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_interactive_management_attestation_and_account_guards() {
    interactive_management_and_account_guards(false).await;
}
#[tokio::test]
async fn postgres_interactive_management_attestation_and_account_guards() {
    interactive_management_and_account_guards(true).await;
}

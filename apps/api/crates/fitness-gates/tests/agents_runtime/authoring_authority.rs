use super::*;
use notarium_agents::chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot};
use notarium_control::auth::token::{MintedToken, TokenKind, mint};
use notarium_core::{
    auth::{AuthenticatedCredential, ChatAudience},
    classes::DocClass,
    model::HistoryScope,
};
use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{sync::oneshot, time::timeout};

pub(super) async fn bump_account_after_publication<T>(
    fixture: &RuntimeFixture,
    operation: impl Future<Output = T>,
) -> T {
    let (entered, release) = fixture.projections.pause_ability_publication();
    let bump = async {
        timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        fixture.pat(BearerScope::Read, false).await;
        release.send(()).unwrap();
    };
    tokio::join!(operation, bump).0
}

pub(super) async fn revoke_before_effect<T, R>(
    gate: (oneshot::Receiver<Cancellation>, oneshot::Sender<()>),
    mutation: impl Future<Output = Result<T, PortError>>,
    revocation: impl Future<Output = Result<R, PortError>>,
) -> PortError {
    let (entered, release) = gate;
    let revoke = async {
        let cancellation = entered
            .await
            .expect("the operation reached its Canonical admission gate");
        revocation.await.unwrap();
        assert!(cancellation.is_cancelled());
        release.send(()).unwrap();
    };
    let (result, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(mutation, revoke)
    })
    .await
    .expect("revocation and canonical effect settled");
    result.err().expect("the revoked effect must fail")
}

async fn revoke_while_writer_pinned<T, R>(
    fixture: &RuntimeFixture,
    space: &SpaceId,
    gate: (oneshot::Receiver<Cancellation>, oneshot::Sender<()>),
    mutation: impl Future<Output = Result<T, PortError>>,
    revocation: impl Future<Output = Result<R, PortError>>,
) -> PortError {
    let pin_auth = fixture
        .control
        .trusted_none(
            PerimeterAttestation::attest_checked().with_human_management(),
            budget(),
        )
        .await
        .unwrap();
    let pinned = fixture
        .canonical
        .pin_schedule_abilities(
            AccountContext::new(pin_auth.restrict_to_space(space).unwrap(), budget()),
            Vec::new(),
        )
        .await
        .unwrap();
    let (entered, release) = gate;
    let revoke = async {
        let _ = entered
            .await
            .expect("the queued operation reached its Canonical admission gate");
        release.send(()).unwrap();
        // Give the admitted operation time to queue behind the pinned SQL writer.
        tokio::time::sleep(Duration::from_millis(40)).await;
        // The SQL actor cannot obtain the pinned writer. A synchronous revoke
        // must still settle while that Canonical lock is held.
        revocation.await.unwrap();
        drop(pinned);
    };
    let (result, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(mutation, revoke)
    })
    .await
    .expect("revocation must settle before the writer pin is released");
    result.err().expect("the revoked queued writer must fail")
}

async fn revoke_during_active_sql<T, R>(
    fixture: &RuntimeFixture,
    mutation: impl Future<Output = Result<T, PortError>>,
    revocation: impl Future<Output = Result<R, PortError>>,
) -> PortError {
    // Pause inside the WriteBatchActor SQL transaction right after the active
    // authority lease is acquired.
    let (entered, release) = fixture.projections.pause_active_sql_effect();
    let revoke = async {
        let cancellation = entered
            .await
            .expect("the operation entered its active SQL transaction");
        tokio::pin!(revocation);
        tokio::select! {
            () = cancellation.cancelled() => (),
            _ = &mut revocation => panic!("revocation returned while the active SQL transaction was still held"),
        }
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(50)) => (),
            _ = &mut revocation => panic!("revocation must wait until the active SQL transaction settles"),
        }
        release.send(()).unwrap();
        revocation.await.unwrap();
    };
    let (result, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(mutation, revoke)
    })
    .await
    .expect("active SQL transaction and revocation must settle");
    result
        .err()
        .expect("the revoked active SQL write must fail")
}

pub(super) async fn native_session(
    fixture: &mut RuntimeFixture,
    tag: u8,
) -> (AccountContext, MintedToken) {
    static SESSION_NONCE: AtomicU64 = AtomicU64::new(1);
    let mut bytes = [tag; 16];
    let nonce = SESSION_NONCE.fetch_add(1, Ordering::Relaxed).to_be_bytes();
    bytes[8..16].copy_from_slice(&nonce);
    let token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            fixture.human.auth().principal(),
            &AuthSessionId::from_bytes(bytes),
            &token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let auth = fixture
        .control
        .resolve(support::evidence(
            AuthEvidenceKind::Session,
            token.secret.expose(),
        ))
        .await
        .unwrap();
    (AccountContext::new(auth, budget()), token)
}

async fn revoked_chat_receipt(fixture: &mut RuntimeFixture, personal: &HistoryScope) {
    let (account, token) = native_session(fixture, 196).await;
    let scope = SpaceContext::new(account.auth().clone(), personal.clone(), budget()).unwrap();
    let thread = ChatThreadId::from_bytes([196; 16]);
    let command = |tag| CommandIdentity {
        scope: personal.clone(),
        actor: account.auth().principal().clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    fixture
        .canonical
        .create_chat(
            scope.clone(),
            Mutation {
                identity: command(196),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    owner: account.auth().principal().clone(),
                    kind: ChatThreadKind::Personal,
                    title: "Receipt authority fixture".into(),
                    project_folder: None,
                },
            },
        )
        .await
        .unwrap();
    let input = SubmitUserChatInput {
        identity: command(197),
        id: PendingInputId::from_bytes([197; 16]),
        thread: thread.clone(),
        expected_leaf: ThreadEntrySeq::ZERO,
        body: "Previously committed chat entry".into(),
        mentions_agent: false,
    };
    assert!(matches!(
        fixture
            .canonical
            .submit_user_chat_input(scope, input.clone())
            .await
            .unwrap(),
        SubmitUserChatOutcome::Appended(_)
    ));
    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let before = fixture
        .canonical
        .read_space(&personal.space_id)
        .await
        .unwrap()
        .last_seq;
    let denied = revoke_before_effect(
        fixture.projections.pause_chat_lookup(),
        supervisor.enqueue_input(account, input, ChatRunOptions::default()),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            token.secret.expose(),
        )),
    )
    .await;
    assert!(matches!(denied, PortError::Cancelled(_)), "{denied:?}");
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
    // Redaction (pre-SQL, active SQL, and post-commit replay) must fail closed
    // under synchronous logout without mutating the thread.
    let principal = fixture.human.auth().principal().clone();
    let reader =
        SpaceContext::new(fixture.human.auth().clone(), personal.clone(), budget()).unwrap();
    let live_branch = fixture
        .canonical
        .read_chat_context(
            reader.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: ThreadEntrySeq::ZERO,
                before: None,
                max_entries: PageLimit::new(4).unwrap(),
            },
        )
        .await
        .unwrap();
    let entry_seq = live_branch.thread.head;
    let redact_request = |tag: u8| Mutation {
        identity: CommandIdentity {
            scope: personal.clone(),
            actor: principal.clone(),
            key: CommandKey::from_bytes([tag; 16]),
            hash: ContentDigest::from_bytes([tag; 32]),
        },
        preconditions: Preconditions::default(),
        input: RedactChatEntry {
            thread: thread.clone(),
            entry: entry_seq,
            expected_thread_revision: live_branch.thread.revision.clone(),
        },
    };
    let (redact_account, redact_token) = native_session(fixture, 201).await;
    let denied_redact = revoke_before_effect(
        fixture.projections.pause_chat_redaction(),
        supervisor.redact_chat_entry(redact_account, redact_request(201)),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            redact_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(denied_redact, PortError::Cancelled(_)),
        "{denied_redact:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
    let (active_account, active_token) = native_session(fixture, 202).await;
    let active_denied = revoke_during_active_sql(
        fixture,
        supervisor.redact_chat_entry(active_account, redact_request(202)),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            active_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(active_denied, PortError::Cancelled(_))
            || matches!(&active_denied, PortError::Unavailable(failure)
                if failure.effect() == notarium_core::error::CommitEffect::Unknown),
        "{active_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
    // Read-only PAT and read-only OAuth bearer tokens must be rejected by
    // chat redaction, run cancellation, Control fencing, and direct Canonical
    // writes even when the underlying account owns the Space.
    let read_pat = fixture.pat(BearerScope::Read, false).await;
    let oauth_access = mint(TokenKind::Access).unwrap();
    fixture
        .storage
        .observer
        .seed_oauth_access(&principal, &oauth_access)
        .await;
    let read_oauth = AccountContext::new(
        fixture
            .control
            .resolve(support::evidence(
                AuthEvidenceKind::OAuth,
                oauth_access.secret.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    assert_eq!(read_oauth.auth().bearer_scope(), Some(BearerScope::Read));
    for (tag, bearer) in [(205_u8, read_pat), (206_u8, read_oauth)] {
        assert!(matches!(
            supervisor
                .redact_chat_entry(bearer.clone(), redact_request(tag))
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert!(matches!(
            supervisor
                .stop(
                    bearer.clone(),
                    personal.clone(),
                    thread.clone(),
                    AgentRunId::from_bytes([tag; 16]),
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        let bearer_scope =
            SpaceContext::new(bearer.auth().clone(), personal.clone(), budget()).unwrap();
        assert!(matches!(
            fixture
                .control_plane
                .fence_canonical_effect(
                    bearer.auth().clone(),
                    bearer_scope.clone(),
                    CanonicalEffect::ChatRedaction,
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert!(matches!(
            fixture
                .canonical
                .redact_chat_entry(bearer_scope, redact_request(tag))
                .await,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ));
    }
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
    let committed_redact = redact_request(203);
    supervisor
        .redact_chat_entry(fixture.human.clone(), committed_redact.clone())
        .await
        .unwrap();
    let after_redact = fixture
        .canonical
        .read_space(&personal.space_id)
        .await
        .unwrap()
        .last_seq;
    assert!(after_redact > before);
    let (replay_account, replay_token) = native_session(fixture, 204).await;
    let replay_denied = revoke_before_effect(
        fixture.projections.pause_chat_redaction(),
        supervisor.redact_chat_entry(replay_account, committed_redact),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            replay_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(replay_denied, PortError::Cancelled(_)),
        "{replay_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        after_redact
    );
}

pub(super) async fn revoked_rollback(
    fixture: &mut RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    scope: &HistoryScope,
    run: &AgentRunId,
    replay_key: &CommandKey,
) {
    let before = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    for (tag, key) in [
        (198, CommandKey::from_bytes([198; 16])),
        (199, replay_key.clone()),
    ] {
        let (account, token) = native_session(fixture, tag).await;
        let denied = revoke_before_effect(
            fixture.projections.pause_chat_rollback(),
            supervisor.rollback_run(account, scope.clone(), run.clone(), key),
            fixture.control.logout(support::evidence(
                AuthEvidenceKind::Session,
                token.secret.expose(),
            )),
        )
        .await;
        assert!(matches!(denied, PortError::Cancelled(_)), "{denied:?}");
        assert_eq!(
            fixture
                .canonical
                .read_space(&scope.space_id)
                .await
                .unwrap()
                .last_seq,
            before
        );
    }
    // Queued rollback waiting behind a pinned Canonical Space lock must allow
    // synchronous logout to settle without deadlock and fail closed.
    let (pinned_account, pinned_token) = native_session(fixture, 207).await;
    let pinned_denied = revoke_while_writer_pinned(
        fixture,
        &scope.space_id,
        fixture.projections.pause_chat_rollback(),
        supervisor.rollback_run(
            pinned_account,
            scope.clone(),
            run.clone(),
            CommandKey::from_bytes([207; 16]),
        ),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            pinned_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(pinned_denied, PortError::Cancelled(_))
            || matches!(&pinned_denied, PortError::Unavailable(failure)
                if failure.effect() == notarium_core::error::CommitEffect::Unknown),
        "{pinned_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
    // Active-SQL rollback retains its authority lease through revocation and
    // rolls back cleanly with zero sequence advance.
    let (active_account, active_token) = native_session(fixture, 200).await;
    let active_denied = revoke_during_active_sql(
        fixture,
        supervisor.rollback_run(
            active_account,
            scope.clone(),
            run.clone(),
            CommandKey::from_bytes([200; 16]),
        ),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            active_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(active_denied, PortError::Cancelled(_))
            || matches!(&active_denied, PortError::Unavailable(failure)
                if failure.effect() == notarium_core::error::CommitEffect::Unknown),
        "{active_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq,
        before
    );
}

async fn check(pg: bool) {
    let mut fixture = RuntimeFixture::open_named(pg, "agents_authoring_authority").await;
    let owner = &fixture.human;
    let principal = owner.auth().principal();
    let space_id = fixture
        .control
        .whoami(owner.clone())
        .await
        .unwrap()
        .personal_space
        .unwrap();
    for (key, replay) in [(181, false), (183, true)] {
        let created = call(&fixture, owner, key, "create_ability", json!({
            "kind":"role", "name":format!("authoring-fixture-{key}"), "description":"Runtime role",
            "instructions":"Use the recorded procedure.", "placement":{"home":"personal"},
        })).await.unwrap();
        let input = json!({"ref":created.structured_content["ref"]});
        let author = fixture.pat(BearerScope::Write, true).await;
        if replay {
            call(&fixture, &author, key + 1, "delete_ability", input.clone())
                .await
                .unwrap();
        }
        let Some(AuthenticatedCredential::Pat(token)) = author.auth().credential() else {
            panic!("expected an opt-in PAT");
        };
        let before = fixture
            .canonical
            .read_space(&space_id)
            .await
            .unwrap()
            .last_seq;
        let revocation = AccountMutation {
            identity: runtime_ability_cases::identity(&fixture, owner, key + 1).await,
            input: RevokePat {
                account: principal.clone(),
                token: token.clone(),
            },
        };
        let mutation = call(&fixture, &author, key + 1, "delete_ability", input.clone());
        let revocation = fixture.control.revoke_pat(owner.clone(), revocation);
        let pinned_writer = !replay;
        let denied = if pinned_writer {
            revoke_while_writer_pinned(
                &fixture,
                &space_id,
                fixture.projections.pause_ability_trash(),
                mutation,
                revocation,
            )
            .await
        } else {
            revoke_before_effect(
                fixture.projections.pause_ability_trash(),
                mutation,
                revocation,
            )
            .await
        };
        assert!(
            matches!(denied, PortError::Cancelled(_))
                || pinned_writer
                    && matches!(&denied, PortError::Unavailable(failure)
                    if failure.effect() == notarium_core::error::CommitEffect::Unknown),
            "{denied:?}"
        );
        assert_eq!(
            fixture
                .canonical
                .read_space(&space_id)
                .await
                .unwrap()
                .last_seq,
            before
        );
        assert!(matches!(
            call(&fixture, &author, key + 1, "delete_ability", input.clone()).await,
            Err(PortError::Domain(DomainError::AuthenticationFailed))
        ));
        if pinned_writer {
            // Now verify the complementary half: once a transaction has already
            // entered SQL, revocation waits for its settlement and rolls it back.
            let active_author = fixture.pat(BearerScope::Write, true).await;
            let Some(AuthenticatedCredential::Pat(active_token)) =
                active_author.auth().credential()
            else {
                panic!("expected an opt-in PAT");
            };
            let active_revocation = AccountMutation {
                identity: runtime_ability_cases::identity(&fixture, owner, 187).await,
                input: RevokePat {
                    account: principal.clone(),
                    token: active_token.clone(),
                },
            };
            let active_denied = revoke_during_active_sql(
                &fixture,
                call(
                    &fixture,
                    &active_author,
                    188,
                    "delete_ability",
                    input.clone(),
                ),
                fixture.control.revoke_pat(owner.clone(), active_revocation),
            )
            .await;
            assert!(
                matches!(active_denied, PortError::Cancelled(_))
                    || matches!(&active_denied, PortError::Unavailable(failure)
                        if failure.effect() == notarium_core::error::CommitEffect::Unknown),
                "{active_denied:?}"
            );
            assert_eq!(
                fixture
                    .canonical
                    .read_space(&space_id)
                    .await
                    .unwrap()
                    .last_seq,
                before
            );
            // The same writer processes this new authorized command after the
            // queued and active revoked commands. It can trash the live package once.
            call(&fixture, owner, 186, "delete_ability", input)
                .await
                .unwrap();
        }
    }
    // Exact replay of an ability carrier edit (`edit_note` with a Canonical
    // effect) must fail closed under synchronous PAT revocation on both SQLite
    // and PostgreSQL rather than bypassing revocation via a Phase-1 receipt.
    let edit_created = call(
        &fixture,
        owner,
        190,
        "create_ability",
        json!({
            "kind":"role",
            "name":"edit-replay-authority",
            "description":"Runtime role",
            "instructions":"Initial instructions.",
            "placement":{"home":"personal"},
        }),
    )
    .await
    .unwrap();
    let edit_author = fixture.pat(BearerScope::Write, true).await;
    let Some(AuthenticatedCredential::Pat(edit_pat_id)) = edit_author.auth().credential().cloned()
    else {
        panic!("expected write PAT");
    };
    let edit_input = json!({
        "ref":edit_created.structured_content["ref"],
        "versionToken":edit_created.structured_content["versionToken"],
        "instructions":"Updated instructions once.",
    });
    let edited = call(
        &fixture,
        &edit_author,
        191,
        "edit_ability",
        edit_input.clone(),
    )
    .await
    .unwrap();
    assert_eq!(edited.structured_content["outcome"], "updated");
    let edit_seq_before = fixture
        .canonical
        .read_space(&space_id)
        .await
        .unwrap()
        .last_seq;
    let edit_replay_denied = revoke_before_effect(
        fixture.projections.pause_note_edit(),
        call(&fixture, &edit_author, 191, "edit_ability", edit_input),
        fixture.control.revoke_pat(
            owner.clone(),
            AccountMutation {
                identity: runtime_ability_cases::identity(&fixture, owner, 192).await,
                input: RevokePat {
                    account: principal.clone(),
                    token: edit_pat_id,
                },
            },
        ),
    )
    .await;
    assert!(
        matches!(edit_replay_denied, PortError::Cancelled(_)),
        "{edit_replay_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&space_id)
            .await
            .unwrap()
            .last_seq,
        edit_seq_before
    );
    Box::pin(proposal_cases::revoked_session_cannot_apply_or_replay(
        &mut fixture,
    ))
    .await;
    let scope = fixture.canonical.read_space(&space_id).await.unwrap().scope;
    Box::pin(revoked_chat_receipt(&mut fixture, &scope)).await;
    Box::pin(revoked_root_userdoc_rollback(&mut fixture, &scope)).await;
    fixture.close().await;
}

async fn revoked_root_userdoc_rollback(fixture: &mut RuntimeFixture, personal: &HistoryScope) {
    let owner = fixture.human.clone();
    let principal = owner.auth().principal().clone();
    let owner_scope = SpaceContext::new(owner.auth().clone(), personal.clone(), budget()).unwrap();
    let note_id = NoteId::from_bytes([211; 16]);
    let created = fixture
        .canonical
        .create_note(
            owner_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: personal.clone(),
                    actor: principal.clone(),
                    key: CommandKey::from_bytes([211; 16]),
                    hash: ContentDigest::from_bytes([211; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note_id.clone(),
                    parent: None,
                    slug: "root-rollback-target".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Root rollback target\n\nOriginal root body.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let run = AgentRunId::from_bytes([212; 16]);
    let run_auth = owner
        .auth()
        .for_agent_run(
            run.clone(),
            personal.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_scope = SpaceContext::new(run_auth, personal.clone(), budget()).unwrap();
    let initial = fixture
        .canonical
        .get_note(
            owner_scope,
            GetNote {
                note: note_id.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    let body = initial.document.explicit_read(owner.auth()).unwrap();
    let pos = body.find("Original root body.").unwrap();
    fixture
        .canonical
        .edit_note(
            run_scope,
            Mutation {
                identity: CommandIdentity {
                    scope: personal.clone(),
                    actor: principal,
                    key: CommandKey::from_bytes([212; 16]),
                    hash: ContentDigest::from_bytes([212; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(created.value.revision),
                    ..Default::default()
                },
                input: EditNote {
                    note: note_id,
                    plan: notarium_syntax::patch::plan(
                        body,
                        notarium_core::span::ByteSpan::new(0, body.len()).unwrap(),
                        vec![(
                            notarium_core::patch::CarrierEditOrigin::Body,
                            notarium_core::span::ByteSpan::new(
                                pos,
                                pos + "Original root body.".len(),
                            )
                            .unwrap(),
                            "Modified by agent run.".into(),
                        )],
                    )
                    .unwrap(),
                },
            },
        )
        .await
        .unwrap();
    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let replay_key = CommandKey::from_bytes([213; 16]);
    Box::pin(revoked_rollback(
        fixture,
        &supervisor,
        personal,
        &run,
        &replay_key,
    ))
    .await;
    // Commit one rollback and verify replay after commit also fails closed.
    supervisor
        .rollback_run(owner, personal.clone(), run.clone(), replay_key.clone())
        .await
        .unwrap();
    Box::pin(revoked_rollback(
        fixture,
        &supervisor,
        personal,
        &run,
        &replay_key,
    ))
    .await;
}

#[tokio::test]
async fn sqlite_revocation_fences_canonical_authoring_and_proposal_replay() {
    Box::pin(check(false)).await;
}

#[tokio::test]
async fn postgres_revocation_fences_canonical_authoring_and_proposal_replay() {
    Box::pin(check(true)).await;
}

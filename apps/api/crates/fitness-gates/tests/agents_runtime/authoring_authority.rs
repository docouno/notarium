use super::*;
use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ClusterRunAuthority, ExclusiveDataRoot, LiveRunOwner,
    RunOwnershipRequest, StartChatRun,
};
use notarium_control::auth::token::{MintedToken, TokenKind, mint};
use notarium_core::{
    auth::{AuthenticatedCredential, ChatAudience},
    classes::DocClass,
    model::HistoryScope,
};
use std::{
    collections::BTreeSet,
    future::Future,
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{sync::oneshot, time::timeout};

struct CountingClusterAuthority {
    revocations: Arc<RevocationHub>,
    admit_chat_write_calls: AtomicUsize,
    register_owner_calls: AtomicUsize,
}

impl SessionRevocationPort for CountingClusterAuthority {
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.revocations
            .register_provider(ctx, selectors, cancellation)
    }

    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        self.revocations
            .register_canonical_effect(ctx, selectors, cancellation)
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.revocations.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.revocations.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.revocations.revoke(ctx, selector, reason)
    }
}

impl ClusterRunAuthority for CountingClusterAuthority {
    fn admit_chat_write(
        &self,
        _ctx: MaintenanceContext,
        _scope: HistoryScope,
        _thread: ChatThreadId,
        _ownership_lost: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.admit_chat_write_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(DomainError::AccessDenied.into()) })
    }

    fn register_owner(
        &self,
        _ctx: MaintenanceContext,
        _request: RunOwnershipRequest,
        _cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn LiveRunOwner>> {
        self.register_owner_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(DomainError::AccessDenied.into()) })
    }

    fn fence_orphan(
        &self,
        _ctx: MaintenanceContext,
        _scope: HistoryScope,
        _thread: ChatThreadId,
        _previous: AgentRunId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(None) })
    }
}

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

async fn revoke_during_fenced_replay<T, R>(
    fixture: &RuntimeFixture,
    mutation: impl Future<Output = Result<T, PortError>>,
    revocation: impl Future<Output = Result<R, PortError>>,
) -> PortError {
    // Pause inside `begin_canonical_effect()` so bypassing guarded receipt
    // lookup (for example via an unfenced SQLite Phase-1 read) can never pass.
    let (entered, release) = fixture.projections.pause_active_sql_effect();
    let revoke = async {
        let cancellation = entered
            .await
            .expect("the replayed operation must enter begin_canonical_effect()");
        tokio::pin!(revocation);
        tokio::select! {
            () = cancellation.cancelled() => {
                let _ = release.send(());
                revocation.await.unwrap();
            }
            res = &mut revocation => {
                res.unwrap();
                assert!(cancellation.is_cancelled());
                let _ = release.send(());
            }
        }
    };
    let (result, ()) = timeout(Duration::from_secs(10), async {
        tokio::join!(mutation, revoke)
    })
    .await
    .expect("fenced replay and revocation must settle");
    result.err().expect("the revoked fenced replay must fail")
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
    let actor = account.auth().principal().clone();
    let command = |tag| CommandIdentity {
        scope: personal.clone(),
        actor: actor.clone(),
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
    // Read-only PAT and read-only OAuth bearer tokens (and any AgentRun/Keeper
    // narrowed from them) must be rejected by chat redaction, run cancellation,
    // Control fencing, and direct Canonical chat/job writes even when the
    // underlying account owns the Space. Non-DirectHuman callers must also be
    // rejected by `start` and `enqueue_input` before any clustered ownership or
    // route-admission side effects occur.
    let read_pat = fixture.pat(BearerScope::Read, false).await;
    let write_pat = fixture.pat(BearerScope::Write, false).await;
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
    let cluster_authority = Arc::new(CountingClusterAuthority {
        revocations: fixture.revocations.clone(),
        admit_chat_write_calls: AtomicUsize::new(0),
        register_owner_calls: AtomicUsize::new(0),
    });
    let clustered = AgentRunSupervisor::new_clustered(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        cluster_authority.clone(),
    );
    for (tag, bearer) in [
        (205_u8, read_pat.clone()),
        (206_u8, read_oauth.clone()),
        (208_u8, write_pat),
    ] {
        assert!(matches!(
            clustered
                .start(
                    bearer.clone(),
                    StartChatRun {
                        scope: personal.clone(),
                        thread: thread.clone(),
                        expected_leaf: entry_seq,
                        options: ChatRunOptions::default(),
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert!(matches!(
            clustered
                .enqueue_input(
                    bearer,
                    SubmitUserChatInput {
                        identity: command(tag),
                        id: PendingInputId::from_bytes([tag; 16]),
                        thread: thread.clone(),
                        expected_leaf: entry_seq,
                        body: "Bearer caller must not enqueue chat input".into(),
                        mentions_agent: true,
                    },
                    ChatRunOptions::default(),
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
    }
    assert_eq!(
        cluster_authority
            .register_owner_calls
            .load(Ordering::SeqCst),
        0
    );
    assert_eq!(
        cluster_authority
            .admit_chat_write_calls
            .load(Ordering::SeqCst),
        0
    );
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
        let derived_agent = bearer
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([tag; 16]),
                personal.space_id.clone(),
                ChatAudience::Personal,
                bearer.auth().spaces().clone(),
            )
            .unwrap();
        let derived_keeper = bearer
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([tag.wrapping_add(10); 16]),
                personal.space_id.clone(),
                None,
                BTreeSet::new(),
            )
            .unwrap();
        for derived in [derived_agent, derived_keeper] {
            assert_eq!(derived.bearer_scope(), Some(BearerScope::Read));
            let derived_scope = SpaceContext::new(derived, personal.clone(), budget()).unwrap();
            assert!(matches!(
                fixture
                    .canonical
                    .create_chat(
                        derived_scope.clone(),
                        Mutation {
                            identity: command(tag.wrapping_add(20)),
                            preconditions: Preconditions::default(),
                            input: CreateChat {
                                thread: ChatThreadId::from_bytes([tag.wrapping_add(20); 16]),
                                owner: principal.clone(),
                                kind: ChatThreadKind::Personal,
                                title: "Blocked read-only delegated chat".into(),
                                project_folder: None,
                            },
                        },
                    )
                    .await,
                Err(PortError::Domain(DomainError::SpaceReadOnly))
            ));
            assert!(matches!(
                fixture
                    .canonical
                    .redact_chat_entry(derived_scope.clone(), redact_request(tag))
                    .await,
                Err(PortError::Domain(DomainError::SpaceReadOnly))
            ));
            assert!(matches!(
                fixture
                    .canonical
                    .create_job(
                        derived_scope,
                        Mutation {
                            identity: command(tag.wrapping_add(30)),
                            preconditions: Preconditions::default(),
                            input: ContentJobKind::Reindex,
                        },
                    )
                    .await,
                Err(PortError::Domain(DomainError::SpaceReadOnly))
            ));
        }
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
    let mut fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_authoring_authority")).await;
    let owner = &fixture.human;
    let space_id = fixture
        .control
        .whoami(owner.clone())
        .await
        .unwrap()
        .personal_space
        .unwrap();
    let scope = fixture.canonical.read_space(&space_id).await.unwrap().scope;
    Box::pin(revoked_ability_deletion(&fixture, &space_id)).await;
    Box::pin(revoked_ability_edit_replay(&fixture, &scope)).await;
    Box::pin(proposal_cases::revoked_session_cannot_apply_or_replay(
        &mut fixture,
    ))
    .await;
    Box::pin(revoked_chat_receipt(&mut fixture, &scope)).await;
    Box::pin(revoked_root_userdoc_rollback(&mut fixture, &scope)).await;
    fixture.close().await;
}

async fn revoked_ability_deletion(fixture: &RuntimeFixture, space_id: &SpaceId) {
    let owner = &fixture.human;
    let principal = owner.auth().principal();
    for (key, replay) in [(181, false), (183, true)] {
        let created = call(fixture, owner, key, "create_ability", json!({
            "kind":"role", "name":format!("authoring-fixture-{key}"), "description":"Runtime role",
            "instructions":"Use the recorded procedure.", "placement":{"home":"personal"},
        })).await.unwrap();
        let input = json!({"ref":created.structured_content["ref"]});
        let author = fixture.pat(BearerScope::Write, true).await;
        if replay {
            call(fixture, &author, key + 1, "delete_ability", input.clone())
                .await
                .unwrap();
        }
        let Some(AuthenticatedCredential::Pat(token)) = author.auth().credential() else {
            panic!("expected an opt-in PAT");
        };
        let before = fixture
            .canonical
            .read_space(space_id)
            .await
            .unwrap()
            .last_seq;
        let revocation = AccountMutation {
            identity: runtime_ability_cases::identity(fixture, owner, key + 1).await,
            input: RevokePat {
                account: principal.clone(),
                token: token.clone(),
            },
        };
        let mutation = call(fixture, &author, key + 1, "delete_ability", input.clone());
        let revocation = fixture.control.revoke_pat(owner.clone(), revocation);
        let pinned_writer = !replay;
        let denied = if pinned_writer {
            revoke_while_writer_pinned(
                fixture,
                space_id,
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
                .read_space(space_id)
                .await
                .unwrap()
                .last_seq,
            before
        );
        assert!(matches!(
            call(fixture, &author, key + 1, "delete_ability", input.clone()).await,
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
                identity: runtime_ability_cases::identity(fixture, owner, 187).await,
                input: RevokePat {
                    account: principal.clone(),
                    token: active_token.clone(),
                },
            };
            let active_denied = revoke_during_active_sql(
                fixture,
                call(
                    fixture,
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
                    .read_space(space_id)
                    .await
                    .unwrap()
                    .last_seq,
                before
            );
            // The same writer processes this new authorized command after the
            // queued and active revoked commands. It can trash the live package once.
            call(fixture, owner, 186, "delete_ability", input)
                .await
                .unwrap();
        }
    }
}

async fn revoked_ability_edit_replay(fixture: &RuntimeFixture, scope: &HistoryScope) {
    let owner = &fixture.human;
    let principal = owner.auth().principal();
    // Exact replay of a fenced `edit_note` (`CanonicalEffect::AbilityAuthoring`)
    // must enter the guarded receipt-replay transaction (`begin_canonical_effect`)
    // and fail closed under synchronous PAT revocation on both SQLite and
    // PostgreSQL, rather than returning a Phase-1 SQLite receipt without fencing.
    let edit_author = fixture.pat(BearerScope::Write, true).await;
    let Some(AuthenticatedCredential::Pat(edit_pat_id)) = edit_author.auth().credential().cloned()
    else {
        panic!("expected write PAT");
    };
    let skill_note = NoteId::from_bytes([220; 16]);
    let skill_owner_scope =
        SpaceContext::new(owner.auth().clone(), scope.clone(), budget()).unwrap();
    let skill_created = fixture
        .canonical
        .create_note(
            skill_owner_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: principal.clone(),
                    key: CommandKey::from_bytes([220; 16]),
                    hash: ContentDigest::from_bytes([220; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: skill_note.clone(),
                    parent: None,
                    slug: "edit-replay-authority".into(),
                    class: DocClass::Skill,
                    carrier: "# Role\n\nInitial instructions.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let skill_snapshot = fixture
        .canonical
        .get_note(
            skill_owner_scope,
            GetNote {
                note: skill_note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    let skill_body = skill_snapshot.document.explicit_read(owner.auth()).unwrap();
    let skill_pos = skill_body.find("Initial instructions.").unwrap();
    let edit_mutation = Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: principal.clone(),
            key: CommandKey::from_bytes([221; 16]),
            hash: ContentDigest::from_bytes([221; 32]),
        },
        preconditions: Preconditions {
            revision: Some(skill_created.value.revision),
            ..Default::default()
        },
        input: EditNote {
            note: skill_note,
            plan: notarium_syntax::patch::plan(
                skill_body,
                notarium_core::span::ByteSpan::new(0, skill_body.len()).unwrap(),
                vec![(
                    notarium_core::patch::CarrierEditOrigin::Body,
                    notarium_core::span::ByteSpan::new(
                        skill_pos,
                        skill_pos + "Initial instructions.".len(),
                    )
                    .unwrap(),
                    "Updated instructions once.".into(),
                )],
            )
            .unwrap(),
        },
    };
    let fenced_first = fixture
        .control_plane
        .fence_canonical_effect(
            edit_author.auth().clone(),
            SpaceContext::new(edit_author.auth().clone(), scope.clone(), budget()).unwrap(),
            CanonicalEffect::AbilityAuthoring,
        )
        .await
        .unwrap();
    fixture
        .canonical
        .edit_note(fenced_first, edit_mutation.clone())
        .await
        .unwrap();
    let edit_seq_before = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    let fenced_replay = fixture
        .control_plane
        .fence_canonical_effect(
            edit_author.auth().clone(),
            SpaceContext::new(edit_author.auth().clone(), scope.clone(), budget()).unwrap(),
            CanonicalEffect::AbilityAuthoring,
        )
        .await
        .unwrap();
    let edit_replay_denied = revoke_during_fenced_replay(
        fixture,
        fixture.canonical.edit_note(fenced_replay, edit_mutation),
        fixture.control.revoke_pat(
            owner.clone(),
            AccountMutation {
                identity: runtime_ability_cases::identity(fixture, owner, 222).await,
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
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq,
        edit_seq_before
    );
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
            owner_scope.clone(),
            GetNote {
                note: note_id.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    let mut body = initial
        .document
        .explicit_read(owner.auth())
        .unwrap()
        .to_owned();
    let mut revision = created.value.revision;
    let mut previous = "Original root body.".to_owned();
    let mut expected = String::new();
    for version in 1..=18 {
        // Roll back both run edits to the last of sixteen earlier human edits.
        let is_run = version > 16;
        let replacement = format!("Revision {version}.");
        let start = body.find(&previous).unwrap();
        let end = start + previous.len();
        let mut key = [212; 16];
        key[15] = version;
        revision = fixture
            .canonical
            .edit_note(
                if is_run {
                    run_scope.clone()
                } else {
                    owner_scope.clone()
                },
                Mutation {
                    identity: CommandIdentity {
                        scope: personal.clone(),
                        actor: principal.clone(),
                        key: CommandKey::from_bytes(key),
                        hash: ContentDigest::from_bytes([version; 32]),
                    },
                    preconditions: Preconditions {
                        revision: Some(revision),
                        ..Default::default()
                    },
                    input: EditNote {
                        note: note_id.clone(),
                        plan: notarium_syntax::patch::plan(
                            &body,
                            notarium_core::span::ByteSpan::new(0, body.len()).unwrap(),
                            vec![(
                                notarium_core::patch::CarrierEditOrigin::Body,
                                notarium_core::span::ByteSpan::new(start, end).unwrap(),
                                replacement.clone(),
                            )],
                        )
                        .unwrap(),
                    },
                },
            )
            .await
            .unwrap()
            .value
            .revision;
        body.replace_range(start..end, &replacement);
        previous = replacement;
        if version == 16 {
            expected = body.clone();
        }
    }
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
    // A lost reply after COMMIT is resolved by the same command and receipt.
    fixture
        .canonical
        .writer_faults()
        .unwrap()
        .drop_commit_response_once
        .store(true, std::sync::atomic::Ordering::Release);
    let lost = supervisor
        .rollback_run(
            owner.clone(),
            personal.clone(),
            run.clone(),
            replay_key.clone(),
        )
        .await;
    assert!(
        matches!(lost, Err(PortError::Unavailable(ref error))
        if error.effect() == notarium_core::error::CommitEffect::Unknown),
        "{lost:?}"
    );
    let settled = fixture
        .canonical
        .read_space(&personal.space_id)
        .await
        .unwrap()
        .last_seq;
    let replay = supervisor
        .rollback_run(owner, personal.clone(), run.clone(), replay_key.clone())
        .await
        .unwrap();
    assert_eq!(replay.receipt.seq(), settled);
    assert_eq!(replay.value.restored.len(), 1);
    let restored = fixture
        .canonical
        .get_note(
            owner_scope,
            GetNote {
                note: note_id,
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        restored
            .document
            .explicit_read(fixture.human.auth())
            .unwrap(),
        expected
    );
    Box::pin(revoked_rollback(
        fixture,
        &supervisor,
        personal,
        &run,
        &replay_key,
    ))
    .await;
    let after_commit = fixture
        .canonical
        .read_space(&personal.space_id)
        .await
        .unwrap()
        .last_seq;
    let (replay_active_account, replay_active_token) = native_session(fixture, 214).await;
    let replay_active_denied = revoke_during_fenced_replay(
        fixture,
        supervisor.rollback_run(replay_active_account, personal.clone(), run, replay_key),
        fixture.control.logout(support::evidence(
            AuthEvidenceKind::Session,
            replay_active_token.secret.expose(),
        )),
    )
    .await;
    assert!(
        matches!(replay_active_denied, PortError::Cancelled(_))
            || matches!(&replay_active_denied, PortError::Unavailable(failure)
                if failure.effect() == notarium_core::error::CommitEffect::Unknown),
        "{replay_active_denied:?}"
    );
    assert_eq!(
        fixture
            .canonical
            .read_space(&personal.space_id)
            .await
            .unwrap()
            .last_seq,
        after_commit
    );
}

#[tokio::test]
async fn sqlite_revocation_fences_canonical_authoring_and_proposal_replay() {
    Box::pin(check(false)).await;
}

#[tokio::test]
async fn postgres_revocation_fences_canonical_authoring_and_proposal_replay() {
    Box::pin(check(true)).await;
}

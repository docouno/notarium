use super::*;
use crate::runtime_ability_cases::{
    approve_disclosure, begin_ollama_response, loopback_provider, read_request, send_ollama,
};
use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ClusterRunAuthority, LiveRunOwner, RunOwnershipRequest,
    RunOwnershipTransition, StartChatRun,
};
use notarium_core::{
    auth::{ChatAudience, SpaceKind, SpaceRole},
    classes::DocClass,
    error::{BudgetKind, CommitEffect, OperationalFailure, RetryAdvice},
    ids::ThreadEntrySeq,
    model::HistoryScope,
};
use std::{sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    time::{sleep, timeout},
};

#[derive(Clone)]
struct SharedAuthority {
    hub: Arc<RevocationHub>,
    generation: Arc<Mutex<Generation>>,
    fenced: Option<AgentRunId>,
}

#[derive(Default)]
struct Generation {
    lost: bool,
    reject_owner: std::collections::VecDeque<PortError>,
    pause_owner: Option<(oneshot::Sender<Cancellation>, oneshot::Receiver<()>)>,
    handoff_retry_after: Option<tokio::time::Instant>,
    registrations: Vec<(RunOwnershipTransition, Cancellation)>,
    inputs: Vec<Cancellation>,
}

impl SharedAuthority {
    fn new(hub: Arc<RevocationHub>, fenced: Option<AgentRunId>) -> Self {
        Self {
            hub,
            generation: Arc::new(Mutex::new(Generation::default())),
            fenced,
        }
    }

    fn fence_writer(&self) {
        let cancelled = {
            let mut state = self.generation.lock().unwrap();
            state.lost = true;
            let mut tokens = std::mem::take(&mut state.inputs);
            tokens.extend(
                std::mem::take(&mut state.registrations)
                    .into_iter()
                    .map(|(_, token)| token),
            );
            tokens
        };
        for token in cancelled {
            token.cancel();
        }
        self.hub.close();
    }

    fn observed(&self, transition: &RunOwnershipTransition) -> bool {
        self.generation
            .lock()
            .unwrap()
            .registrations
            .iter()
            .any(|(saved, _)| saved == transition)
    }

    fn reject_next_owner(&self, error: PortError) {
        self.generation
            .lock()
            .unwrap()
            .reject_owner
            .push_back(error);
    }

    fn pause_next_owner(&self) -> (oneshot::Receiver<Cancellation>, oneshot::Sender<()>) {
        let (entered, observed) = oneshot::channel();
        let (resume, release) = oneshot::channel();
        assert!(
            self.generation
                .lock()
                .unwrap()
                .pause_owner
                .replace((entered, release))
                .is_none()
        );
        (observed, resume)
    }
}

impl LiveRunOwner for SharedAuthority {
    fn is_current(&self) -> bool {
        !self.generation.lock().unwrap().lost
    }

    fn prior_owner_fenced(&self, run: &AgentRunId) -> bool {
        self.fenced.as_ref() == Some(run)
    }
}

impl RevocationLease for SharedAuthority {
    fn check(&self) -> Result<(), PortError> {
        if self.is_current() {
            Ok(())
        } else {
            Err(DomainError::SpaceReadOnly.into())
        }
    }
}

impl ClusterRunAuthority for SharedAuthority {
    fn admit_chat_write(
        &self,
        _ctx: MaintenanceContext,
        _scope: HistoryScope,
        _thread: ChatThreadId,
        ownership_lost: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let mut generation = self.generation.lock().unwrap();
            if generation.lost {
                ownership_lost.cancel();
                return Err(DomainError::SpaceReadOnly.into());
            }
            generation.inputs.push(ownership_lost);
            Ok(Box::new(self.clone()) as Box<dyn RevocationLease>)
        })
    }

    fn register_owner(
        &self,
        _ctx: MaintenanceContext,
        request: RunOwnershipRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn LiveRunOwner>> {
        Box::pin(async move {
            let pause = self.generation.lock().unwrap().pause_owner.take();
            if let Some((entered, release)) = pause {
                entered.send(cancellation.clone()).unwrap();
                release.await.unwrap();
            }
            let mut generation = self.generation.lock().unwrap();
            if let Some(deadline) = generation.handoff_retry_after.take() {
                assert!(
                    tokio::time::Instant::now() >= deadline,
                    "FIFO retried before admission reopened"
                );
            }
            if let Some(error) = generation.reject_owner.pop_front() {
                if matches!(request.transition, RunOwnershipTransition::Handoff { .. })
                    && let PortError::Domain(DomainError::RateLimited { retry_after_ms, .. }) =
                        &error
                {
                    generation.handoff_retry_after =
                        Some(tokio::time::Instant::now() + Duration::from_millis(*retry_after_ms));
                }
                return Err(error);
            }
            if generation.lost {
                cancellation.cancel();
            }
            generation
                .registrations
                .push((request.transition, cancellation));
            Ok(Box::new(self.clone()) as Box<dyn LiveRunOwner>)
        })
    }

    fn fence_orphan(
        &self,
        _ctx: MaintenanceContext,
        _scope: HistoryScope,
        _thread: ChatThreadId,
        previous: AgentRunId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async move {
            if self.is_current() && self.prior_owner_fenced(&previous) {
                Ok(Some(Box::new(self.clone()) as Box<dyn RevocationLease>))
            } else {
                Ok(None)
            }
        })
    }
}

impl SessionRevocationPort for SharedAuthority {
    fn register_canonical_effect(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Arc<dyn CanonicalEffectRegistration>> {
        self.hub
            .register_canonical_effect(ctx, selectors, cancellation)
    }

    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.hub.register_provider(ctx, selectors, cancellation)
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.hub.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.hub.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.hub.revoke(ctx, selector, reason)
    }
}

fn maintenance() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: budget(),
    }
}

async fn assert_socket_closed(socket: &mut (impl tokio::io::AsyncRead + Unpin)) {
    let mut byte = [0; 1];
    let closed = timeout(Duration::from_secs(5), socket.read(&mut byte))
        .await
        .unwrap();
    assert!(closed.is_err() || closed.unwrap() == 0);
}

async fn thread(fixture: &RuntimeFixture, reader: &SpaceContext, id: &ChatThreadId) -> ChatThread {
    fixture
        .canonical
        .read_chat(
            reader.clone(),
            ChatRead {
                thread: id.clone(),
                leaf: ThreadEntrySeq::ZERO,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread
}

async fn wait_idle(
    fixture: &RuntimeFixture,
    supervisor: &AgentRunSupervisor,
    reader: &SpaceContext,
    id: &ChatThreadId,
) -> ChatThread {
    timeout(Duration::from_secs(15), async {
        loop {
            let live = thread(fixture, reader, id).await;
            if live.active_run.is_none()
                && supervisor
                    .subscribe(
                        fixture.human.clone(),
                        reader.scope().clone(),
                        id.clone(),
                        None,
                    )
                    .await
                    .unwrap()
                    .is_none()
            {
                break live;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

async fn fenced_ownership_recovers_pending_inputs(
    fixture: RuntimeFixture,
    reader: &SpaceContext,
) -> RuntimeFixture {
    let scope = reader.scope().clone();
    let actor = reader.auth().principal().clone();
    let thread_id = ChatThreadId::from_bytes([0xfa; 16]);
    let identity = |index| {
        let mut bytes = [0xfa; 16];
        bytes[0] = index;
        CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(bytes),
            hash: ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes()),
        }
    };
    fixture
        .canonical
        .create_chat(
            reader.clone(),
            Mutation {
                identity: identity(0),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread_id.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    title: "Fenced turn".into(),
                    project_folder: None,
                },
            },
        )
        .await
        .unwrap();

    let input = |index, leaf, body: String| SubmitUserChatInput {
        identity: identity(index),
        id: PendingInputId::from_bytes([index; 16]),
        thread: thread_id.clone(),
        expected_leaf: leaf,
        body,
        mentions_agent: false,
    };
    let attachment = || ProviderAttachmentTarget::Personal {
        owner: actor.clone(),
        space: scope.space_id.clone(),
    };
    let request = |leaf, options| StartChatRun {
        scope: scope.clone(),
        thread: thread_id.clone(),
        expected_leaf: leaf,
        options,
    };

    let old_authority = Arc::new(SharedAuthority::new(fixture.revocations.clone(), None));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, &fixture.human, &listener, 178, false).await;
    approve_disclosure(
        &fixture,
        &fixture.human,
        &local,
        180,
        attachment(),
        [DocClass::UserDoc, DocClass::Profile].into(),
    )
    .await;
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        ..ChatRunOptions::default()
    };
    let primary = AgentRunSupervisor::new_clustered(
        local.registry.clone(),
        fixture.revocations.clone(),
        old_authority.clone(),
    );
    let peer = AgentRunSupervisor::new_clustered(
        local.registry.clone(),
        fixture.revocations.clone(),
        old_authority.clone(),
    );
    let initial = input(1, ThreadEntrySeq::ZERO, "An active writer".into());
    let unavailable = PortError::Unavailable(
        OperationalFailure::new(
            ContentDigest::from_bytes([0xfa; 32]),
            CommitEffect::NotCommitted,
            RetryAdvice::Never,
            false,
        )
        .unwrap(),
    );
    old_authority.reject_next_owner(unavailable.clone());
    assert!(matches!(
        primary.enqueue_input(fixture.human.clone(), initial.clone(), options.clone()).await,
        Err(PortError::Unavailable(failure))
            if failure.effect() == CommitEffect::Unknown && failure.retry() == RetryAdvice::RetrySameCommand
    ));
    let head = thread(&fixture, reader, &thread_id).await.head;
    let saved = supervised_chat_cases::branch(&fixture, reader, &thread_id, head).await;
    assert!(saved.thread.active_run.is_none());
    assert_eq!(saved.entries.len(), 1);
    assert_eq!(saved.entries[0].kind, ChatEntryKind::Human);
    let rate_limit = DomainError::RateLimited {
        retry_after_ms: 60,
        budget: BudgetKind::Concurrency,
    };
    old_authority.reject_next_owner(rate_limit.clone().into());
    assert!(
        matches!(primary.enqueue_input(fixture.human.clone(), initial.clone(), options.clone()).await,
        Err(PortError::Domain(error)) if error == rate_limit)
    );
    let first = primary
        .enqueue_input(
            fixture.human.clone(),
            initial.clone(),
            ChatRunOptions::default(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(first_post) = first.outcome else {
        panic!("expected a committed initiating message");
    };
    let first_run = first.run.unwrap();
    assert_eq!(saved.thread.head, first_post.value.seq);
    let (mut blocked, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let mut retained = primary
        .subscribe(
            fixture.human.clone(),
            scope.clone(),
            thread_id.clone(),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        peer.start(
            fixture.human.clone(),
            request(first_post.value.seq, options.clone())
        )
        .await,
        Err(PortError::Unavailable(_))
    ));
    assert!(old_authority.observed(&RunOwnershipTransition::Recover {
        previous: first_run
    }));
    let fence = old_authority
        .fence_provider(
            maintenance(),
            vec![RevocationSelector::ProviderResource(
                local.resource.id.clone(),
            )],
        )
        .await
        .unwrap();
    assert_socket_closed(&mut blocked).await;
    drop(fence);
    let live = wait_idle(&fixture, &primary, reader, &thread_id).await;
    assert_eq!(live.head, first_post.value.seq);
    let replay = peer
        .enqueue_input(fixture.human.clone(), initial, options.clone())
        .await
        .unwrap();
    assert!(
        matches!(replay.outcome, SubmitUserChatOutcome::Appended(saved) if saved.receipt == first_post.receipt)
    );
    assert!(replay.run.is_none());

    let (hydrating, resume) = fixture.projections.pause_chat_hydration();
    let abandoned = primary
        .start(fixture.human.clone(), request(live.head, options.clone()))
        .await
        .unwrap();
    timeout(Duration::from_secs(15), hydrating)
        .await
        .unwrap()
        .unwrap();
    let body = "A staged message from the previous owner's queue. ".repeat(700);
    let digest = ContentDigest::from_bytes(*blake3::hash(body.as_bytes()).as_bytes());
    let enqueue = |index| {
        primary.enqueue_input(
            fixture.human.clone(),
            input(index, live.head, body.clone()),
            options.clone(),
        )
    };
    // Fill the durable queue on the active writer before the provider's
    // request deadline starts. Reserve the final slot for the live HTTP call.
    for index in 2..17 {
        let accepted = enqueue(index).await.unwrap();
        assert!(
            matches!(accepted.outcome, SubmitUserChatOutcome::Queued(_)),
            "input {index} must enter the active run's queue: {:?}",
            accepted.outcome,
        );
    }
    resume.send(()).unwrap();
    let (mut blocked, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    // Let dispatch release its snapshot fence, then hold the response body.
    blocked
        .get_mut()
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n",
        )
        .await
        .unwrap();
    let fill_final_slot = async {
        assert!(matches!(
            enqueue(17).await.unwrap().outcome,
            SubmitUserChatOutcome::Queued(_)
        ));
        assert!(matches!(
            enqueue(18).await.unwrap().outcome,
            SubmitUserChatOutcome::Full { limit: 16 }
        ));
        assert_eq!(
            fixture
                .canonical
                .read_verified_blob(&scope, digest)
                .await
                .unwrap(),
            body.as_bytes()
        );
    };
    let mut byte = [0; 1];
    tokio::select! {
        biased;
        result = blocked.read(&mut byte) => panic!("unexpected provider socket read before fencing: {result:?}"),
        () = fill_final_slot => {}
    }

    old_authority.fence_writer();
    assert_socket_closed(&mut blocked).await;
    assert!(matches!(
        retained.next().await,
        notarium_agents::chats::stream::StreamRead::Closed
    ));
    assert!(matches!(
        primary
            .enqueue_input(
                fixture.human.clone(),
                input(19, live.head, body.clone()),
                options,
            )
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(
        thread(&fixture, reader, &thread_id)
            .await
            .active_run
            .as_ref(),
        Some(&abandoned)
    );
    let stale = thread(&fixture, reader, &thread_id).await;
    assert!(matches!(
        primary
            .redact_chat_entry(
                fixture.human.clone(),
                Mutation {
                    identity: identity(20),
                    preconditions: Preconditions::default(),
                    input: RedactChatEntry {
                        thread: thread_id.clone(),
                        entry: first_post.value.seq,
                        expected_thread_revision: stale.revision,
                    },
                }
            )
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    drop(primary);
    drop(peer);
    drop(local);

    let fixture = fixture.reopen_fenced(&scope).await;
    let authority = Arc::new(SharedAuthority::new(
        fixture.revocations.clone(),
        Some(abandoned.clone()),
    ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, &fixture.human, &listener, 184, false).await;
    approve_disclosure(
        &fixture,
        &fixture.human,
        &local,
        186,
        attachment(),
        [DocClass::UserDoc, DocClass::Profile].into(),
    )
    .await;
    let successor = AgentRunSupervisor::new_clustered(
        local.registry.clone(),
        fixture.revocations.clone(),
        authority.clone(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id),
        model: Some(local.model),
        ..ChatRunOptions::default()
    };
    enum StopDuring {
        RegisterOwner,
        ReadBranch,
        RecoverInSql,
    }
    for phase in [
        StopDuring::RegisterOwner,
        StopDuring::ReadBranch,
        StopDuring::RecoverInSql,
    ] {
        let stopping = AgentRunSupervisor::new_clustered(
            local.registry.clone(),
            fixture.revocations.clone(),
            authority.clone(),
        );
        let (entered, resume) = authority.pause_next_owner();
        let recovery = tokio::spawn({
            let supervisor = stopping.clone();
            let account = fixture.human.clone();
            let request = request(live.head, options.clone());
            async move { supervisor.start(account, request).await }
        });
        let owner_token = timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        let next_pause = match phase {
            StopDuring::RegisterOwner => None,
            StopDuring::ReadBranch => Some(fixture.projections.pause_chat_read()),
            StopDuring::RecoverInSql => Some(fixture.projections.pause_active_sql_effect()),
        };
        let (operation_token, release) = if let Some((entered, release)) = next_pause {
            resume.send(()).unwrap();
            let token = timeout(Duration::from_secs(10), entered)
                .await
                .unwrap()
                .unwrap();
            (token, release)
        } else {
            (owner_token.clone(), resume)
        };
        stopping.shutdown();
        assert!(owner_token.is_cancelled());
        assert!(operation_token.is_cancelled());
        release.send(()).unwrap();
        assert!(recovery.await.unwrap().is_err());
        assert_eq!(
            thread(&fixture, reader, &thread_id)
                .await
                .active_run
                .as_ref(),
            Some(&abandoned)
        );
        assert_eq!(
            fixture
                .canonical
                .read_verified_blob(&scope, digest)
                .await
                .unwrap(),
            body.as_bytes()
        );
    }

    let next = successor
        .start(fixture.human.clone(), request(live.head, options.clone()))
        .await
        .unwrap();
    assert!(authority.observed(&RunOwnershipTransition::Recover {
        previous: abandoned.clone()
    }));
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let reply = begin_ollama_response(
        &mut wire,
        json!({"role":"assistant", "content":"Recovered without replaying queued inputs."}),
        "stop",
    )
    .await;

    let replay = successor
        .enqueue_input(
            fixture.human.clone(),
            input(2, live.head, body),
            ChatRunOptions::default(),
        )
        .await
        .unwrap();
    assert!(matches!(
        replay.outcome,
        SubmitUserChatOutcome::Queued(saved) if saved.in_flight_run == abandoned
    ));
    let direct = fixture.human.auth();
    let run = SpaceContext::new(
        direct
            .for_agent_run(
                next.clone(),
                scope.space_id.clone(),
                ChatAudience::Personal,
                direct.spaces().clone(),
            )
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    assert!(
        fixture
            .canonical
            .list_pending_chat_inputs(run, thread_id.clone())
            .await
            .unwrap()
            .is_empty()
    );
    timeout(Duration::from_secs(10), async {
        while fixture
            .canonical
            .read_verified_blob(&scope, digest)
            .await
            .is_ok()
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    let messages = ["First after recovery", "Second after recovery"];
    for (index, message) in [21, 22].into_iter().zip(messages) {
        let queued = successor
            .enqueue_input(
                fixture.human.clone(),
                input(index, live.head, message.into()),
                options.clone(),
            )
            .await
            .unwrap();
        assert!(matches!(queued.outcome, SubmitUserChatOutcome::Queued(_)));
    }
    authority.reject_next_owner(unavailable);
    authority.reject_next_owner(rate_limit.into());
    wire.get_mut().write_all(reply.as_bytes()).await.unwrap();
    for message in messages {
        let (mut wire, prompt) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .unwrap();
        let latest = prompt["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|part| part["role"] == "user")
            .unwrap();
        assert_eq!(latest["content"], message);
        send_ollama(
            &mut wire,
            json!({"role":"assistant", "content":"Received."}),
            "stop",
        )
        .await;
    }
    assert!(authority.observed(&RunOwnershipTransition::Handoff { previous: next }));
    let clean = SpaceContext::new(fixture.human.auth().clone(), scope, budget()).unwrap();
    let final_thread = wait_idle(&fixture, &successor, &clean, &thread_id).await;
    assert_eq!(final_thread.head.get(), live.head.get() + 5);
    successor.shutdown();
    fixture
}

async fn takeover_case(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_takeover")).await;
    let personal = fixture
        .control
        .list_spaces(
            fixture.human.clone(),
            ControlPageRequest::new(4, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|access| access.space.kind == SpaceKind::Personal)
        .expect("the fixture owner has a Personal Space");
    let reader =
        SpaceContext::new(fixture.human.auth().clone(), personal.history, budget()).unwrap();
    let fixture = Box::pin(fenced_ownership_recovers_pending_inputs(fixture, &reader)).await;
    fixture.close().await;
}

pub(super) async fn interrupted_handoffs(
    fixture: &RuntimeFixture,
    registry: Arc<ToolRegistry>,
    scope: &SpaceContext,
    peer: &SpaceContext,
    mut membership: ControlRevision,
    options: &ChatRunOptions,
    listener: &TcpListener,
) -> ControlRevision {
    let authority = Arc::new(SharedAuthority::new(fixture.revocations.clone(), None));
    let replay_owner = AgentRunSupervisor::new_clustered(
        registry.clone(),
        fixture.revocations.clone(),
        authority.clone(),
    );
    let owner = AccountContext::new(scope.auth().clone(), budget());
    let editor = AccountContext::new(peer.auth().clone(), budget());
    for (tag, queued, shutdown) in [
        (210, false, false),
        (220, true, false),
        (230, false, true),
        (240, true, true),
    ] {
        let supervisor = AgentRunSupervisor::new_clustered(
            registry.clone(),
            fixture.revocations.clone(),
            authority.clone(),
        );
        let thread = ChatThreadId::from_bytes([tag; 16]);
        let identity = |actor: &AccountContext, offset| CommandIdentity {
            scope: scope.scope().clone(),
            actor: actor.auth().principal().clone(),
            key: CommandKey::from_bytes([tag + offset; 16]),
            hash: ContentDigest::from_bytes([tag + offset; 32]),
        };
        fixture
            .canonical
            .create_chat(
                scope.clone(),
                Mutation {
                    identity: identity(&owner, 0),
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: thread.clone(),
                        kind: ChatThreadKind::SpaceGroup,
                        owner: owner.auth().principal().clone(),
                        title: "Revoked sender".into(),
                        project_folder: None,
                    },
                },
            )
            .await
            .unwrap();
        let input = |account: &AccountContext, offset, leaf, text: &str| SubmitUserChatInput {
            identity: identity(account, offset),
            id: PendingInputId::from_bytes([tag + offset; 16]),
            thread: thread.clone(),
            expected_leaf: leaf,
            body: text.into(),
            mentions_agent: true,
        };
        let mut leaf = ThreadEntrySeq::ZERO;
        let predecessor = if queued {
            let (hydrating, resume) = fixture.projections.pause_chat_hydration();
            let first = supervisor
                .enqueue_input(
                    owner.clone(),
                    input(&owner, 1, leaf, "Hold this turn"),
                    options.clone(),
                )
                .await
                .unwrap();
            let SubmitUserChatOutcome::Appended(saved) = first.outcome else {
                panic!("expected initial post")
            };
            leaf = saved.value.seq;
            timeout(Duration::from_secs(10), hydrating)
                .await
                .unwrap()
                .unwrap();
            Some((first.run.unwrap(), resume))
        } else {
            None
        };
        let post = input(&editor, 2, leaf, "An editor mentions the agent");
        let (entered, resume) = authority.pause_next_owner();
        let enqueue = tokio::spawn({
            let supervisor = supervisor.clone();
            let account = editor.clone();
            let post = post.clone();
            let options = options.clone();
            async move {
                supervisor
                    .enqueue_input(account, post, options)
                    .await
                    .unwrap()
            }
        });
        let direct = if let Some((run, release)) = predecessor {
            assert!(matches!(
                enqueue.await.unwrap().outcome,
                SubmitUserChatOutcome::Queued(_)
            ));
            supervisor
                .stop(owner.clone(), scope.scope().clone(), thread.clone(), run)
                .await
                .unwrap();
            release.send(()).unwrap();
            None
        } else {
            Some(enqueue)
        };
        let token = timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        // Cover shutdown both while the owner acknowledgement is outstanding
        // and after it returns, while the next branch read is still in flight.
        let resume = if shutdown && queued {
            let (reading, release) = fixture.projections.pause_chat_read();
            resume.send(()).unwrap();
            timeout(Duration::from_secs(10), reading)
                .await
                .unwrap()
                .unwrap();
            release
        } else {
            resume
        };
        if shutdown {
            supervisor.shutdown();
        } else {
            for (offset, role) in [(3, SpaceRole::Viewer), (4, SpaceRole::Editor)] {
                membership = fixture
                    .control
                    .change_membership(
                        scope.clone(),
                        MembershipChange {
                            command: CommandKey::from_bytes([tag + offset; 16]),
                            member: editor.auth().principal().clone(),
                            role: Some(role),
                            expected: membership,
                        },
                    )
                    .await
                    .unwrap()
                    .revision;
                assert!(
                    token.is_cancelled(),
                    "the completed membership change must fence the registering owner"
                );
            }
        }
        resume.send(()).unwrap();
        if let Some(enqueue) = direct {
            let submission = enqueue.await.unwrap();
            assert!(matches!(
                submission.outcome,
                SubmitUserChatOutcome::Appended(_)
            ));
            assert!(submission.run.is_none());
        }
        let head = supervised_chat_cases::idle_leaf(fixture, scope, &thread).await;
        assert!(token.is_cancelled());
        let branch = supervised_chat_cases::branch(fixture, scope, &thread, head).await;
        assert_eq!(
            branch
                .entries
                .iter()
                .filter(|e| e.author == *editor.auth().principal())
                .count(),
            1
        );
        assert!(
            branch
                .entries
                .iter()
                .all(|e| e.kind == ChatEntryKind::Human)
        );
        let replay = replay_owner
            .enqueue_input(editor.clone(), post, options.clone())
            .await
            .unwrap();
        assert!(replay.run.is_none());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        supervisor.shutdown();
    }
    replay_owner.shutdown();
    membership
}

#[tokio::test]
async fn sqlite_fenced_owner_recovers_pending_inputs() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(takeover_case(false)).await;
}

#[tokio::test]
async fn postgres_fenced_owner_recovers_pending_inputs() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(takeover_case(true)).await;
}

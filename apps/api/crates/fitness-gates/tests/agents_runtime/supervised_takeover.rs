use super::*;
use crate::runtime_ability_cases::{
    approve_disclosure, loopback_provider, read_request, send_ollama,
};
use notarium_agents::chats::{
    AgentRunSupervisor, ChatRunOptions, ClusterRunAuthority, LiveRunOwner, RunOwnershipRequest,
    RunOwnershipTransition, StartChatRun,
};
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::DocClass,
    ids::ThreadEntrySeq,
    model::HistoryScope,
};
use std::{sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
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
            let mut generation = self.generation.lock().unwrap();
            if generation.lost {
                cancellation.cancel();
            }
            generation
                .registrations
                .push((request.transition, cancellation));
            Ok(Box::new(self.clone()) as Box<dyn LiveRunOwner>)
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
    let first = primary
        .enqueue_input(
            fixture.human.clone(),
            input(1, ThreadEntrySeq::ZERO, "An active writer".into()),
            options.clone(),
        )
        .await
        .unwrap();
    let SubmitUserChatOutcome::Appended(first_post) = first.outcome else {
        panic!("expected a committed initiating message");
    };
    let first_run = first.run.unwrap();
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

    let abandoned = primary
        .start(fixture.human.clone(), request(live.head, options.clone()))
        .await
        .unwrap();
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
    let body = "A staged message from the previous owner's queue. ".repeat(20);
    let digest = ContentDigest::from_bytes(*blake3::hash(body.as_bytes()).as_bytes());

    // Inputs are routed to the current writer, which retains their credentials.
    for index in 2..=17 {
        let accepted = primary
            .enqueue_input(
                fixture.human.clone(),
                input(index, live.head, body.clone()),
                options.clone(),
            )
            .await
            .unwrap();
        assert!(
            matches!(accepted.outcome, SubmitUserChatOutcome::Queued(_)),
            "input {index} must enter the active run's queue: {:?}",
            accepted.outcome,
        );
    }
    assert!(matches!(
        primary
            .enqueue_input(
                fixture.human.clone(),
                input(18, live.head, body.clone()),
                options.clone(),
            )
            .await
            .unwrap()
            .outcome,
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
        local.registry,
        fixture.revocations.clone(),
        authority.clone(),
    );
    let next = successor
        .start(
            fixture.human.clone(),
            request(
                live.head,
                ChatRunOptions {
                    provider: Some(local.resource.id),
                    model: Some(local.model),
                    ..ChatRunOptions::default()
                },
            ),
        )
        .await
        .unwrap();
    assert!(authority.observed(&RunOwnershipTransition::Recover {
        previous: abandoned.clone()
    }));
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();

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
                next,
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

    send_ollama(
        &mut wire,
        json!({"role":"assistant", "content":"Recovered without replaying queued inputs."}),
        "stop",
    )
    .await;
    let clean = SpaceContext::new(fixture.human.auth().clone(), scope, budget()).unwrap();
    let final_thread = wait_idle(&fixture, &successor, &clean, &thread_id).await;
    assert_eq!(final_thread.head, live.head.checked_next().unwrap());
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

use super::*;
use notarium_agents::mcp::runtime_abilities::{RuntimeAbilities, interactive};
use notarium_canonical::CreateFolderSpec;
use notarium_control::outbound::PrivateNetworkRule;
use notarium_core::{
    auth::{ChatAudience, SpaceKind},
    classes::{DocClass, ProviderMessage},
    model::FolderRef,
    receipt::AccountCommandIdentity,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

pub(super) const MODEL: &str = "fixture-model";

pub(super) struct LoopbackProvider {
    pub(super) provider: ProviderService,
    pub(super) registry: Arc<ToolRegistry>,
    pub(super) resource: ProviderResourceInfo,
    pub(super) model: ModelProfileId,
}

pub(super) async fn secondary_project_abilities_reach_the_wire(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 221).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([221; 16]),
                    kind: SpaceKind::Shared,
                    name: "Runtime abilities".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let storage = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap();
    let human = AccountContext::new(
        fixture
            .control
            .trusted_none(
                PerimeterAttestation::attest_checked()
                    .with_human_management()
                    .with_ability_write(),
                budget(),
            )
            .await
            .unwrap(),
        budget(),
    );
    let project = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([221; 16]),
    };
    let neighbor = FolderRef {
        space_id: project.space_id.clone(),
        folder_id: FolderId::from_bytes([222; 16]),
    };
    for (folder, slug) in [(&project, "runtime"), (&neighbor, "other")] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: shared.history.clone(),
                active_epoch: storage.active_epoch,
                folder_id: folder.folder_id.clone(),
                parent: None,
                slug: slug.into(),
                display_name: slug.into(),
                is_project: true,
                project_slug: Some(slug.into()),
                actor: human.auth().principal().clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let project_handle = format!("{}/runtime", shared.slug);
    let skill = call(fixture, &human, 222, "create_ability", json!({
        "kind":"skill", "name":"runtime-shared-skill", "description":"A scoped skill",
        "instructions":"Instructions from the Space skill.", "placement":{"home":"space","space":shared.slug},
    })).await.unwrap();
    call(fixture, &human, 223, "create_ability", json!({
        "kind":"role", "name":"runtime-project-role", "description":"A scoped role",
        "instructions":"Instructions from the project role.", "placement":{"home":"project","project":project_handle},
        "attachments":[{"ref":skill.structured_content["ref"]}],
    })).await.unwrap();
    call(fixture, &human, 224, "create_ability", json!({
        "kind":"role", "name":"runtime-space-role", "description":"A Space-level role",
        "instructions":"Instructions from the Space role.", "placement":{"home":"space","space":shared.slug},
    })).await.unwrap();
    let episode = EpisodeId::from_bytes([221; 16]);
    let opened = fixture
        .control
        .start_or_resume_episode(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, &human, 225).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: episode.clone(),
                        name: None,
                    },
                    project_hint: Some(project.clone()),
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(opened.value, EpisodeStartResult::New(current) if current.id == episode));
    call(
        fixture,
        &human,
        226,
        "use_role",
        json!({
            "role":"runtime-project-role", "project":project_handle, "session":episode,
        }),
    )
    .await
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &human, &listener, 231, false).await;
    let wire = tokio::spawn(serve_completions(listener));
    let owner = human.auth().principal().clone();
    for (tag, target) in [
        (
            233,
            ProviderAttachmentTarget::Personal {
                owner: owner.clone(),
                space: personal.scope().space_id.clone(),
            },
        ),
        (
            234,
            ProviderAttachmentTarget::Personal {
                owner,
                space: project.space_id.clone(),
            },
        ),
        (235, ProviderAttachmentTarget::Project(project.clone())),
    ] {
        approve_disclosure(
            fixture,
            &human,
            &local,
            tag,
            target,
            [DocClass::Skill].into(),
        )
        .await;
    }
    let provider = &local.provider;
    let run = human
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([221; 16]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            human.auth().spaces().clone(),
        )
        .unwrap();
    let primary = SpaceContext::new(run.clone(), personal.scope().clone(), budget()).unwrap();
    let selection = provider
        .select_provider(
            primary.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let first = interactive(&local.registry, &primary, &selection, &episode)
        .await
        .unwrap();
    assert!(run.taint().is_tainted());
    assert_eq!(first.secondary_projects, std::slice::from_ref(&project));
    assert!(
        matches!(first.parts.as_slice(), [ProviderMessage::Ability(role), ProviderMessage::Ability(skill)]
        if role.provenance().placement() == &AbilityPlacement::OwnedProject(project.clone())
            && skill.provenance().placement() == &AbilityPlacement::OwnedSpace(project.space_id.clone()))
    );
    let initial_request = request(226, selection.clone(), first);
    assert_denied(
        provider,
        &primary,
        &initial_request,
        227,
        vec![neighbor.clone()],
    )
    .await;
    settle(provider, &primary, initial_request).await;

    call(
        fixture,
        &human,
        229,
        "use_role",
        json!({
            "role":"runtime-space-role","project":project_handle,"session":episode,
        }),
    )
    .await
    .unwrap();
    let second = interactive(&local.registry, &primary, &selection, &episode)
        .await
        .unwrap();
    assert_eq!(second.secondary_projects, [project]);
    assert!(matches!(
        second.parts.as_slice(),
        [ProviderMessage::Ability(_)]
    ));
    let space_request = request(230, selection, second);
    // The Space role has no project in its canonical origin. Its chosen
    // project must be supplied by the runtime loader for project-only consent.
    assert_denied(provider, &primary, &space_request, 228, vec![]).await;
    assert_denied(provider, &primary, &space_request, 229, vec![neighbor]).await;
    settle(provider, &primary, space_request).await;
    let received = tokio::time::timeout(std::time::Duration::from_secs(5), wire)
        .await
        .unwrap()
        .unwrap();
    let messages = |body: &Value| body["messages"][0]["content"].as_str().unwrap().to_owned();
    assert!(messages(&received[0]).contains("Instructions from the project role."));
    assert!(messages(&received[0]).contains("Instructions from the Space skill."));
    assert!(messages(&received[1]).contains("Instructions from the Space role."));
}

pub(super) async fn identity(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    tag: u8,
) -> AccountCommandIdentity {
    let owner = human.auth().principal();
    let expected = fixture
        .control
        .account(human.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    AccountCommandIdentity {
        owner: owner.clone(),
        actor: owner.clone(),
        expected,
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    }
}

pub(super) async fn loopback_provider(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    listener: &TcpListener,
    tag: u8,
    tools: bool,
) -> LoopbackProvider {
    loopback_provider_with_output(fixture, human, listener, tag, tools, 512).await
}

pub(super) async fn loopback_provider_with_output(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    listener: &TcpListener,
    tag: u8,
    tools: bool,
    max_output_tokens: u32,
) -> LoopbackProvider {
    loopback_provider_with_limits(
        fixture,
        human,
        listener,
        tag,
        tools,
        65_536,
        max_output_tokens,
    )
    .await
}

pub(super) async fn loopback_provider_with_limits(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    listener: &TcpListener,
    tag: u8,
    tools: bool,
    max_input_tokens: u32,
    max_output_tokens: u32,
) -> LoopbackProvider {
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let resource = ProviderResourceId::from_bytes([tag; 16]);
    let model = ModelProfileId::from_bytes([tag; 16]);
    let network = NetworkPolicy::new(vec![
        PrivateNetworkRule::new(
            resource.clone(),
            &origin,
            vec!["127.0.0.1/32".parse().unwrap()],
        )
        .unwrap(),
    ])
    .unwrap();
    let keyring = Keyring::open(
        fixture.storage.store.clone(),
        KeyringLocation::External(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../notarium-control/tests/fixtures/keyring/native"),
        ),
        budget(),
    )
    .await
    .unwrap();
    let catalog = Arc::new(SystemAbilityCatalog::new(Arc::new(
        fixture.canonical.clone(),
    )));
    let provider = ProviderService::new(
        fixture.control.clone(),
        Arc::new(keyring),
        Arc::new(OutboundTransport::new(network)),
        catalog.clone(),
        ProviderConfig::default(),
    )
    .unwrap();
    let saved = provider
        .create_resource(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, human, tag).await,
                input: ProviderResourceSpec {
                    id: resource.clone(),
                    name: format!("Runtime fixture provider {tag}"),
                    wire: ProviderWireKind::Ollama,
                    base_url: origin,
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 10_000,
                },
            },
        )
        .await
        .unwrap();
    provider
        .put_model(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, human, tag + 1).await,
                input: PutProviderModel {
                    resource: resource.clone(),
                    expected: saved.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: model.clone(),
                        wire_name: MODEL.into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens,
                        max_output_tokens,
                        tools,
                    },
                },
            },
        )
        .await
        .unwrap();
    let resource = provider
        .list_resources(human.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == resource)
        .unwrap();
    assert_eq!(resource.default_model, None);
    let registry = Arc::new(ToolRegistry::new(
        Arc::new(ControlPlane::new(provider.clone())),
        catalog,
        Arc::new(TestEngine(
            fixture.canonical.clone(),
            fixture.projections.clone(),
        )),
        fixture.control.clone(),
    ));
    LoopbackProvider {
        provider,
        registry,
        resource,
        model,
    }
}

pub(super) async fn approve_disclosure(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    local: &LoopbackProvider,
    tag: u8,
    target: ProviderAttachmentTarget,
    classes: BTreeSet<DocClass>,
) {
    let consent = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: classes.clone(),
        })
    };
    let resource = &local.resource;
    let attachment = local
        .provider
        .request_attachment(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, human, tag).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([tag; 16]),
                    expected: None,
                    resource: resource.id.clone(),
                    resource_consent_epoch: resource.consent_epoch,
                    credential_consent_epoch: None,
                    target,
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    if attachment.state != ProviderAttachmentState::Approved {
        local
            .provider
            .approve_attachment(
                human.clone(),
                AccountMutation {
                    identity: identity(fixture, human, tag + 3).await,
                    input: ApproveProviderAttachment {
                        id: attachment.id,
                        expected: attachment.revision,
                        resource_consent_epoch: attachment.resource_consent_epoch,
                        credential_consent_epoch: attachment.credential_consent_epoch,
                        consent: consent(),
                    },
                },
            )
            .await
            .unwrap();
    }
}

fn request(
    tag: u8,
    selection: ProviderSelection,
    abilities: RuntimeAbilities,
) -> CompletionRequest {
    CompletionRequest {
        intent: CommandKey::from_bytes([tag; 16]),
        selection,
        secondary_projects: abilities.secondary_projects,
        messages: vec![CompletionMessage {
            role: CompletionRole::System,
            instruction: Some(
                ProviderInstruction::from_orchestrator("Use the active role.".into()).unwrap(),
            ),
            parts: abilities.parts,
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 4096,
            max_output_tokens: 256,
            max_tool_calls: 0,
        },
    }
}

async fn settle(provider: &ProviderService, scope: &SpaceContext, request: CompletionRequest) {
    let mut stream = provider.complete(scope.clone(), request).await.unwrap();
    let mut finished = false;
    while let Some(event) = stream.next().await.unwrap() {
        finished |= matches!(event, CompletionEvent::Finished(CompletionFinish::Stop));
    }
    assert!(finished);
}

async fn assert_denied(
    provider: &ProviderService,
    scope: &SpaceContext,
    source: &CompletionRequest,
    tag: u8,
    witnesses: Vec<FolderRef>,
) {
    let request = CompletionRequest {
        intent: CommandKey::from_bytes([tag; 16]),
        secondary_projects: witnesses,
        ..source.clone()
    };
    if let Ok(mut stream) = provider.complete(scope.clone(), request).await {
        stream
            .next()
            .await
            .expect_err("unadmitted ability project cannot reach the wire");
    }
}

async fn serve_completions(listener: TcpListener) -> Vec<Value> {
    let mut received = Vec::new();
    for _ in 0..2 {
        let (mut stream, body) = read_request(&listener).await;
        received.push(body);
        send_ollama(
            &mut stream,
            json!({"role":"assistant","content":"Verified"}),
            "stop",
        )
        .await;
    }
    received
}

pub(super) async fn read_request(listener: &TcpListener) -> (BufReader<TcpStream>, Value) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut stream = BufReader::new(socket);
    let mut first = String::new();
    stream.read_line(&mut first).await.unwrap();
    assert!(first.starts_with("POST /api/chat "));
    let mut length = None;
    loop {
        let mut header = String::new();
        assert!(stream.read_line(&mut header).await.unwrap() > 0);
        if header == "\r\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let length = length.unwrap();
    assert!(length < 256 * 1024);
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.unwrap();
    (stream, serde_json::from_slice(&bytes).unwrap())
}

pub(super) async fn begin_ollama_response(
    stream: &mut BufReader<TcpStream>,
    message: Value,
    reason: &str,
) -> String {
    let reply = format!(
        "{}\n{}\n",
        json!({"model":MODEL,"message":message,"done":false}),
        json!({"model":MODEL,"done":true,"done_reason":reason,"prompt_eval_count":100,"eval_count":2}),
    );
    stream.get_mut().write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).as_bytes()).await.unwrap();
    reply
}
pub(super) async fn send_ollama(stream: &mut BufReader<TcpStream>, message: Value, reason: &str) {
    let reply = begin_ollama_response(stream, message, reason).await;
    stream.get_mut().write_all(reply.as_bytes()).await.unwrap();
}

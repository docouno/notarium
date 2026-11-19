use super::*;
use crate::{
    keyring::{Keyring, KeyringLocation},
    outbound::test_https::{HttpsFixture, Reply, Request as HttpRequest},
    service::{AuthenticationMode, ControlConfig, ControlService},
    store::{
        ControlStore, PostgresConfig,
        target::{SecretKeyringRow, TargetRecord},
    },
    test_support::*,
};
use notarium_core::{
    auth::{ResourceFacts, SecretString},
    classes::*,
    document::ChunkDescriptor,
    epoch::DataRoot,
    model::*,
    span::ByteSpan,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
};

#[derive(Default)]
struct Egress {
    current: Mutex<Vec<ProviderCurrentContent>>,
    dependencies: Mutex<ProviderEgressDependencies>,
    deny: AtomicBool,
    active: Arc<AtomicUsize>,
    admitted: Arc<AtomicUsize>,
    cancellations: Mutex<Vec<Cancellation>>,
}
struct EgressLease {
    current: Vec<ProviderCurrentContent>,
    project: Option<FolderRef>,
    secondary_projects: Vec<FolderRef>,
    active: Arc<AtomicUsize>,
    admitted: Arc<AtomicUsize>,
    dispatched: bool,
    cancellation: Cancellation,
}
impl Drop for EgressLease {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}
impl ProviderEgressLease for EgressLease {
    fn current(&self) -> &[ProviderCurrentContent] {
        &self.current
    }
    fn project(&self) -> Option<&FolderRef> {
        self.project.as_ref()
    }
    fn secondary_projects(&self) -> &[FolderRef] {
        &self.secondary_projects
    }
    fn mark_dispatched(&mut self) {
        assert!(!std::mem::replace(&mut self.dispatched, true));
        self.admitted.fetch_add(1, Ordering::SeqCst);
    }
    fn check(&self) -> notarium_core::DomainResult<()> {
        if self.cancellation.is_cancelled() {
            Err(DomainError::AccessDenied)
        } else {
            Ok(())
        }
    }
}
impl ProviderEgressCatalogPort for Egress {
    fn chat_dependencies(
        &self,
        _: AccountContext,
        _: Vec<ProviderOrigin>,
    ) -> PortFuture<'_, ProviderEgressDependencies> {
        Box::pin(async move { Ok(self.dependencies.lock().unwrap().clone()) })
    }

    fn acquire_egress(
        &self,
        _: AccountContext,
        request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async move {
            if self.deny.load(Ordering::SeqCst) {
                return Err(DomainError::AccessDenied.into());
            }
            let current = self
                .current
                .lock()
                .unwrap()
                .iter()
                .filter(|item| request.origins.contains(&item.origin()))
                .cloned()
                .collect();
            self.active.fetch_add(1, Ordering::SeqCst);
            self.cancellations
                .lock()
                .unwrap()
                .push(cancellation.clone());
            Ok(Box::new(EgressLease {
                current,
                project: request.project,
                secondary_projects: request.secondary_projects,
                active: self.active.clone(),
                admitted: self.admitted.clone(),
                dispatched: false,
                cancellation,
            }) as Box<dyn ProviderEgressLease>)
        })
    }
}
struct Setup {
    fixture: Fixture,
    provider: ProviderService,
    other: ProviderService,
    other_store: ControlStore,
    ctx: AccountContext,
    space: SpaceContext,
    egress: Arc<Egress>,
    selection: ProviderSelection,
    document: ClassifiedDocument,
    revision: ControlRevision,
    credential: ProviderCredentialInfo,
    session: SecretString,
}
async fn keys(fixture: &mut Fixture) -> Arc<Keyring> {
    let value: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/keyring/vectors.json")).unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='migrating'")
        .await;
    fixture
        .store
        .import_target_batch(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            &[TargetRecord::from(SecretKeyringRow {
                key_id: value["keyId"].as_str().unwrap().into(),
                key_hash: value["keyHash"].as_str().unwrap().into(),
                generation: 1,
                state: "active".into(),
                canary: value["canaryEnvelope"].as_str().unwrap().into(),
                created_at: 0,
                retired_at: None,
            })],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    Arc::new(
        Keyring::open(
            fixture.store.clone(),
            KeyringLocation::External(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keyring/native"),
            ),
            budget(),
        )
        .await
        .unwrap(),
    )
}
impl Setup {
    async fn new(pg: bool, label: &str, kind: ProviderWireKind, server: &HttpsFixture) -> Self {
        let mut fixture = Fixture::new(pg, label).await;
        let keys = keys(&mut fixture).await;
        let control = fixture.service(AuthenticationMode::Password).await.unwrap();
        let bootstrap = control
            .bootstrap(
                empty(),
                budget(),
                BootstrapAccount {
                    username: "owner".into(),
                    email: None,
                    display_name: "Owner".into(),
                    password: Some(SecretString::new("initial password".into())),
                },
            )
            .await
            .unwrap();
        let owner = bootstrap.account.id;
        let personal = bootstrap.account.personal_space.unwrap();
        let session = bootstrap.session.unwrap().token;
        let ctx = AccountContext::new(
            control
                .resolve(evidence(AuthEvidenceKind::Session, session.expose()))
                .await
                .unwrap(),
            budget(),
        );
        let egress = Arc::new(Egress::default());
        let outbound = Arc::new(server.transport());
        let provider = ProviderService::new(
            control.clone(),
            keys.clone(),
            outbound.clone(),
            egress.clone(),
            super::super::ProviderConfig::default(),
        )
        .unwrap();
        let created = provider
            .create_credential(
                ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 1, bootstrap.account.revision),
                    input: NewProviderCredential {
                        id: CredentialId::from_bytes([1; 16]),
                        name: "Fixture".into(),
                        injection: CredentialInjection {
                            header: "Authorization".into(),
                            prefix: "Bearer ".into(),
                        },
                        secret: SecretString::new("fixture-secret".into()),
                        limits: ProviderLimits::default(),
                    },
                },
            )
            .await
            .unwrap();
        let credential = created.value;
        let resource = provider
            .create_resource(
                ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 2, created.revision),
                    input: ProviderResourceSpec {
                        id: ProviderResourceId::from_bytes([2; 16]),
                        name: "Fixture".into(),
                        wire: kind,
                        base_url: format!("{}/base", server.origin),
                        credential: Some(credential.id.clone()),
                        headers: vec![ProviderSecretHeader {
                            name: "X-Tenant-Key".into(),
                            value: SecretString::new("fixture-tenant".into()),
                        }],
                        limits: ProviderLimits::default(),
                        timeout_ms: 30_000,
                    },
                },
            )
            .await
            .unwrap();
        let mut revision = resource.revision;
        let mut resource_revision = resource.value.revision;
        for (index, model_kind) in [
            (3, ProviderModelKind::Completion),
            (4, ProviderModelKind::Embedding { dimension: 2 }),
        ] {
            let saved = provider
                .put_model(
                    ctx.clone(),
                    AccountMutation {
                        identity: command(&owner, &owner, index, revision),
                        input: PutProviderModel {
                            resource: resource.value.id.clone(),
                            expected: resource_revision,
                            model: ProviderModelSpec {
                                id: ModelProfileId::from_bytes([index; 16]),
                                wire_name: if index == 3 {
                                    "fixture-model"
                                } else {
                                    "fixture-embedding"
                                }
                                .into(),
                                kind: model_kind,
                                accounting: TokenAccountingProfile::ConservativeModelCapV1,
                                max_input_tokens: 8192,
                                max_output_tokens: if index == 3 { 128 } else { 0 },
                                tools: index == 3,
                            },
                            default: index == 3,
                        },
                    },
                )
                .await
                .unwrap();
            revision = saved.revision;
            resource_revision = provider
                .list_resources(ctx.clone(), ControlPageRequest::new(10, None).unwrap())
                .await
                .unwrap()
                .items[0]
                .revision;
        }
        let reviewed_resource = provider
            .list_resources(ctx.clone(), ControlPageRequest::new(10, None).unwrap())
            .await
            .unwrap()
            .items
            .remove(0);
        let attached = provider
            .request_attachment(
                ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 5, revision),
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([5; 16]),
                        expected: None,
                        resource: resource.value.id.clone(),
                        resource_consent_epoch: reviewed_resource.consent_epoch,
                        credential_consent_epoch: Some(credential.consent_epoch),
                        target: ProviderAttachmentTarget::Personal {
                            owner: owner.clone(),
                            space: personal.clone(),
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
        let catalog = fixture
            .catalog
            .space(budget(), personal.clone())
            .await
            .unwrap();
        let space = SpaceContext::new(ctx.auth().clone(), catalog.history, budget()).unwrap();
        let selection = provider
            .select_provider(
                space.clone(),
                SelectProvider {
                    kind: PreferenceModelKind::Completion,
                    resource: Some(resource.value.id),
                    model: Some(ModelProfileId::from_bytes([3; 16])),
                    project: None,
                },
            )
            .await
            .unwrap();
        let document = ClassifiedDocument::from_canonical(
            NoteRef {
                space_id: personal,
                note_id: NoteId::from_bytes([9; 16]),
            },
            RevisionId::from_bytes([9; 16]),
            ResourceFacts {
                space: catalog.space,
                class: DocClass::UserDoc,
                project: None,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: None,
            },
            Lifecycle::Active,
            "private source".into(),
            ContentDigest::from_bytes(*blake3::hash(b"private source").as_bytes()),
        )
        .unwrap();
        egress
            .current
            .lock()
            .unwrap()
            .push(ProviderCurrentContent::Note(document.metadata()));
        let other_store = if let Some(root) = &fixture.root {
            ControlStore::sqlite(&DataRoot::new(root)).await.unwrap()
        } else {
            let value: Value = serde_json::from_slice(
                &std::fs::read(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../../../.artifacts/control-db-fixture/active.json"),
                )
                .unwrap(),
            )
            .unwrap();
            ControlStore::postgres(PostgresConfig::unix_socket(
                PathBuf::from(value["socket"].as_str().unwrap()),
                &format!("auth_{label}"),
                "postgres",
            ))
            .await
            .unwrap()
        };
        let other_control = Arc::new(
            ControlService::open(
                other_store.clone(),
                fixture.catalog.clone(),
                fixture.revoker.clone(),
                fixture.clock.clone(),
                ControlConfig {
                    authentication: AuthenticationMode::Password,
                    resource_uri: "https://resource.example/".into(),
                    max_auth_spaces: 100,
                    schedule_limits: notarium_core::ports::control::RunLimits::HARD_CEILING,
                },
                budget(),
            )
            .await
            .unwrap(),
        );
        let other = ProviderService::new(
            other_control,
            keys,
            outbound,
            egress.clone(),
            super::super::ProviderConfig::default(),
        )
        .unwrap();
        Self {
            fixture,
            provider,
            other,
            other_store,
            ctx,
            space,
            egress,
            selection,
            document,
            revision: attached.revision,
            credential,
            session,
        }
    }
    fn completion(&self, id: u8) -> CompletionRequest {
        CompletionRequest {
            intent: CommandKey::from_bytes([id; 16]),
            selection: self.selection.clone(),
            secondary_projects: vec![],
            messages: vec![CompletionMessage {
                role: CompletionRole::User,
                instruction: None,
                parts: vec![ProviderMessage::Document(
                    ClassEgressFence::provider(
                        self.document.clone(),
                        self.ctx.auth(),
                        &self.selection.policy,
                    )
                    .unwrap(),
                )],
                tool_calls: vec![],
                result_for: None,
            }],
            tools: vec![],
            budget: CompletionBudget {
                max_input_tokens: 8192,
                max_output_tokens: 32,
                max_tool_calls: 0,
            },
        }
    }
    fn embedding(&self, id: u8) -> EmbeddingRequest {
        let document = Arc::new(self.document.clone());
        let part = ContentPart::from_chunk(
            document.clone(),
            ChunkDescriptor {
                source: document.digest(),
                model: ModelProfileId::from_bytes([4; 16]),
                context: vec![],
                spans: vec![ByteSpan::new(0, 14).unwrap()],
                text: "private source".into(),
                tokens: 3,
                key: ContentDigest::from_bytes([7; 32]),
            },
        )
        .unwrap();
        EmbeddingRequest {
            intent: CommandKey::from_bytes([id; 16]),
            model: ModelProfileId::from_bytes([4; 16]),
            provider: self.selection.provider.clone(),
            project: None,
            chunks: vec![
                ClassEgressFence::provider_part(part, self.ctx.auth(), &self.selection.policy)
                    .unwrap(),
            ],
            declared_tokens: 3,
        }
    }
    async fn close(self) {
        self.other_store.close().await;
        self.fixture.close().await;
    }
}
async fn complete(
    provider: &ProviderService,
    ctx: SpaceContext,
    request: CompletionRequest,
) -> Result<Vec<CompletionEvent>, PortError> {
    let mut stream = provider.complete(ctx, request).await?;
    let mut events = vec![];
    while let Some(event) = stream.next().await? {
        events.push(event);
    }
    Ok(events)
}

async fn compacted_history_dispatches_only_with_its_transitive_proof(setup: &Setup) {
    let note = ProviderCurrentContent::Note(setup.document.metadata());
    let space = note.space().unwrap().clone();
    let thread = ChatThreadId::from_bytes([11; 16]);
    let entry = |seq, text: &str, dependency| {
        let seq = ThreadEntrySeq::new(seq).unwrap();
        let digest = ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes());
        let proof = ChatProvenance {
            origins: vec![dependency],
            projects: vec![],
            compacts_through: None,
        };
        let current = ProviderCurrentContent::Chat {
            space: space.clone(),
            thread: thread.clone(),
            entry: seq,
            digest,
            project: None,
            lifecycle: Lifecycle::Active,
            tainted: false,
            group_author: None,
            provenance: Some(proof.clone()),
        };
        let content = CanonicalChatContent::from_canonical(
            space.clone(),
            thread.clone(),
            seq,
            false,
            text.into(),
            digest,
            None,
        )
        .with_provenance(Some(proof));
        (current, content)
    };
    let (model, _) = entry(1, "Earlier model", note.origin());
    let (compaction, summary) = entry(2, "Current summary", model.origin());
    setup
        .egress
        .current
        .lock()
        .unwrap()
        .extend([model, compaction]);
    let request = |key| {
        let mut request = setup.completion(key);
        request.messages[0].parts = vec![ProviderMessage::Chat(
            ClassEgressFence::chat(summary.clone(), setup.ctx.auth(), &setup.selection.policy)
                .unwrap(),
        )];
        request
    };
    assert!(
        complete(&setup.provider, setup.space.clone(), request(31))
            .await
            .is_err()
    );
    setup.egress.dependencies.lock().unwrap().origins = vec![note.origin()];
    assert!(
        complete(&setup.provider, setup.space.clone(), request(32))
            .await
            .is_ok()
    );
}

fn completion_reply(kind: ProviderWireKind, mode: u8) -> Reply {
    let input = if mode == 2 { 8193 } else { 7 };
    let output = if mode == 2 { 0 } else { 2 };
    if mode == 3 {
        return Reply {
            status: 0,
            headers: vec![],
            body: vec![],
        };
    }
    if mode == 4 {
        return Reply {
            status: 429,
            headers: vec![],
            body: b"secret upstream details".to_vec(),
        };
    }
    match kind {
        ProviderWireKind::OpenaiCompatible => {
            let usage = if mode == 1 {
                String::new()
            } else {
                format!(
                    "data: {}\n\n",
                    json!({"model":"fixture-model","choices":[],"usage":{"prompt_tokens":input,"completion_tokens":output,"total_tokens":input+output}})
                )
            };
            Reply{status:200,headers:vec![("Content-Type".into(),"text/event-stream".into())],body:format!("data: {}\n\n{usage}data: [DONE]\n\n",json!({"model":"fixture-model","choices":[{"index":0,"delta":{"content":"Hello 🦀"},"finish_reason":"stop"}]})).into_bytes()}
        }
        ProviderWireKind::Ollama => {
            let mut value = json!({"model":"fixture-model","message":{"role":"assistant","content":"Hello 🦀"},"done":true,"done_reason":"stop"});
            if mode != 1 {
                value["prompt_eval_count"] = input.into();
                value["eval_count"] = output.into();
            }
            Reply {
                status: 200,
                headers: vec![("Content-Type".into(), "application/x-ndjson".into())],
                body: format!("{value}\n").into_bytes(),
            }
        }
    }
}
async fn gateway(pg: bool, kind: ProviderWireKind, label: &str) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let requests = Arc::new(Mutex::new(Vec::<HttpRequest>::new()));
    let seen = requests.clone();
    let mode = Arc::new(AtomicU8::new(0));
    let response_mode = mode.clone();
    let server = HttpsFixture::start(move |request| {
        assert!(
            request
                .headers
                .to_lowercase()
                .contains("authorization: bearer fixture-secret")
        );
        assert!(
            request
                .headers
                .to_lowercase()
                .contains("x-tenant-key: fixture-tenant")
        );
        let reply = if request.path.ends_with("embeddings") || request.path.ends_with("api/embed") {
            Reply::json(match kind {
                ProviderWireKind::OpenaiCompatible => {
                    json!({"model":"fixture-embedding","data":[{"index":0,"embedding":[0.25,-0.5]}],"usage":{"prompt_tokens":3,"total_tokens":3}})
                }
                ProviderWireKind::Ollama => {
                    json!({"model":"fixture-embedding","embeddings":[[0.25,-0.5]],"prompt_eval_count":3})
                }
            })
        } else if request.method == "GET" {
            Reply::json(match kind {
                ProviderWireKind::OpenaiCompatible => json!({"data":[{"id":"fixture-model"}]}),
                ProviderWireKind::Ollama => json!({"models":[{"name":"fixture-model"}]}),
            })
        } else {
            completion_reply(kind, response_mode.load(Ordering::SeqCst))
        };
        seen.lock().unwrap().push(request);
        reply
    });
    let mut setup = Setup::new(pg, label, kind, &server).await;
    let (first, second) = tokio::join!(
        complete(&setup.provider, setup.space.clone(), setup.completion(10)),
        complete(&setup.other, setup.space.clone(), setup.completion(10))
    );
    assert_ne!(
        first.is_ok(),
        second.is_ok(),
        "exactly one call succeeds: {first:?} {second:?}"
    );
    let (events, error) = if let Ok(events) = first {
        (events, second.unwrap_err())
    } else {
        (second.unwrap(), first.unwrap_err())
    };
    assert!(
        matches!(
            error,
            PortError::Domain(DomainError::ProviderCallAlreadyStarted { .. })
        ),
        "{error:?}"
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(matches!(&events[0],CompletionEvent::Text(text) if text=="Hello 🦀"));
    assert!(matches!(
        events[1],
        CompletionEvent::Usage(ProviderUsage::Exact {
            input_tokens: 7,
            output_tokens: 2
        })
    ));
    assert!(matches!(
        events[2],
        CompletionEvent::Finished(CompletionFinish::Stop)
    ));
    assert_eq!(setup.fixture.observer.count("SELECT COUNT(*) FROM provider_budget_buckets WHERE rpm_used=1 AND tpm_reserved=0 AND tpm_exact=9").await,3);
    {
        let requests = requests.lock().unwrap();
        let request = &requests[0];
        assert_eq!(
            request.path,
            if kind == ProviderWireKind::OpenaiCompatible {
                "/base/chat/completions"
            } else {
                "/base/api/chat"
            }
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "private source");
    }
    let embedding = setup
        .provider
        .embed(setup.space.clone(), setup.embedding(11))
        .await
        .unwrap();
    assert_eq!(embedding.vectors, vec![Ok(vec![0.25, -0.5])]);
    assert_eq!(
        embedding.usage,
        ProviderUsage::Exact {
            input_tokens: 3,
            output_tokens: 0
        }
    );
    let probe = ProviderAdminPort::check_connection(
        &setup.provider,
        setup.ctx.clone(),
        CheckProviderConnection {
            resource: setup.selection.provider.clone(),
            intent: CommandKey::from_bytes([12; 16]),
        },
    )
    .await
    .unwrap();
    let status = setup
        .provider
        .inspect_call(setup.ctx.clone(), probe.call)
        .await
        .unwrap();
    assert_eq!(status.model, None);
    assert_eq!(status.reserved_tokens, 0);
    assert_eq!(
        status.usage,
        ProviderUsage::Exact {
            input_tokens: 0,
            output_tokens: 0
        }
    );
    setup.egress.deny.store(true, Ordering::SeqCst);
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(13))
            .await
            .is_err()
    );
    assert_eq!(requests.lock().unwrap().len(), 3);
    setup.egress.deny.store(false, Ordering::SeqCst);
    mode.store(1, Ordering::SeqCst);
    let events = complete(&setup.provider, setup.space.clone(), setup.completion(14))
        .await
        .unwrap();
    assert!(matches!(
        events[1],
        CompletionEvent::Usage(ProviderUsage::Unknown)
    ));
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_budget_buckets WHERE tpm_reserved=41")
            .await,
        3
    );
    mode.store(4, Ordering::SeqCst);
    assert!(matches!(
        complete(&setup.provider, setup.space.clone(), setup.completion(15)).await,
        Err(PortError::Domain(DomainError::Provider {
            error: ProviderErrorCode::UpstreamRateLimit
        }))
    ));
    mode.store(3, Ordering::SeqCst);
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(16))
            .await
            .is_err()
    );
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_budget_buckets WHERE tpm_reserved=123")
            .await,
        3
    );
    mode.store(2, Ordering::SeqCst);
    let over_events = complete(&setup.provider, setup.space.clone(), setup.completion(17))
        .await
        .unwrap();
    assert!(matches!(
        over_events[1],
        CompletionEvent::Usage(ProviderUsage::Exact {
            input_tokens: 8193,
            output_tokens: 0
        })
    ));
    assert_eq!(setup.fixture.observer.count("SELECT COUNT(*) FROM provider_call_log WHERE outcome='completed' AND diagnostic='budget_mismatch' AND input_tokens=8193 AND output_tokens=0").await,1);
    mode.store(0, Ordering::SeqCst);
    assert!(
        complete(&setup.provider, setup.space.clone(), setup.completion(18))
            .await
            .is_ok(),
        "budget_mismatch records audit spend without cross-user 60s DoS lockout"
    );
    let before_history = requests.lock().unwrap().len();
    compacted_history_dispatches_only_with_its_transitive_proof(&setup).await;
    assert_eq!(requests.lock().unwrap().len(), before_history + 1);
    let count = requests.lock().unwrap().len();
    // A retry still resolves the old intent after mutable configuration changes.
    let changed = setup
        .other
        .update_credential(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(
                    setup.ctx.auth().principal(),
                    setup.ctx.auth().principal(),
                    20,
                    setup.revision,
                ),
                input: UpdateProviderCredential {
                    id: setup.credential.id.clone(),
                    expected: setup.credential.revision,
                    name: "Rotated".into(),
                    injection: setup.credential.injection.clone(),
                    secret: Some(SecretString::new("replacement".into())),
                    limits: ProviderLimits::default(),
                    disabled: false,
                },
            },
        )
        .await
        .unwrap();
    setup.revision = changed.revision;
    assert!(matches!(
        complete(&setup.provider, setup.space.clone(), setup.completion(10)).await,
        Err(PortError::Domain(DomainError::ProviderCallAlreadyStarted {
            state: ProviderDeliveryState::Settled,
            ..
        }))
    ));
    let mut modified = setup.completion(10);
    modified.budget.max_output_tokens = 31;
    assert!(matches!(
        complete(&setup.provider, setup.space.clone(), modified).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    assert_eq!(requests.lock().unwrap().len(), count);
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    setup.close().await;
}
#[tokio::test]
async fn sqlite_openai_gateway() {
    gateway(false, ProviderWireKind::OpenaiCompatible, "dispatch_openai").await;
}
#[tokio::test]
async fn postgres_openai_gateway() {
    gateway(true, ProviderWireKind::OpenaiCompatible, "dispatch_openai").await;
}
#[tokio::test]
async fn sqlite_ollama_gateway() {
    gateway(false, ProviderWireKind::Ollama, "dispatch_ollama").await;
}
#[tokio::test]
async fn postgres_ollama_gateway() {
    gateway(true, ProviderWireKind::Ollama, "dispatch_ollama").await;
}

#[path = "admission_tests.rs"]
mod admissions;
#[path = "lifecycle_tests.rs"]
mod lifecycle;
#[path = "shared_tests.rs"]
mod shared;

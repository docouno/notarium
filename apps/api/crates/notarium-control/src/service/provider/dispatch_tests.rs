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
    auth::{BranchTaint, ResourceFacts, SecretString},
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
    deny: AtomicBool,
    active: Arc<AtomicUsize>,
    cancellations: Mutex<Vec<Cancellation>>,
}
struct EgressLease {
    project_folders: BTreeSet<FolderId>,
    current: Vec<ProviderCurrentContent>,
    project: Option<FolderRef>,
    active: Arc<AtomicUsize>,
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
    fn project_folders(&self) -> &BTreeSet<FolderId> {
        &self.project_folders
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
                project_folders: request.project_folders,
                current,
                project: request.project,
                active: self.active.clone(),
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
    revoker: Arc<TaintOnRegistration>,
}

struct TaintOnRegistration {
    inner: Arc<dyn SessionRevocationPort>,
    next: Mutex<Option<BranchTaint>>,
}

impl SessionRevocationPort for TaintOnRegistration {
    fn register_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async move {
            let lease = self
                .inner
                .register_provider(ctx, selectors, cancellation)
                .await?;
            if let Some(taint) = self.next.lock().unwrap().take() {
                taint.mark_external_read();
            }
            Ok(lease)
        })
    }

    fn fence_provider(
        &self,
        ctx: MaintenanceContext,
        selectors: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        self.inner.fence_provider(ctx, selectors)
    }

    fn fence_inactive_provider(
        &self,
        ctx: MaintenanceContext,
        call: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        self.inner.fence_inactive_provider(ctx, call)
    }

    fn revoke(
        &self,
        ctx: MaintenanceContext,
        selector: RevocationSelector,
        reason: RevocationReason,
    ) -> PortFuture<'_, ()> {
        self.inner.revoke(ctx, selector, reason)
    }
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
        let mut control = fixture.service(AuthenticationMode::Password).await.unwrap();
        let revoker = Arc::new(TaintOnRegistration {
            inner: control.revoker.clone(),
            next: Mutex::new(None),
        });
        Arc::get_mut(&mut control).unwrap().revoker = revoker.clone();
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
            revoker,
        }
    }
    fn completion(&self, id: u8) -> CompletionRequest {
        CompletionRequest {
            intent: CommandKey::from_bytes([id; 16]),
            selection: self.selection.clone(),
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
    fn embedding(&self, id: u8, document: &ClassifiedDocument) -> EmbeddingRequest {
        let document = Arc::new(document.clone());
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
        EmbeddingRequest::parts(
            CommandKey::from_bytes([id; 16]),
            ModelProfileId::from_bytes([4; 16]),
            self.selection.provider.clone(),
            None,
            vec![
                ClassEgressFence::provider_part(part, self.ctx.auth(), &self.selection.policy)
                    .unwrap(),
            ],
            3,
        )
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
        let headers = request.headers.to_lowercase();
        let rotated = headers.contains("authorization: bearer replacement");
        assert!(rotated || headers.contains("authorization: bearer fixture-secret"));
        assert!(
            request
                .headers
                .to_lowercase()
                .contains("x-tenant-key: fixture-tenant")
        );
        let reply = if request.path.ends_with("embeddings") || request.path.ends_with("api/embed") {
            let vector = if rotated { [0.5, 0.25] } else { [0.25, -0.5] };
            Reply::json(match kind {
                ProviderWireKind::OpenaiCompatible => {
                    json!({"model":"fixture-embedding","data":[{"index":0,"embedding":vector}],"usage":{"prompt_tokens":3,"total_tokens":3}})
                }
                ProviderWireKind::Ollama => {
                    json!({"model":"fixture-embedding","embeddings":[vector],"prompt_eval_count":3})
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
        .embed(setup.space.clone(), setup.embedding(11, &setup.document))
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
    let query = |intent, class| {
        EmbeddingRequest::query(
            CommandKey::from_bytes([intent; 16]),
            ModelProfileId::from_bytes([4; 16]),
            setup.selection.provider.clone(),
            EmbeddingQueryInput {
                text: "related search".into(),
                tokens: 3,
                classes: BTreeSet::from([class]),
                project_scope: None,
                folder: None,
            },
        )
    };
    let disclosed = setup
        .provider
        .query_disclosure(
            setup.space.clone(),
            setup.selection.provider.clone(),
            ModelProfileId::from_bytes([4; 16]),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(disclosed, BTreeSet::from([DocClass::UserDoc]));
    let result = setup
        .provider
        .embed(
            setup.space.clone(),
            query(100, DocClass::UserDoc).with_runtime_epochs(setup.selection.runtime_epochs),
        )
        .await
        .unwrap();
    assert_eq!(result.vectors, vec![Ok(vec![0.25, -0.5])]);
    {
        let requests = requests.lock().unwrap();
        let body: Value = serde_json::from_slice(&requests.last().unwrap().body).unwrap();
        assert_eq!(body["input"], json!(["related search"]));
    }
    let (indexing, _) = setup
        .provider
        .admit_search_indexing(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            &PrincipalId::from_bytes([100; 16]),
            &setup.selection.provider,
            None,
            budget(),
        )
        .await
        .unwrap()
        .expect("personal owner is eligible");
    assert_eq!(indexing.auth().principal(), setup.space.auth().principal());
    assert_eq!(
        indexing.auth().kind(),
        &notarium_core::auth::PrincipalKind::SearchIndexing
    );
    assert!(indexing.auth().authorize_human_management().is_err());
    assert!(
        !indexing.auth().spaces()[&indexing.scope().space_id]
            .read_classes
            .contains(&DocClass::EncryptedNote)
    );
    assert!(
        indexing.auth().spaces()[&indexing.scope().space_id]
            .write_classes
            .is_empty()
    );
    // SearchIndexing authority is restricted to internal document embedding
    // dispatch and must be rejected across ControlService and non-embedding
    // ProviderService entrypoints without issuing egress or HTTP traffic.
    let before_rejected = requests.lock().unwrap().len();
    let before_egress = setup.egress.cancellations.lock().unwrap().len();
    let indexing_account = AccountContext::new(indexing.auth().clone(), budget());
    let control = setup.provider.control_service();
    assert!(matches!(
        control.whoami(indexing_account.clone()).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .list_spaces(
                indexing_account.clone(),
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .list_favorites(
                indexing_account.clone(),
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .begin_agent_call(
                indexing_account.clone(),
                BeginAgentCall {
                    call: RequestId::from_bytes([120; 16]),
                    request: RequestId::from_bytes([121; 16]),
                    episode: None,
                    operation: AgentOperation::Search,
                    transport: AgentTransport::Internal,
                    effect: AgentEffect::Read,
                    input_bytes: 0,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .start_or_resume_episode(
                indexing_account.clone(),
                AccountMutation {
                    identity: command(
                        indexing.auth().principal(),
                        indexing.auth().principal(),
                        122,
                        setup.revision,
                    ),
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: EpisodeId::from_bytes([122; 16]),
                            name: None,
                        },
                        project_hint: None,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        setup
            .provider
            .inspect_call(indexing_account.clone(), RequestId::from_bytes([123; 16]))
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        setup
            .provider
            .select_provider(
                indexing.clone(),
                SelectProvider {
                    kind: PreferenceModelKind::Embedding,
                    resource: Some(setup.selection.provider.clone()),
                    model: Some(ModelProfileId::from_bytes([4; 16])),
                    project: None,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        setup
            .provider
            .query_disclosure(
                indexing.clone(),
                setup.selection.provider.clone(),
                ModelProfileId::from_bytes([4; 16]),
                None,
                None,
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        complete(&setup.provider, indexing.clone(), setup.completion(124)).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        setup
            .provider
            .check_connection(
                indexing_account,
                CheckProviderConnection {
                    resource: setup.selection.provider.clone(),
                    intent: CommandKey::from_bytes([125; 16]),
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        setup
            .provider
            .embed(
                indexing.clone(),
                query(126, DocClass::UserDoc).with_runtime_epochs(setup.selection.runtime_epochs),
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let foreign_provider = ProviderResourceId::from_bytes([99; 16]);
    let mut foreign_policy = setup.selection.policy.clone();
    foreign_policy.provider = foreign_provider.clone();
    let foreign_doc = Arc::new(setup.document.clone());
    let foreign_part = ContentPart::from_chunk(
        foreign_doc.clone(),
        ChunkDescriptor {
            source: foreign_doc.digest(),
            model: ModelProfileId::from_bytes([4; 16]),
            context: vec![],
            spans: vec![ByteSpan::new(0, 14).unwrap()],
            text: "private source".into(),
            tokens: 3,
            key: ContentDigest::from_bytes([7; 32]),
        },
    )
    .unwrap();
    let wrong_provider = EmbeddingRequest::parts(
        CommandKey::from_bytes([127; 16]),
        ModelProfileId::from_bytes([4; 16]),
        foreign_provider,
        None,
        vec![
            ClassEgressFence::provider_part(foreign_part, indexing.auth(), &foreign_policy)
                .unwrap(),
        ],
        3,
    )
    .with_runtime_epochs(ProviderRuntimeEpochs {
        resource: std::num::NonZeroU64::new(999).unwrap(),
        credential: std::num::NonZeroU64::new(999),
    });
    assert!(wrong_provider.validate().is_ok());
    assert!(matches!(
        setup.provider.embed(indexing.clone(), wrong_provider).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let wrong_space_auth = notarium_core::auth::EngineAuthContext::for_search_indexing(
        indexing.auth().principal().clone(),
        indexing.auth().grant().clone(),
        SpaceId::from_bytes([98; 16]),
        setup.selection.provider.clone(),
    );
    let mut wrong_space_grants = setup.space.auth().spaces().clone();
    wrong_space_grants.extend(wrong_space_auth.spaces().clone());
    let wrong_space_forged = notarium_core::auth::EngineAuthContext::for_human(
        notarium_core::auth::VerifiedHuman::attest(
            indexing.auth().principal().clone(),
            indexing.auth().grant().clone(),
            wrong_space_grants,
            false,
        )
        .with_credential(
            notarium_core::auth::AuthenticatedCredential::SearchIndexing {
                space: SpaceId::from_bytes([98; 16]),
                provider: setup.selection.provider.clone(),
            },
        ),
    );
    let wrong_space_ctx =
        SpaceContext::new(wrong_space_forged, setup.space.scope().clone(), budget()).unwrap();
    assert!(matches!(
        setup
            .provider
            .embed(wrong_space_ctx, setup.embedding(128, &setup.document))
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert_eq!(requests.lock().unwrap().len(), before_rejected);
    assert_eq!(
        setup.egress.cancellations.lock().unwrap().len(),
        before_egress
    );
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    // Narrowed caller read_classes constrain both query_disclosure and EmbeddingInput::Query.
    let mut narrowed_grants = setup.space.auth().spaces().clone();
    narrowed_grants
        .get_mut(&setup.space.scope().space_id)
        .unwrap()
        .read_classes = BTreeSet::from([DocClass::AgentMemory]);
    let narrowed_auth = setup.space.auth().for_pat(narrowed_grants).unwrap();
    let narrowed_space =
        SpaceContext::new(narrowed_auth, setup.space.scope().clone(), budget()).unwrap();
    assert!(
        setup
            .provider
            .query_disclosure(
                narrowed_space.clone(),
                setup.selection.provider.clone(),
                ModelProfileId::from_bytes([4; 16]),
                None,
                None,
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        setup
            .provider
            .embed(
                narrowed_space,
                query(111, DocClass::UserDoc).with_runtime_epochs(setup.selection.runtime_epochs),
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::ClassEgressForbidden
    ));
    // Deterministic 2-step search embedding resolution for Personal Space.
    let embedding_model = ModelProfileId::from_bytes([4; 16]);
    let explicit_resolved = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            Some(embedding_model.clone()),
            budget(),
        )
        .await
        .unwrap()
        .expect("explicit personal embedding model resolves");
    assert_eq!(explicit_resolved.provider, setup.selection.provider);
    assert_eq!(explicit_resolved.model, embedding_model);
    assert_eq!(explicit_resolved.dimension, 2);
    assert_eq!(explicit_resolved.max_input_tokens, 8192);
    assert_eq!(explicit_resolved.project, None);
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
        "without an embedding preference, resolution returns Ok(None)"
    );
    let pref = setup
        .provider
        .set_preference(
            setup.ctx.clone(),
            AccountMutation {
                identity: command(
                    setup.ctx.auth().principal(),
                    setup.ctx.auth().principal(),
                    19,
                    setup.revision,
                ),
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Embedding,
                    resource: setup.selection.provider.clone(),
                    model: embedding_model.clone(),
                },
            },
        )
        .await
        .unwrap();
    setup.revision = pref.revision;
    let pref_resolved = setup
        .provider
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            setup.space.scope().clone(),
            None,
            budget(),
        )
        .await
        .unwrap()
        .expect("personal owner embedding preference resolves for personal Space");
    assert_eq!(pref_resolved, explicit_resolved);
    assert!(
        setup
            .provider
            .embed(indexing.clone(), setup.embedding(101, &setup.document))
            .await
            .is_ok()
    );
    // Personal consent covers the whole Space. Search still binds a selected
    // project to both the original part and the metadata held by the lease.
    let project = FolderRef {
        space_id: indexing.scope().space_id.clone(),
        folder_id: FolderId::from_bytes([17; 16]),
    };
    setup
        .fixture
        .catalog
        .project_entries
        .lock()
        .unwrap()
        .insert(
            (project.space_id.clone(), project.folder_id.clone()),
            ProjectInfo {
                folder: project.clone(),
                name: "Selected project".into(),
            },
        );
    let space = setup
        .fixture
        .catalog
        .space(budget(), project.space_id.clone())
        .await
        .unwrap();
    let inside = ClassifiedDocument::from_canonical(
        setup.document.reference().clone(),
        setup.document.revision().clone(),
        ResourceFacts {
            space: space.space,
            class: DocClass::UserDoc,
            ancestor_folders: vec![project.folder_id.clone()],
            folder_write_locked: false,
            ability_package: None,
        },
        Lifecycle::Active,
        setup
            .document
            .explicit_read(setup.ctx.auth())
            .unwrap()
            .to_owned(),
        setup.document.digest(),
    )
    .unwrap();
    let mut scoped = setup.embedding(109, &inside);
    scoped.project = Some(project.clone());
    let before = requests.lock().unwrap().len();
    assert!(matches!(
        setup.provider.embed(indexing.clone(), scoped).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert_eq!(requests.lock().unwrap().len(), before);
    *setup.egress.current.lock().unwrap() = vec![ProviderCurrentContent::Note(inside.metadata())];
    let mut scoped = setup.embedding(110, &inside);
    scoped.project = Some(project);
    assert!(setup.provider.embed(indexing.clone(), scoped).await.is_ok());
    *setup.egress.current.lock().unwrap() =
        vec![ProviderCurrentContent::Note(setup.document.metadata())];
    let count = requests.lock().unwrap().len();
    let stale_epochs = ProviderRuntimeEpochs {
        resource: (setup.selection.runtime_epochs.resource.get() + 1)
            .try_into()
            .unwrap(),
        ..setup.selection.runtime_epochs
    };
    assert!(
        setup
            .provider
            .embed(
                setup.space.clone(),
                query(106, DocClass::UserDoc).with_runtime_epochs(stale_epochs),
            )
            .await
            .is_err()
    );
    assert_eq!(requests.lock().unwrap().len(), count);
    assert!(matches!(
        setup
            .provider
            .embed(indexing, query(102, DocClass::UserDoc))
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(
        setup
            .provider
            .embed(setup.space.clone(), query(103, DocClass::Profile))
            .await
            .is_err()
    );
    let auth = setup
        .provider
        .control
        .resolve(evidence(AuthEvidenceKind::Session, setup.session.expose()))
        .await
        .unwrap();
    auth.taint().mark_external_read();
    let tainted = SpaceContext::new(auth, setup.space.scope().clone(), budget()).unwrap();
    assert!(matches!(
        setup
            .provider
            .embed(tainted, query(104, DocClass::UserDoc))
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    assert_eq!(requests.lock().unwrap().len(), count);
    let auth = setup
        .provider
        .control
        .resolve(evidence(AuthEvidenceKind::Session, setup.session.expose()))
        .await
        .unwrap();
    let racing = SpaceContext::new(auth, setup.space.scope().clone(), budget()).unwrap();
    *setup.revoker.next.lock().unwrap() = Some(racing.auth().taint().clone());
    assert!(matches!(
        setup
            .provider
            .embed(racing, query(105, DocClass::UserDoc))
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted)),
    ));
    assert_eq!(requests.lock().unwrap().len(), count);
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
    let rotated = setup
        .provider
        .select_provider(
            setup.space.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Embedding,
                resource: Some(setup.selection.provider.clone()),
                model: Some(ModelProfileId::from_bytes([4; 16])),
                project: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rotated.runtime_epochs.resource,
        setup.selection.runtime_epochs.resource
    );
    assert_ne!(
        rotated.runtime_epochs.credential,
        setup.selection.runtime_epochs.credential
    );
    assert!(
        setup
            .provider
            .embed(
                setup.space.clone(),
                query(107, DocClass::UserDoc).with_runtime_epochs(setup.selection.runtime_epochs),
            )
            .await
            .is_err()
    );
    assert_eq!(requests.lock().unwrap().len(), count);
    let fresh = setup
        .provider
        .embed(
            setup.space.clone(),
            query(108, DocClass::UserDoc).with_runtime_epochs(rotated.runtime_epochs),
        )
        .await
        .unwrap();
    assert_eq!(fresh.vectors, vec![Ok(vec![0.5, 0.25])]);
    assert_eq!(requests.lock().unwrap().len(), count + 1);
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
    assert_eq!(requests.lock().unwrap().len(), count + 1);
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
#[path = "default_tests.rs"]
mod defaults;
#[path = "lifecycle_tests.rs"]
mod lifecycle;
#[path = "shared_tests.rs"]
mod shared;

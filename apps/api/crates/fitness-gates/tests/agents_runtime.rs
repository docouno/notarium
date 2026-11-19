//! Exercise agent entry points with the real control and canonical owners.
#[path = "agents_runtime/abilities.rs"]
mod ability_cases;
#[path = "agents_runtime/engine.rs"]
mod engine;
#[allow(dead_code)]
#[path = "../../notarium-control/tests/support/mod.rs"]
mod support;

use engine::TestEngine;
use notarium_agents::{
    abilities::SystemAbilityCatalog,
    mcp::{EgressTarget, McpInvocationContext, McpToolResult, ToolRegistry},
};
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, PgConnectConfig, PgTransport,
    SqlBackendConfig,
};
use notarium_control::{
    keyring::{Keyring, KeyringLocation},
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlConfig, ControlPlane, ControlService,
        provider::{ProviderConfig, ProviderService},
    },
    store::TargetRecord,
};
use notarium_core::{
    DomainError,
    epoch::DataRoot,
    error::PortError,
    ids::*,
    ports::*,
    receipt::{CausalBasis, CommandIdentity},
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
use support::{Fixture, budget};

struct RuntimeFixture {
    storage: Fixture,
    canonical: CanonicalStore,
    runtime: CanonicalRuntime,
    control: Arc<ControlService>,
    registry: ToolRegistry,
    human: AccountContext,
    temporary_blob_root: Option<PathBuf>,
}

impl RuntimeFixture {
    async fn open(pg: bool) -> Self {
        let mut storage = Fixture::new(pg, "agents_runtime").await;
        let keyring = fixture_keyring(&mut storage).await;
        let root = storage.root.clone().unwrap_or_else(|| {
            let mut nonce = [0_u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap())
                .join("control-tests")
                .join(RequestId::from_bytes(nonce).as_str())
        });
        let mut config = CanonicalConfig::local_default(
            InstallationId::from_bytes([1; 16]),
            DataRoot::new(&root),
        );
        if pg {
            let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../.artifacts/control-db-fixture/active.json");
            let fixture: Value =
                serde_json::from_slice(&std::fs::read(descriptor).unwrap()).unwrap();
            config.sql = SqlBackendConfig::postgres_default(
                PgConnectConfig {
                    transport: PgTransport::UnixSocket {
                        socket_dir: fixture["socket"].as_str().unwrap().into(),
                        port: 5432,
                    },
                    username: "postgres".into(),
                    password: String::new(),
                    database: "auth_agents_runtime".into(),
                },
                "v1_canonical",
            );
            config.default_backup_budget =
                notarium_canonical::config::default_postgres_backup_budget();
        }
        let (canonical, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let catalog = Arc::new(SystemAbilityCatalog::new(Arc::new(canonical.clone())));
        let owner = PrincipalId::from_bytes([4; 16]);
        let control = Arc::new(
            ControlService::open(
                storage.store.clone(),
                catalog.clone(),
                storage.revoker.clone(),
                storage.clock.clone(),
                ControlConfig {
                    authentication: AuthenticationMode::TrustedNone { owner },
                    resource_uri: "https://resource.example/".into(),
                    max_auth_spaces: 100,
                    schedule_limits: notarium_core::ports::schedules::RunLimits::HARD_CEILING,
                },
                budget(),
            )
            .await
            .unwrap(),
        );
        control
            .bootstrap(
                support::empty(),
                budget(),
                BootstrapAccount {
                    username: "owner".into(),
                    email: None,
                    display_name: "Owner".into(),
                    password: None,
                },
            )
            .await
            .unwrap();
        let human = AccountContext::new(
            control
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
        let provider = ProviderService::new(
            control.clone(),
            keyring,
            Arc::new(OutboundTransport::new(NetworkPolicy::default())),
            catalog.clone(),
            ProviderConfig::default(),
        )
        .unwrap();
        let registry = ToolRegistry::new(
            Arc::new(ControlPlane::new(provider)),
            catalog,
            Arc::new(TestEngine(canonical.clone())),
            control.clone(),
        );
        Self {
            storage,
            canonical,
            runtime,
            control,
            registry,
            human,
            temporary_blob_root: pg.then_some(root),
        }
    }

    async fn pat(&self, scope: BearerScope, ability_write: bool) -> AccountContext {
        let account = self
            .control
            .account(self.human.clone(), self.human.auth().principal().clone())
            .await
            .unwrap();
        let issued = self
            .control
            .create_pat(
                self.human.clone(),
                CreatePat {
                    name: format!("fixture {scope:?} {ability_write}"),
                    scope,
                    ability_write,
                    selected_spaces: None,
                    expires_at_ms: None,
                    expected: account.revision,
                },
            )
            .await
            .unwrap();
        AccountContext::new(
            self.control
                .resolve(PreAuthContext {
                    budget: budget(),
                    evidence: AuthEvidence::new(
                        AuthEvidenceKind::Pat,
                        issued.value.token.expose().to_owned(),
                    ),
                })
                .await
                .unwrap(),
            budget(),
        )
    }

    async fn close(self) {
        let Self {
            storage,
            canonical,
            runtime,
            control,
            registry,
            temporary_blob_root,
            ..
        } = self;
        drop(registry);
        drop(control);
        drop(canonical);
        runtime.shutdown().await.unwrap();
        storage.close().await;
        if let Some(root) = temporary_blob_root {
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

async fn fixture_keyring(fixture: &mut Fixture) -> Arc<Keyring> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../notarium-control/tests/fixtures/keyring");
    let witness: Value =
        serde_json::from_slice(&std::fs::read(directory.join("vectors.json")).unwrap()).unwrap();
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
            &[TargetRecord::SecretKeyring {
                key_id: witness["keyId"].as_str().unwrap().into(),
                key_hash: witness["keyHash"].as_str().unwrap().into(),
                generation: 1,
                state: "active".into(),
                canary: witness["canaryEnvelope"].as_str().unwrap().into(),
                created_at: 0,
                retired_at: None,
            }],
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
            KeyringLocation::External(directory.join("native")),
            budget(),
        )
        .await
        .unwrap(),
    )
}

async fn call(
    fixture: &RuntimeFixture,
    account: &AccountContext,
    key: u8,
    tool: &str,
    args: Value,
) -> Result<McpToolResult, PortError> {
    fixture
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(account.auth().clone(), budget()),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([key; 16]),
            },
            tool,
            args,
        )
        .await
}

async fn external_registry_and_memory(pg: bool) {
    let fixture = RuntimeFixture::open(pg).await;
    let read = fixture.pat(BearerScope::Read, false).await;
    let write = fixture.pat(BearerScope::Write, false).await;
    let author = fixture.pat(BearerScope::Write, true).await;
    let read_tools = fixture
        .registry
        .list_tools(read.clone(), &EgressTarget::ExternalMcp)
        .await
        .unwrap();
    assert_eq!(read_tools.len(), 12);
    assert_eq!(
        fixture
            .registry
            .list_tools(write.clone(), &EgressTarget::ExternalMcp)
            .await
            .unwrap()
            .len(),
        28
    );
    assert!(
        read_tools
            .iter()
            .all(|tool| !tool.annotations.open_world_hint)
    );
    assert!(matches!(
        call(&fixture, &read, 1, "create_ability", json!({})).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        call(&fixture, &write, 2, "create_ability", json!({})).await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));
    let builtin = call(
        &fixture,
        &read,
        3,
        "list_abilities",
        json!({"view":"authoring", "source":"system"}),
    )
    .await
    .unwrap();
    assert!(builtin.content[0].text.contains("research-evidence"));

    let args = json!({
        "kind":"role", "name":"fixture-guide", "description":"A fixture role",
        "instructions":"Inspect the fixtures.", "placement":{"home":"personal"}
    });
    let created = call(&fixture, &author, 4, "create_ability", args.clone())
        .await
        .unwrap();
    let reference = created.structured_content["ref"].as_str().unwrap();
    let replay = call(&fixture, &author, 4, "create_ability", args)
        .await
        .unwrap();
    assert_eq!(replay.structured_content["ref"], reference);
    let inspected = call(&fixture, &read, 5, "get_ability", json!({"ref":reference}))
        .await
        .unwrap();
    assert!(inspected.content[0].text.contains("Inspect the fixtures."));

    let memory =
        json!({"observation":"The fixture commits one observation.", "summary":"One observation"});
    let written = call(&fixture, &write, 6, "remember_about_user", memory.clone())
        .await
        .unwrap();
    let remembered = call(&fixture, &write, 6, "remember_about_user", memory)
        .await
        .unwrap();
    assert_eq!(
        written.structured_content["noteId"],
        remembered.structured_content["noteId"]
    );
    let note = NoteId::parse(written.structured_content["noteId"].as_str().unwrap()).unwrap();
    let space = fixture
        .control
        .list_spaces(
            fixture.human.clone(),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .pop()
        .unwrap();
    let scoped = SpaceContext::new(fixture.human.auth().clone(), space.history, budget()).unwrap();
    let snapshot = fixture
        .canonical
        .get_note(
            scoped.clone(),
            GetNote {
                note,
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    let body = snapshot
        .document
        .explicit_read(fixture.human.auth())
        .unwrap();
    assert_eq!(
        body.matches("The fixture commits one observation.").count(),
        1
    );
    assert!(body.contains("One observation"));
    session_delivery_is_lossless(&fixture, &read, &scoped).await;
    ability_cases::overrides_and_promotion(&fixture).await;
    fixture.close().await;
}

async fn session_delivery_is_lossless(
    fixture: &RuntimeFixture,
    reader: &AccountContext,
    scope: &SpaceContext,
) {
    let mut expected = BTreeSet::new();
    for tag in 20..=42 {
        expected.insert(append_note(fixture, scope, tag).await.to_string());
    }
    let cutoff = fixture
        .canonical
        .read_space(&scope.scope().space_id)
        .await
        .unwrap()
        .last_seq;
    let mut page = call(
        fixture,
        reader,
        60,
        "start_session",
        json!({"task":"Verify deliveries"}),
    )
    .await
    .unwrap();
    let episode =
        EpisodeId::parse(page.structured_content["session"]["id"].as_str().unwrap()).unwrap();
    assert!(page.content[0].text.contains("continue_"));
    assert!(owner_ack(fixture, reader, episode.clone(), scope).await < cutoff);
    let late = append_note(fixture, scope, 43).await.to_string();

    let mut seen = BTreeSet::new();
    let mut key = 61;
    let final_receipt = loop {
        let delta = &page.structured_content["delta"];
        let changes = delta["changes"].as_array().unwrap();
        assert!(changes.len() <= 20);
        for note in changes
            .iter()
            .filter_map(|change| change["noteId"].as_str())
        {
            assert_ne!(note, late);
            if expected.contains(note) {
                assert!(
                    seen.insert(note.to_owned()),
                    "repeated revision in continuation"
                );
            }
        }
        if let Some(next) = delta["continuation"].as_str() {
            page = call(
                fixture,
                reader,
                key,
                "start_session",
                json!({"continuation":next}),
            )
            .await
            .unwrap();
            key += 1;
            assert!(key <= 70);
        } else {
            assert_eq!(delta["complete"], true);
            break delta["deliveryReceipt"].as_str().unwrap().to_owned();
        }
    };
    assert_eq!(seen, expected);
    assert!(owner_ack(fixture, reader, episode.clone(), scope).await < cutoff);
    for key in [71, 72] {
        call(
            fixture,
            reader,
            key,
            "start_session",
            json!({"deliveryReceipt":final_receipt}),
        )
        .await
        .unwrap();
    }
    assert_eq!(owner_ack(fixture, reader, episode, scope).await, cutoff);
}

async fn append_note(fixture: &RuntimeFixture, scope: &SpaceContext, tag: u8) -> NoteId {
    let note = NoteId::from_bytes([tag; 16]);
    fixture
        .canonical
        .create_note(
            scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.scope().clone(),
                    actor: scope.auth().principal().clone(),
                    key: CommandKey::from_bytes([tag; 16]),
                    hash: ContentDigest::from_bytes([tag; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: format!("delta-{tag}"),
                    class: notarium_core::classes::DocClass::UserDoc,
                    carrier: format!("# Delta {tag}\n"),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    note
}

async fn owner_ack(
    fixture: &RuntimeFixture,
    reader: &AccountContext,
    episode: EpisodeId,
    scope: &SpaceContext,
) -> SpaceSeq {
    fixture
        .control
        .bootstrap_context(
            reader.clone(),
            episode,
            None,
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap()
        .owner_acknowledgements
        .get(&scope.scope().space_id)
        .map_or(SpaceSeq::ZERO, |ack| ack.seq)
}

#[tokio::test]
async fn sqlite_external_registry_and_memory() {
    external_registry_and_memory(false).await;
}

#[tokio::test]
async fn postgres_external_registry_and_memory() {
    external_registry_and_memory(true).await;
}

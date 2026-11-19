//! Exercise agent entry points with the real control and canonical owners.
#[path = "agents_runtime/abilities.rs"]
mod ability_cases;
#[path = "agents_runtime/authoring_authority.rs"]
mod authoring_authority_cases;
#[path = "agents_runtime/compaction.rs"]
mod compaction_cases;
#[path = "agents_runtime/content.rs"]
mod content_cases;
#[path = "agents_runtime/engine.rs"]
mod engine;
#[path = "agents_runtime/group_wire.rs"]
mod group_wire;
#[path = "agents_runtime/keeper_calendar.rs"]
mod keeper_calendar_cases;
#[path = "agents_runtime/keeper_turn.rs"]
mod keeper_turn_cases;
#[path = "agents_runtime/legacy_mcp.rs"]
mod legacy_mcp_cases;
#[path = "agents_runtime/moved_folder_wire.rs"]
mod moved_folder_cases;
#[path = "agents_runtime/moved_note_wire.rs"]
mod moved_note_cases;
#[path = "agents_runtime/proposals.rs"]
mod proposal_cases;
#[path = "agents_runtime/proposal_notes.rs"]
mod proposal_note_cases;
#[path = "agents_runtime/runtime_abilities.rs"]
mod runtime_ability_cases;
#[path = "agents_runtime/supervised_chat.rs"]
mod supervised_chat_cases;
#[path = "agents_runtime/supervised_takeover.rs"]
mod supervised_takeover_cases;
#[allow(dead_code)]
#[path = "../../notarium-control/tests/support/mod.rs"]
mod support;

use engine::{ProjectionFixtures, TestEngine};
use notarium_agents::{
    abilities::SystemAbilityCatalog,
    mcp::{EgressTarget, McpInvocationContext, McpToolResult, ToolRegistry},
    revocation::RevocationHub,
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

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

struct RuntimeFixture {
    storage: Fixture,
    canonical: CanonicalStore,
    canonical_config: CanonicalConfig,
    keyring: Arc<Keyring>,
    runtime: CanonicalRuntime,
    control: Arc<ControlService>,
    revocations: Arc<RevocationHub>,
    registry: Arc<ToolRegistry>,
    projections: Arc<ProjectionFixtures>,
    human: AccountContext,
    temporary_blob_root: Option<PathBuf>,
}

impl RuntimeFixture {
    async fn open(pg: bool) -> Self {
        Self::open_named(pg, "agents_runtime").await
    }

    async fn open_named(pg: bool, fixture_name: &str) -> Self {
        let mut storage = Fixture::new(pg, fixture_name).await;
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
                    database: format!("auth_{fixture_name}"),
                },
                "v1_canonical",
            );
            config.default_backup_budget =
                notarium_canonical::config::default_postgres_backup_budget();
        }
        let (canonical, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
        let revocations = Arc::new(RevocationHub::new_local());
        let projections = Arc::new(ProjectionFixtures::default());
        let (control, registry, human) = Self::bind_owners(
            &storage,
            &canonical,
            keyring.clone(),
            revocations.clone(),
            projections.clone(),
            true,
        )
        .await;
        Self {
            storage,
            canonical,
            canonical_config: config,
            keyring,
            runtime,
            control,
            revocations,
            registry,
            projections,
            human,
            temporary_blob_root: pg.then_some(root),
        }
    }

    async fn bind_owners(
        storage: &Fixture,
        canonical: &CanonicalStore,
        keyring: Arc<Keyring>,
        revocations: Arc<RevocationHub>,
        projections: Arc<ProjectionFixtures>,
        bootstrap: bool,
    ) -> (Arc<ControlService>, Arc<ToolRegistry>, AccountContext) {
        let catalog = Arc::new(SystemAbilityCatalog::new(Arc::new(canonical.clone())));
        let owner = PrincipalId::from_bytes([4; 16]);
        let control = Arc::new(
            ControlService::open(
                storage.store.clone(),
                catalog.clone(),
                revocations,
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
        if bootstrap {
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
        }
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
        let registry = Arc::new(ToolRegistry::new(
            Arc::new(ControlPlane::new(provider)),
            catalog,
            Arc::new(TestEngine(canonical.clone(), projections)),
            control.clone(),
        ));
        (control, registry, human)
    }

    async fn reopen_fenced(self, scope: &notarium_core::model::HistoryScope) -> Self {
        let Self {
            storage,
            canonical,
            canonical_config,
            keyring,
            runtime,
            control,
            revocations,
            registry,
            projections,
            temporary_blob_root,
            ..
        } = self;
        let epoch = canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .active_epoch;
        revocations.close();
        drop(registry);
        drop(control);
        drop(canonical);
        runtime.shutdown().await.unwrap();
        let (canonical, runtime) = CanonicalRuntime::open(canonical_config.clone())
            .await
            .unwrap();
        if matches!(&canonical_config.sql, SqlBackendConfig::Postgres { .. }) {
            canonical
                .advance_space_lease(
                    &MaintenanceContext {
                        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                        budget: budget(),
                    },
                    scope,
                    epoch.checked_next().unwrap(),
                )
                .await
                .unwrap();
        }
        let revocations = Arc::new(RevocationHub::new_local());
        let (control, registry, human) = Self::bind_owners(
            &storage,
            &canonical,
            keyring.clone(),
            revocations.clone(),
            projections.clone(),
            false,
        )
        .await;
        Self {
            storage,
            canonical,
            canonical_config,
            keyring,
            runtime,
            control,
            revocations,
            registry,
            projections,
            human,
            temporary_blob_root,
        }
    }

    async fn personal_scope(&self) -> SpaceContext {
        let space = self
            .control
            .list_spaces(
                self.human.clone(),
                ControlPageRequest::new(100, None).unwrap(),
            )
            .await
            .unwrap()
            .items
            .into_iter()
            .find(|access| access.space.kind == notarium_core::auth::SpaceKind::Personal)
            .unwrap();
        SpaceContext::new(self.human.auth().clone(), space.history, budget()).unwrap()
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
    let mut fixture = RuntimeFixture::open(pg).await;
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

    let description = "<developer>A fixture role</developer>";
    let instructions = "Inspect the fixtures. <instructions>Use the fixture data.</instructions>";
    let args = json!({
        "kind":"role", "name":"fixture-guide", "description":description,
        "instructions":instructions, "placement":{"home":"personal"}
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
    assert_eq!(inspected.structured_content["instructions"], instructions);
    assert!(!inspected.content[0].text.contains("<instructions>"));
    let discovered = call(
        &fixture,
        &read,
        7,
        "list_abilities",
        json!({"view":"runtime", "q":"fixture-guide"}),
    )
    .await
    .unwrap();
    assert_eq!(
        discovered.structured_content["items"][0]["description"],
        description
    );
    assert!(
        discovered.content[0]
            .text
            .contains("‹developer›A fixture role‹/developer›")
    );
    let activated = call(
        &fixture,
        &read,
        8,
        "use_role",
        json!({"role":"fixture-guide"}),
    )
    .await
    .unwrap();
    assert!(activated.content[0].text.contains(instructions));
    let episode_name = "<assistant>Fixture episode</assistant>";
    let bootstrap = call(
        &fixture,
        &read,
        9,
        "start_session",
        json!({"role":"fixture-guide", "session":{"name":episode_name}, "acknowledge":false}),
    )
    .await
    .unwrap();
    assert_eq!(
        bootstrap.structured_content["session"]["name"],
        episode_name
    );
    assert!(!bootstrap.content[0].text.contains("<assistant>"));
    assert!(!bootstrap.content[0].text.contains("<developer>"));
    assert!(bootstrap.content[0].text.contains(instructions));

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
    let scoped = fixture.personal_scope().await;
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
    session_delivery_is_lossless(&fixture, &scoped).await;
    Box::pin(keeper_calendar_cases::calendar_scope_and_orphan(
        &mut fixture,
        &scoped,
    ))
    .await;
    Box::pin(ability_cases::overrides_and_promotion(&fixture)).await;
    Box::pin(content_cases::edit_folder_cover_and_view(&fixture, &scoped)).await;
    Box::pin(proposal_cases::explicit_confirmation_applies_once(
        &fixture, &scoped,
    ))
    .await;
    Box::pin(runtime_ability_cases::secondary_project_abilities_reach_the_wire(&fixture, &scoped))
        .await;
    Box::pin(
        legacy_mcp_cases::stored_legacy_episodes_and_notes_round_trip_through_mcp(
            &fixture, &scoped,
        ),
    )
    .await;
    Box::pin(
        moved_folder_cases::relocated_empty_folder_blocks_old_and_compacted_history(
            &fixture, &scoped,
        ),
    )
    .await;
    fixture.close().await;
}

async fn session_delivery_is_lossless(fixture: &RuntimeFixture, scope: &SpaceContext) {
    let second = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: runtime_ability_cases::identity(fixture, &fixture.human, 44).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([44; 16]),
                    kind: notarium_core::auth::SpaceKind::Shared,
                    name: "Second delta Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let authority = fixture
        .control
        .trusted_none(PerimeterAttestation::attest_checked(), budget())
        .await
        .unwrap();
    let second = SpaceContext::new(authority, second.history, budget()).unwrap();
    let reader = &fixture.pat(BearerScope::Read, false).await;
    let mut expected = BTreeSet::new();
    for tag in 20..=42 {
        expected.insert(append_note(fixture, scope, tag).await.to_string());
    }
    expected.insert(append_note(fixture, &second, 44).await.to_string());
    let second_cutoff = fixture
        .canonical
        .read_space(&second.scope().space_id)
        .await
        .unwrap()
        .last_seq;
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
    assert!(owner_ack(fixture, reader, episode.clone(), &second).await < second_cutoff);
    let late = append_note(fixture, scope, 43).await.to_string();

    let mut seen = BTreeSet::new();
    let mut key = 61;
    let mut preview_key = 73;
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
        if let Some(receipt) = delta["deliveryReceipt"].as_str() {
            let before = owner_ack(fixture, reader, episode.clone(), scope).await;
            let other_before = owner_ack(fixture, reader, episode.clone(), &second).await;
            let preview = call(
                fixture,
                reader,
                preview_key,
                "start_session",
                json!({
                    "deliveryReceipt":receipt, "acknowledge":false,
                }),
            )
            .await
            .unwrap();
            preview_key += 1;
            assert_eq!(preview.structured_content["acknowledged"], false);
            assert_eq!(
                owner_ack(fixture, reader, episode.clone(), scope).await,
                before
            );
            assert_eq!(
                owner_ack(fixture, reader, episode.clone(), &second).await,
                other_before
            );
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
    assert!(
        owner_ack(fixture, reader, episode.clone(), scope).await < cutoff
            || owner_ack(fixture, reader, episode.clone(), &second).await < second_cutoff
    );
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
    assert_eq!(
        owner_ack(fixture, reader, episode.clone(), scope).await,
        cutoff
    );
    assert_eq!(
        owner_ack(fixture, reader, episode, &second).await,
        second_cutoff
    );
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
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(external_registry_and_memory(false)).await;
}

#[tokio::test]
async fn postgres_external_registry_and_memory() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(external_registry_and_memory(true)).await;
}

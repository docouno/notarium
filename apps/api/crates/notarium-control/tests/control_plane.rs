#[allow(dead_code)]
#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;

use notarium_control::{
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlPlane, ControlService,
        provider::{ProviderConfig, ProviderService},
    },
};
use notarium_core::{
    auth::*,
    classes::{AbilityKind, DocClass},
    error::PortError,
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use provider::*;
use std::sync::{Arc, atomic::Ordering};
use support::*;

async fn next_identity(
    control: &ControlService,
    ctx: &AccountContext,
    key: u8,
) -> AccountCommandIdentity {
    let owner = ctx.auth().principal();
    let revision = control
        .account(ctx.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    command(owner, owner, key, revision)
}

async fn run_concurrent_load_pool_isolation_and_untainted_metadata(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "control_plane_concurrency").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: Some("owner@example.test".into()),
                display_name: "Owner".into(),
                password: Some(SecretString::new("concurrency fixture password".into())),
            },
        )
        .await
        .unwrap();
    let owner = boot.account.id.clone();
    let personal_id = boot.account.personal_space.clone().unwrap();
    let token = boot.session.unwrap().token;
    let auth = control
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    let ctx = AccountContext::new(auth, budget());

    let shared = control
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([11; 16]),
                    kind: SpaceKind::Shared,
                    name: "Team space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;

    let ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );

    let project = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([12; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project.space_id.clone(), project.folder_id.clone()),
        ProjectInfo {
            folder: project.clone(),
            name: "Shared project".into(),
        },
    );

    let shared_note = NoteRef {
        space_id: shared.space.id.clone(),
        note_id: NoteId::from_bytes([13; 16]),
    };
    fixture.catalog.note_entries.lock().unwrap().insert(
        (shared.space.id.clone(), shared_note.note_id.clone()),
        CatalogNote {
            reference: shared_note.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: shared.space.clone(),
                class: DocClass::UserDoc,
                ancestor_folders: vec![project.folder_id.clone()],
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );

    let personal_space = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&personal_id)
        .unwrap()
        .2
        .space
        .clone();
    let personal_note = NoteRef {
        space_id: personal_id.clone(),
        note_id: NoteId::from_bytes([14; 16]),
    };
    fixture.catalog.note_entries.lock().unwrap().insert(
        (personal_id, personal_note.note_id.clone()),
        CatalogNote {
            reference: personal_note,
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: personal_space.clone(),
                class: DocClass::UserDoc,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );

    let shared_scope = ContextScope::Space(shared.space.id.clone());
    let scope_rev = control
        .context_scope(ctx.clone(), shared_scope.clone())
        .await
        .unwrap()
        .revision;
    control
        .set_context_pin(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 2).await,
                input: SetContextPin {
                    scope: shared_scope,
                    expected: scope_rev,
                    note: shared_note.clone(),
                    pinned: true,
                },
            },
        )
        .await
        .unwrap();

    let ability_ref = AbilityRef {
        id: AbilityId::from_bytes([15; 16]),
        placement: AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        revision: RevisionId::from_bytes([1; 16]),
    };
    let ability_note = NoteRef {
        space_id: shared.space.id.clone(),
        note_id: NoteId::from_bytes([16; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            reference: ability_ref.clone(),
            kind: AbilityKind::Role,
            name: "shared-role".into(),
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: ability_note.clone(),
            auxiliary_files: vec![],
        });
    fixture.catalog.note_entries.lock().unwrap().insert(
        (shared.space.id.clone(), ability_note.note_id.clone()),
        CatalogNote {
            reference: ability_note,
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: shared.space.clone(),
                class: DocClass::Skill,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: Some(ability_ref.id),
            },
        },
    );

    let episode_id = EpisodeId::from_bytes([17; 16]);
    control
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &ctx, 3).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: episode_id.clone(),
                        name: Some("concurrency-ep".into()),
                    },
                    project_hint: None,
                },
            },
        )
        .await
        .unwrap();

    let provider = ProviderService::new(
        control.clone(),
        keys,
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    let plane = Arc::new(ControlPlane::new(provider));

    // Personal-pinned AgentRun enumerating Shared metadata never taints its branch.
    let agent_auth = ctx
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([18; 16]),
            personal_space.id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    let agent_ctx = AccountContext::new(agent_auth.clone(), budget());
    let spaces_page = plane
        .list_spaces(
            agent_ctx.clone(),
            ControlPageRequest::new(20, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(spaces_page.items.len(), 2);
    // Each Space contributes one catalog page in this fixture. Either Space can sort first.
    let mut projects = Vec::new();
    let mut continuation = None;
    for _ in &spaces_page.items {
        let page = plane
            .list_projects(
                agent_ctx.clone(),
                ControlPageRequest::new(20, continuation.take()).unwrap(),
            )
            .await
            .unwrap();
        projects.extend(page.items.into_iter().map(|item| item.folder));
        continuation = page.continuation;
        if continuation.is_none() {
            break;
        }
    }
    assert!(continuation.is_none());
    assert_eq!(projects, [project.clone()]);
    let abilities_page = plane
        .discover_abilities(
            agent_ctx.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: None,
                kind: None,
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(abilities_page.items.len(), 1);
    let boot_ctx = plane
        .bootstrap_context(
            agent_ctx,
            episode_id.clone(),
            Some(shared.space.id.clone()),
            ControlPageRequest::new(20, None).unwrap(),
        )
        .await
        .unwrap();
    assert!(boot_ctx.selection.pinned.contains(&shared_note));
    assert!(
        !agent_auth.taint().is_tainted(),
        "metadata visibility checks must never taint an AgentRun branch"
    );
    let personal_facts = ResourceFacts {
        space: personal_space,
        class: DocClass::UserDoc,
        ancestor_folders: vec![],
        folder_write_locked: false,
        ability_package: None,
    };
    agent_auth
        .authorize_direct_write(&personal_facts, &personal_facts)
        .unwrap();

    // 50 concurrent read/auth operations + 12 concurrent writes through ControlPlane complete without starvation.
    let mut set = tokio::task::JoinSet::new();
    let token_str = token.expose().to_owned();
    for i in 0..50usize {
        let plane = plane.clone();
        let ctx = ctx.clone();
        let token_str = token_str.clone();
        let episode_id = episode_id.clone();
        set.spawn(async move {
            match i % 5 {
                0 => {
                    plane
                        .resolve_auth(evidence(AuthEvidenceKind::Session, &token_str))
                        .await?;
                }
                1 => {
                    plane.whoami(ctx).await?;
                }
                2 => {
                    plane
                        .list_spaces(ctx, ControlPageRequest::new(20, None).unwrap())
                        .await?;
                }
                3 => {
                    plane
                        .discover_abilities(
                            ctx,
                            AbilityQuery {
                                page: ControlPageRequest::new(20, None).unwrap(),
                                project: None,
                                kind: None,
                                name: None,
                                authoring: false,
                            },
                        )
                        .await?;
                }
                _ => {
                    plane
                        .bootstrap_context(
                            ctx,
                            episode_id,
                            None,
                            ControlPageRequest::new(20, None).unwrap(),
                        )
                        .await?;
                }
            }
            Ok::<_, PortError>(())
        });
    }
    for i in 0..12u8 {
        let plane = plane.clone();
        let control = control.clone();
        let ctx = ctx.clone();
        let episode_id = episode_id.clone();
        set.spawn(async move {
            if i < 2 {
                plane.touch_episode(ctx, episode_id).await?;
            } else if i < 7 {
                plane
                    .record_mcp_dedup(
                        ctx,
                        McpDedupRecord {
                            key: McpDedupKey {
                                actor: "agent-actor".into(),
                                request_key: CommandKey::from_bytes([100 + i; 16]),
                                request_hash: ContentDigest::from_bytes([100 + i; 32]),
                                operation: "create_note".into(),
                            },
                            safe_result: "{\"ok\":true}".into(),
                            effect: AgentEffect::Write,
                            ttl_ms: 60_000,
                        },
                    )
                    .await?;
            } else {
                let call_id = RequestId::from_bytes([150 + i; 16]);
                control
                    .begin_agent_call(
                        ctx,
                        BeginAgentCall {
                            call: call_id.clone(),
                            request: call_id.clone(),
                            episode: Some(episode_id),
                            operation: AgentOperation::Search,
                            transport: AgentTransport::Mcp,
                            effect: AgentEffect::Read,
                            input_bytes: 64,
                        },
                    )
                    .await?;
                control
                    .finish_agent_call(
                        MaintenanceContext {
                            authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
                            budget: budget(),
                        },
                        FinishAgentCall {
                            call: call_id,
                            outcome: AgentOutcome::Succeeded,
                            failure: None,
                            output_bytes: 128,
                            detail: None,
                        },
                    )
                    .await?;
            }
            Ok::<_, PortError>(())
        });
    }
    while let Some(res) = set.join_next().await {
        res.unwrap().unwrap();
    }

    let hit = plane
        .lookup_mcp_dedup(
            ctx.clone(),
            McpDedupKey {
                actor: "agent-actor".into(),
                request_key: CommandKey::from_bytes([102; 16]),
                request_hash: ContentDigest::from_bytes([102; 32]),
                operation: "create_note".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        hit,
        Some(McpDedupHit {
            operation: "create_note".into(),
            safe_result: "{\"ok\":true}".into(),
            effect: AgentEffect::Write,
        })
    );

    // TrustedNone concurrent read-only auth resolution.
    let trusted = fixture
        .service(AuthenticationMode::TrustedNone {
            owner: owner.clone(),
        })
        .await
        .unwrap();
    let mut trusted_tasks = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let trusted = trusted.clone();
        trusted_tasks.spawn(async move {
            trusted
                .trusted_none(
                    PerimeterAttestation::attest_checked().with_human_management(),
                    budget(),
                )
                .await
        });
    }
    while let Some(res) = trusted_tasks.join_next().await {
        let auth = res.unwrap().unwrap();
        assert_eq!(auth.principal(), &owner);
        assert!(auth.human_management());
        assert!(!auth.has_cap(Cap::AbilityWrite));
    }

    // 20 concurrent slow catalog reads (> 16 read-pool slots) release ReadTransaction before entering
    // the catalog and never starve concurrent writers.
    fixture
        .catalog
        .abilities_gate
        .enabled
        .store(true, Ordering::SeqCst);
    let mut reader_handles = Vec::with_capacity(20);
    for _ in 0..20 {
        let svc = control.clone();
        let rctx = ctx.clone();
        let proj = project.clone();
        reader_handles.push(tokio::spawn(async move {
            svc.discover_abilities(
                rctx,
                AbilityQuery {
                    page: ControlPageRequest::new(50, None).unwrap(),
                    project: Some(proj),
                    kind: None,
                    name: None,
                    authoring: false,
                },
            )
            .await
        }));
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.catalog.abilities_gate.entered.acquire_many(20),
    )
    .await
    .expect("all 20 readers must enter catalog without holding 16-slot ReadTransaction")
    .unwrap()
    .forget();

    control
        .begin_agent_call(
            ctx.clone(),
            BeginAgentCall {
                call: RequestId::from_bytes([80; 16]),
                request: RequestId::from_bytes([81; 16]),
                episode: Some(episode_id),
                operation: AgentOperation::Search,
                transport: AgentTransport::Mcp,
                effect: AgentEffect::Read,
                input_bytes: 32,
            },
        )
        .await
        .expect("writer must not starve behind 20 slow catalog reads");

    fixture
        .catalog
        .abilities_gate
        .enabled
        .store(false, Ordering::SeqCst);
    fixture.catalog.abilities_gate.release.add_permits(20);
    for handle in reader_handles {
        let page = handle.await.unwrap().unwrap();
        assert_eq!(page.items.len(), 1);
    }

    // 10-way concurrent identical client-ID inserts succeed idempotently on both backends.
    let race_call = RequestId::from_bytes([85; 16]);
    let race_retrieval = RequestId::from_bytes([86; 16]);
    let mut race_tasks = Vec::new();
    for _ in 0..10 {
        let svc = control.clone();
        let c = ctx.clone();
        let call_id = race_call.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.begin_agent_call(
                c,
                BeginAgentCall {
                    call: call_id,
                    request: RequestId::from_bytes([87; 16]),
                    episode: None,
                    operation: AgentOperation::Read,
                    transport: AgentTransport::Mcp,
                    effect: AgentEffect::Read,
                    input_bytes: 16,
                },
            )
            .await
        }));
        let svc = control.clone();
        let c = ctx.clone();
        let ret_id = race_retrieval.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.record_agent_retrieval(
                c,
                AgentRetrieval {
                    id: ret_id,
                    call: None,
                    kind: RetrievalKind::FullText,
                    hits: vec![],
                    result_count: 0,
                    top_score: None,
                },
            )
            .await
        }));
        let svc = control.clone();
        let c = ctx.clone();
        race_tasks.push(tokio::spawn(async move {
            svc.record_mcp_dedup(
                c,
                McpDedupRecord {
                    key: McpDedupKey {
                        actor: "mcp-client".into(),
                        request_key: CommandKey::from_bytes([88; 16]),
                        request_hash: ContentDigest::from_bytes([89; 32]),
                        operation: "create_note".into(),
                    },
                    safe_result: "{\"ok\":true}".into(),
                    effect: AgentEffect::Write,
                    ttl_ms: 60_000,
                },
            )
            .await
        }));
    }
    for task in race_tasks {
        task.await.unwrap().expect(
            "concurrent identical client-ID inserts must be idempotent without transaction abort",
        );
    }

    drop(trusted);
    drop(plane);
    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_concurrent_load_pool_isolation_and_untainted_metadata() {
    run_concurrent_load_pool_isolation_and_untainted_metadata(false).await;
}
#[tokio::test]
async fn postgres_concurrent_load_pool_isolation_and_untainted_metadata() {
    run_concurrent_load_pool_isolation_and_untainted_metadata(true).await;
}

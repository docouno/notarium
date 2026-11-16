#[path = "support/provider.rs"]
mod provider;
#[allow(dead_code)]
mod support;

use notarium_control::{
    outbound::{NetworkPolicy, OutboundTransport},
    service::{
        AuthenticationMode, ControlPlane, ControlService,
        oidc::{OidcClientAuthentication, OidcProviderConfig, OidcService},
        provider::{ProviderConfig, ProviderService},
    },
    store::TargetRecord,
};
use notarium_core::{
    DomainError,
    auth::*,
    classes::{AbilityKind, DocClass},
    error::{Diagnostic, PortError, ValidationReason},
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

async fn run_concurrency_and_taint(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "reg_concurrency").await;
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
    let ctx = AccountContext::new(auth.clone(), budget());

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
        (personal_id.clone(), personal_note.note_id.clone()),
        CatalogNote {
            reference: personal_note.clone(),
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

    // Pin a note in the Shared Space and register a Shared-Space ability.
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
                ability_package: Some(ability_ref.id.clone()),
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

    // IMPL-028: Personal-pinned AgentRun enumerating Shared metadata must NOT taint its branch.
    let agent_auth = ctx
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([18; 16]),
            personal_id.clone(),
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
    let projects_page = plane
        .list_projects(
            agent_ctx.clone(),
            ControlPageRequest::new(20, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(projects_page.items.len(), 1);
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

    // IMPL-024: 50 concurrent read/auth operations + 12 concurrent mutations through ControlPort
    // complete with zero RateLimited errors.
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

    drop(trusted);
    drop(plane);
    drop(control);
    fixture.close().await;
}

async fn run_management_preferences_and_selected_abilities(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "reg_mgmt").await;
    let keys = keyring(&mut fixture).await;
    let control = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = control
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("management fixture password".into())),
            },
        )
        .await
        .unwrap();
    let owner = boot.account.id.clone();
    let personal_id = boot.account.personal_space.clone().unwrap();
    let token = boot.session.unwrap().token;

    // IMPL-029: Ambient session (human_management = false) can read, but management mutations reject.
    let ambient_ctx = AccountContext::new(
        control
            .resolve(unconfirmed_evidence(
                AuthEvidenceKind::Session,
                token.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    control.whoami(ambient_ctx.clone()).await.unwrap();
    assert!(matches!(
        control
            .create_space(
                ambient_ctx.clone(),
                AccountMutation {
                    identity: command(&owner, &owner, 1, boot.account.revision),
                    input: CreateSpace {
                        id: SpaceId::from_bytes([21; 16]),
                        kind: SpaceKind::Shared,
                        name: "Blocked".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .create_pat(
                ambient_ctx.clone(),
                CreatePat {
                    name: "Blocked".into(),
                    scope: BearerScope::Read,
                    selected_spaces: None,
                    expires_at_ms: None,
                    expected: boot.account.revision,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // Interactive human session (human_management = true, ability_write = false).
    let mgmt_ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let shared = control
        .create_space(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([22; 16]),
                    kind: SpaceKind::Shared,
                    name: "Team".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let mgmt_ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );

    let project_ok = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([23; 16]),
    };
    let project_other = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([24; 16]),
    };
    for (folder, name) in [
        (project_ok.clone(), "Allowed project"),
        (project_other.clone(), "Other project"),
    ] {
        fixture.catalog.project_entries.lock().unwrap().insert(
            (folder.space_id.clone(), folder.folder_id.clone()),
            ProjectInfo {
                folder: folder.clone(),
                name: name.into(),
            },
        );
        fixture.catalog.folder_entries.lock().unwrap().insert(
            (folder.space_id.clone(), folder.folder_id.clone()),
            CatalogFolder {
                reference: folder,
                space: shared.space.clone(),
                lifecycle: Lifecycle::Active,
                ancestor_folders: vec![],
                write_locked: false,
            },
        );
    }

    let ability_ref = AbilityRef {
        id: AbilityId::from_bytes([25; 16]),
        placement: AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        revision: RevisionId::from_bytes([1; 16]),
    };
    let ability_note = NoteRef {
        space_id: shared.space.id.clone(),
        note_id: NoteId::from_bytes([26; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            reference: ability_ref.clone(),
            kind: AbilityKind::Role,
            name: "selected-guide".into(),
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: ability_note.clone(),
            auxiliary_files: vec![],
        });
    fixture.catalog.note_entries.lock().unwrap().insert(
        (shared.space.id.clone(), ability_note.note_id.clone()),
        CatalogNote {
            reference: ability_note.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: shared.space.clone(),
                class: DocClass::Skill,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: Some(ability_ref.id.clone()),
            },
        },
    );

    // IMPL-029: human_management allows set_favorite & set_ability_preference, but NOT update_ability_binding.
    control
        .set_favorite(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 3).await,
                input: SetFavorite {
                    reference: FavoriteRef::Folder(project_ok.clone()),
                    saved: true,
                    rank: 1,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        control
            .set_favorite(
                ambient_ctx.clone(),
                AccountMutation {
                    identity: next_identity(&control, &mgmt_ctx, 4).await,
                    input: SetFavorite {
                        reference: FavoriteRef::Folder(project_ok.clone()),
                        saved: false,
                        rank: 1,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .update_ability_binding(
                mgmt_ctx.clone(),
                AccountMutation {
                    identity: next_identity(&control, &mgmt_ctx, 5).await,
                    input: AbilityBindingUpdate {
                        ability: ability_ref.clone(),
                        enabled: true,
                        expected: ControlRevision::ZERO,
                        projects: AbilityProjects::Selected(vec![project_ok.clone()]),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));

    // Explicit with_ability_write() authorizes binding mutation.
    let mut aw_ev = evidence(AuthEvidenceKind::Session, token.expose());
    aw_ev.evidence = aw_ev.evidence.with_ability_write();
    let aw_ctx = AccountContext::new(control.resolve(aw_ev).await.unwrap(), budget());
    control
        .update_ability_binding(
            aw_ctx,
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 6).await,
                input: AbilityBindingUpdate {
                    ability: ability_ref.clone(),
                    enabled: true,
                    expected: ControlRevision::ZERO,
                    projects: AbilityProjects::Selected(vec![project_ok.clone()]),
                },
            },
        )
        .await
        .unwrap();

    // IMPL-035: AbilityProjects::Selected works on Exact { project: Some(..) } and get_ability(.., Some(..)).
    assert!(matches!(
        control
            .resolve_ability(
                mgmt_ctx.clone(),
                AbilitySelection::Exact {
                    reference: ability_ref.clone(),
                    project: None,
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert!(matches!(
        control
            .resolve_ability(
                mgmt_ctx.clone(),
                AbilitySelection::Exact {
                    reference: ability_ref.clone(),
                    project: Some(project_other),
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert!(matches!(
        control
            .resolve_ability(
                mgmt_ctx.clone(),
                AbilitySelection::Exact {
                    reference: ability_ref.clone(),
                    project: Some(project_ok.clone()),
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Resolved(_)
    ));
    assert!(matches!(
        control
            .get_ability(mgmt_ctx.clone(), ability_ref.clone(), None)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(
        control
            .get_ability(mgmt_ctx.clone(), ability_ref.clone(), Some(project_ok))
            .await
            .unwrap()
            .enabled
    );

    // IMPL-035: Completion and Embedding preferences coexist in the same scope without overwriting.
    let provider = ProviderService::new(
        control.clone(),
        keys,
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        Arc::new(NoEgress),
        ProviderConfig::default(),
    )
    .unwrap();
    provider
        .create_credential(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 7).await,
                input: credential_input("secret-key"),
            },
        )
        .await
        .unwrap();
    let mut res_spec = resource_input();
    res_spec.timeout_ms = 90_000;
    let resource = provider
        .create_resource(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 8).await,
                input: res_spec,
            },
        )
        .await
        .unwrap()
        .value;
    assert_eq!(resource.timeout_ms, 90_000);

    let completion_model = ModelProfileId::from_bytes([31; 16]);
    let embedding_model = ModelProfileId::from_bytes([32; 16]);
    let m1 = provider
        .put_model(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 9).await,
                input: PutProviderModel {
                    resource: resource.id.clone(),
                    expected: resource.revision,
                    model: ProviderModelSpec {
                        id: completion_model.clone(),
                        wire_name: "gpt-4o".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 128_000,
                        max_output_tokens: 4_096,
                        tools: true,
                    },
                    default: true,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let current_res = current_resource(&provider, &mgmt_ctx).await;
    provider
        .put_model(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 10).await,
                input: PutProviderModel {
                    resource: resource.id.clone(),
                    expected: current_res.revision,
                    model: ProviderModelSpec {
                        id: embedding_model.clone(),
                        wire_name: "text-embedding-3-small".into(),
                        kind: ProviderModelKind::Embedding { dimension: 1536 },
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 8_192,
                        max_output_tokens: 0,
                        tools: false,
                    },
                    default: false,
                },
            },
        )
        .await
        .unwrap();
    let _ = m1;

    let current_res = current_resource(&provider, &mgmt_ctx).await;
    let cred = provider
        .list_credentials(mgmt_ctx.clone(), ControlPageRequest::new(10, None).unwrap())
        .await
        .unwrap()
        .items
        .remove(0);
    provider
        .request_attachment(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 11).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([33; 16]),
                    expected: None,
                    resource: resource.id.clone(),
                    resource_consent_epoch: current_res.consent_epoch,
                    credential_consent_epoch: Some(cred.consent_epoch),
                    target: ProviderAttachmentTarget::Personal {
                        owner: owner.clone(),
                        space: personal_id.clone(),
                    },
                    consent: consent(),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();

    let plane = ControlPlane::new(provider);
    plane
        .update_provider_preference(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 12).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Completion,
                    resource: resource.id.clone(),
                    model: completion_model.clone(),
                },
            },
        )
        .await
        .unwrap();
    plane
        .update_provider_preference(
            mgmt_ctx.clone(),
            AccountMutation {
                identity: next_identity(&control, &mgmt_ctx, 13).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Embedding,
                    resource: resource.id.clone(),
                    model: embedding_model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let personal_history = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&personal_id)
        .unwrap()
        .2
        .history
        .clone();
    let space_ctx = SpaceContext::new(mgmt_ctx.auth().clone(), personal_history, budget()).unwrap();
    let selected_completion = plane
        .select_provider(
            space_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: None,
                model: None,
                project: None,
            },
        )
        .await
        .unwrap();
    let selected_embedding = plane
        .select_provider(
            space_ctx,
            SelectProvider {
                kind: PreferenceModelKind::Embedding,
                resource: None,
                model: None,
                project: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(selected_completion.model, completion_model);
    assert_eq!(selected_embedding.model, embedding_model);

    drop(plane);
    drop(control);
    fixture.close().await;
}

async fn run_oidc_dos_invariants_and_12_table_gc(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "reg_gc").await;
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
                password: Some(SecretString::new("retention fixture password".into())),
            },
        )
        .await
        .unwrap();
    let owner = boot.account.id.clone();
    let personal_id = boot.account.personal_space.clone().unwrap();
    let token = boot.session.unwrap().token;
    let ctx = AccountContext::new(
        control
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );

    // IMPL-036: Personal Space cannot be archived; @-less email is rejected; duplicate key is Validation.
    let personal_history = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&personal_id)
        .unwrap()
        .2
        .history
        .clone();
    let personal_ctx = SpaceContext::new(ctx.auth().clone(), personal_history, budget()).unwrap();
    assert!(matches!(
        control
            .change_space_lifecycle(
                personal_ctx,
                SpaceLifecycleChange {
                    command: CommandKey::from_bytes([41; 16]),
                    lifecycle: SpaceLifecycle::Archived,
                    expected: ControlRevision::ZERO,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        control
            .create_account(
                ctx.clone(),
                AccountMutation {
                    identity: next_identity(&control, &ctx, 42).await,
                    input: NewAccount {
                        username: "alice".into(),
                        email: Some("invalid-email-without-at".into()),
                        display_name: "Alice".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed {
            diagnostic: Diagnostic {
                reason: ValidationReason::InvalidQuery,
                ..
            }
        }))
    ));
    assert!(matches!(
        control
            .create_account(
                ctx.clone(),
                AccountMutation {
                    identity: next_identity(&control, &ctx, 43).await,
                    input: NewAccount {
                        username: "owner".into(),
                        email: None,
                        display_name: "Duplicate".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed {
            diagnostic: Diagnostic {
                reason: ValidationReason::DuplicateKey,
                ..
            }
        }))
    ));

    // IMPL-030: Invalid OIDC issuer or bad browser binding does NOT consume provider rate bucket.
    let oidc = OidcService::new(
        control.clone(),
        keys.clone(),
        Arc::new(OutboundTransport::new(NetworkPolicy::default())),
        vec![OidcProviderConfig {
            issuer: "https://idp.example/".into(),
            client_id: "notarium-web".into(),
            redirect_uri: "https://app.example/callback".into(),
            authentication: OidcClientAuthentication::Public,
            trusted_additional_audiences: vec![],
        }],
    )
    .unwrap();
    for _ in 0..100 {
        assert!(matches!(
            oidc.begin_login(
                budget(),
                BeginOidcLogin {
                    issuer: "https://unknown-issuer.example/".into(),
                    browser_binding: SecretString::new(
                        "a-valid-random-browser-binding-with-32-bytes".into()
                    ),
                },
            )
            .await,
            Err(PortError::Domain(DomainError::AuthenticationFailed))
        ));
        assert!(matches!(
            oidc.begin_login(
                budget(),
                BeginOidcLogin {
                    issuer: "https://idp.example/".into(),
                    browser_binding: SecretString::new("short".into()),
                },
            )
            .await,
            Err(PortError::Domain(DomainError::OAuth {
                error: OAuthErrorCode::InvalidRequest
            }))
        ));
    }
    // IMPL-038: Session older than 5 minutes fails begin_link with explicit AccessDenied (not RateLimited).
    fixture.clock.0.fetch_add(6 * 60_000, Ordering::SeqCst);
    assert!(matches!(
        oidc.begin_link(
            ctx.clone(),
            BeginOidcLogin {
                issuer: "https://idp.example/".into(),
                browser_binding: SecretString::new(
                    "a-valid-random-browser-binding-with-32-bytes".into()
                ),
            },
        )
        .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // IMPL-033: Seed aged rows across all 12 growing operational tables + orphaned call +
    // expired command alongside a fresh undelivered revocation_event, and verify cleanup_telemetry.
    let now = fixture.clock.0.load(Ordering::SeqCst);
    let old = now - 100 * 86_400_000;
    let key_id = fixture
        .observer
        .text("SELECT key_id FROM secret_keyring LIMIT 1")
        .await;

    // Begin an agent call and backdate its started_at to simulate a >24h orphaned call.
    control
        .begin_agent_call(
            ctx.clone(),
            BeginAgentCall {
                call: RequestId::from_bytes([61; 16]),
                request: RequestId::from_bytes([61; 16]),
                episode: None,
                operation: AgentOperation::Search,
                transport: AgentTransport::Mcp,
                effect: AgentEffect::Read,
                input_bytes: 10,
            },
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE agent_calls SET started_at = 1000")
        .await;

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
            &[
                TargetRecord::ControlCommands {
                    owner: owner.to_string(),
                    actor: owner.to_string(),
                    command_key: CommandKey::from_bytes([62; 16]).to_string(),
                    request_hash: vec![7; 32],
                    target: "create-space".into(),
                    expected: 0,
                    result_revision: Some(1),
                    state: "committed".into(),
                    safe_result: Some("{}".into()),
                    expires_at: now - 60_000,
                },
                TargetRecord::RevocationEvents {
                    event_id: RequestId::from_bytes([63; 16]).to_string(),
                    selector: serde_json::to_string(&RevocationSelector::ProviderCall(
                        RequestId::from_bytes([63; 16]),
                    ))
                    .unwrap(),
                    reason: serde_json::to_string(&RevocationReason::PermissionChanged).unwrap(),
                    authority_version: 1,
                    committed_at: now,
                    delivered_at: None,
                    attempts: 0,
                },
                TargetRecord::RevocationEvents {
                    event_id: RequestId::from_bytes([64; 16]).to_string(),
                    selector: serde_json::to_string(&RevocationSelector::ProviderCall(
                        RequestId::from_bytes([64; 16]),
                    ))
                    .unwrap(),
                    reason: serde_json::to_string(&RevocationReason::PermissionChanged).unwrap(),
                    authority_version: 1,
                    committed_at: old,
                    delivered_at: Some(old),
                    attempts: 1,
                },
                TargetRecord::ControlOperations {
                    operation_id: RequestId::from_bytes([65; 16]).to_string(),
                    command_key: CommandKey::from_bytes([65; 16]).to_string(),
                    kind: "create-space".into(),
                    target_space: SpaceId::from_bytes([65; 16]).to_string(),
                    state: "committed".into(),
                    payload_hash: vec![65; 32],
                    payload: "{}".into(),
                    canonical_receipt: None,
                    next_action: "none".into(),
                    updated_at: old,
                },
                TargetRecord::Sessions {
                    session_id: AuthSessionId::from_bytes([66; 16]).to_string(),
                    token_hash: vec![66; 32],
                    user_id: owner.to_string(),
                    created_at: old,
                    expires_at: old + 1000,
                    last_used_at: old,
                    revoked_at: None,
                    auth_version: 0,
                },
                TargetRecord::OneTimeTokens {
                    token_hash: vec![67; 32],
                    user_id: owner.to_string(),
                    purpose: "reset".into(),
                    expires_at: old + 1000,
                    used_at: None,
                    created_at: old,
                },
                TargetRecord::OauthClients {
                    client_id: "client_gc_fixture".into(),
                    kind: "dcr".into(),
                    redirect_uris: "[\"http://127.0.0.1/cb\"]".into(),
                    client_name: "GC Client".into(),
                    metadata_uri: None,
                    metadata_digest: None,
                    cache_expires_at: None,
                    activated_at: Some(old),
                    created_at: old,
                    last_seen_at: Some(old),
                },
                TargetRecord::OauthGrants {
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    user_id: owner.to_string(),
                    client_id: "client_gc_fixture".into(),
                    resource_uri: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    revoked_at: None,
                    revision: 0,
                    created_at: old,
                },
                TargetRecord::OauthAuthCodes {
                    code_hash: vec![68; 32],
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    client_id: "client_gc_fixture".into(),
                    redirect_uri: "http://127.0.0.1/cb".into(),
                    resource_uri: "https://resource.example/".into(),
                    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".into(),
                    method: "S256".into(),
                    offline_access: 0,
                    expires_at: old + 1000,
                    used_at: None,
                    created_at: old,
                },
                TargetRecord::OauthRefreshFamilies {
                    family_id: OAuthFamilyId::from_bytes([69; 16]).to_string(),
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    revoked_at: Some(old),
                    reason_code: Some("logout".into()),
                    created_at: old,
                },
                TargetRecord::OauthRefreshTokens {
                    token_id: "696969696969".into(),
                    token_hash: vec![69; 32],
                    family_id: OAuthFamilyId::from_bytes([69; 16]).to_string(),
                    client_id: "client_gc_fixture".into(),
                    issued_at: old,
                    expires_at: old + 1000,
                    used_at: None,
                    revoked_at: Some(old),
                    rotated_to: None,
                },
                TargetRecord::OauthAccessTokens {
                    token_id: "707070707070".into(),
                    token_hash: vec![70; 32],
                    grant_id: OAuthGrantId::from_bytes([68; 16]).to_string(),
                    family_id: Some(OAuthFamilyId::from_bytes([69; 16]).to_string()),
                    refresh_id: Some("696969696969".into()),
                    resource_uri: "https://resource.example/".into(),
                    scope: "read".into(),
                    selected_spaces: None,
                    issued_at: old,
                    expires_at: old + 1000,
                    revoked_at: None,
                    last_used_at: None,
                },
                TargetRecord::OidcTransactions {
                    transaction_id: RequestId::from_bytes([71; 16]).to_string(),
                    state_hash: vec![71; 32],
                    nonce_hash: vec![71; 32],
                    flow_context_hash: vec![71; 32],
                    key_id,
                    issuer: "https://idp.example/".into(),
                    client_id: "notarium-web".into(),
                    redirect_uri: "https://app.example/callback".into(),
                    purpose: "login".into(),
                    bound_user: None,
                    browser_binding_hash: vec![71; 32],
                    expires_at: old + 1000,
                    consumed_at: None,
                    created_at: old,
                },
                TargetRecord::McpDedup {
                    owner: owner.to_string(),
                    actor: "gc-actor".into(),
                    request_key: CommandKey::from_bytes([72; 16]).to_string(),
                    request_hash: vec![72; 32],
                    operation: "search".into(),
                    safe_result: "{}".into(),
                    effect: "read".into(),
                    expires_at: old + 1000,
                },
                TargetRecord::ProviderBudgetBuckets {
                    budget_kind: "space".into(),
                    budget_owner: personal_id.to_string(),
                    window_start_ms: old - (old % 60_000),
                    window_end_ms: old - (old % 60_000) + 60_000,
                    rpm_used: 1,
                    tpm_reserved: 10,
                    tpm_exact: 10,
                },
                TargetRecord::ProviderCallLog {
                    call_id: RequestId::from_bytes([73; 16]).to_string(),
                    owner_id: owner.to_string(),
                    principal: owner.to_string(),
                    run_id: None,
                    scope_id: format!("space:{personal_id}"),
                    intent_key: CommandKey::from_bytes([73; 16]).to_string(),
                    request_hash: vec![73; 32],
                    resource_id: ProviderResourceId::from_bytes([73; 16]).to_string(),
                    credential_id: None,
                    policy_epochs: "{}".into(),
                    participating_spaces: "[]".into(),
                    model_id: None,
                    reserved_tokens: 10,
                    bucket_keys: "[]".into(),
                    delivery_state: "settled".into(),
                    outcome: Some("completed".into()),
                    usage_source: "exact".into(),
                    input_tokens: Some(5),
                    output_tokens: Some(5),
                    diagnostic: None,
                    dispatch_owner: None,
                    created_at: old,
                    settled_at: Some(old),
                },
                TargetRecord::AgentSchedules {
                    schedule_id: ScheduleId::from_bytes([74; 16]).to_string(),
                    owner_id: owner.to_string(),
                    space_id: personal_id.to_string(),
                    project_folder_id: None,
                    title: "Deleted tombstone".into(),
                    init_prompt: String::new(),
                    cron_expr: "0 * * * * *".into(),
                    timezone: "UTC".into(),
                    approved_role: serde_json::to_string(&AbilityRef {
                        id: AbilityId::from_bytes([74; 16]),
                        placement: AbilityPlacement::System,
                        revision: RevisionId::from_bytes([1; 16]),
                    })
                    .unwrap(),
                    paused_reason: None,
                    write_class_mask: 1,
                    budgets: serde_json::to_string(&RunLimits::default()).unwrap(),
                    misfire_policy: "coalesce_latest".into(),
                    next_slot_utc_ms: old - (old % 60_000),
                    deleted_at: Some(old),
                    revision: 1,
                    config_revision: 1,
                    created_at: old,
                    updated_at: old,
                },
                TargetRecord::AgentScheduleRuns {
                    run_id: AgentRunId::from_bytes([75; 16]).to_string(),
                    schedule_id: ScheduleId::from_bytes([74; 16]).to_string(),
                    slot_utc_ms: old - (old % 60_000),
                    lease_epoch: 1,
                    claim_request_hash: vec![75; 32],
                    claimed_schedule_revision: 0,
                    reserved_next_slot: old - (old % 60_000) + 60_000,
                    status: "succeeded".into(),
                    started_at: old,
                    finished_at: Some(old + 1000),
                    safe_result: None,
                    owner_auth_version: 0,
                    config_revision: 0,
                    admission_epoch: 0,
                    history_scope: serde_json::to_string(&HistoryScope {
                        space_id: personal_id.clone(),
                        incarnation: HistoryIncarnation::from_bytes([1; 16]),
                    })
                    .unwrap(),
                    expires_at: old + 60_000,
                },
            ],
        )
        .await
        .unwrap();
    fixture
        .observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;

    // Two passes ensure child rows (access/refresh tokens, schedule runs) are pruned so parent
    // tombstones (oauth_refresh_families, deleted agent_schedules) also become childless if needed,
    // though in one 200-budget pass cleanup_telemetry already orders children before parents!
    let cleanup = control
        .cleanup_telemetry(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Telemetry),
                budget: budget(),
            },
            200,
        )
        .await
        .unwrap();
    assert_eq!(cleanup.calls, 1, "orphaned >24h agent_call must be pruned");
    assert!(
        cleanup.commands >= 1,
        "expired committed command must be pruned despite unrelated fresh revocation_event"
    );

    // Fresh undelivered revocation_event and active bootstrap session remain intact.
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NULL")
            .await,
        1
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM sessions")
            .await,
        1
    );

    // Every seeded expired/aged row across all 12 operational tables was pruned in a single pass.
    for sql in [
        "SELECT COUNT(*) FROM agent_calls",
        "SELECT COUNT(*) FROM one_time_tokens",
        "SELECT COUNT(*) FROM oauth_auth_codes",
        "SELECT COUNT(*) FROM oauth_access_tokens",
        "SELECT COUNT(*) FROM oauth_refresh_tokens",
        "SELECT COUNT(*) FROM oauth_refresh_families",
        "SELECT COUNT(*) FROM oidc_transactions",
        "SELECT COUNT(*) FROM mcp_dedup",
        "SELECT COUNT(*) FROM provider_budget_buckets",
        "SELECT COUNT(*) FROM provider_call_log",
        "SELECT COUNT(*) FROM agent_schedule_runs",
        "SELECT COUNT(*) FROM agent_schedules",
        "SELECT COUNT(*) FROM revocation_events WHERE delivered_at IS NOT NULL",
        "SELECT COUNT(*) FROM control_operations WHERE operation_id = 'req_41414141414141414141414141414141'",
    ] {
        assert_eq!(
            fixture.observer.count(sql).await,
            0,
            "unpruned row in: {sql}"
        );
    }

    drop(oidc);
    drop(control);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_concurrency_50r_12w_trusted_none_and_untainted_metadata() {
    run_concurrency_and_taint(false).await;
}
#[tokio::test]
async fn postgres_concurrency_50r_12w_trusted_none_and_untainted_metadata() {
    run_concurrency_and_taint(true).await;
}

#[tokio::test]
async fn sqlite_human_management_preferences_and_selected_abilities() {
    run_management_preferences_and_selected_abilities(false).await;
}
#[tokio::test]
async fn postgres_human_management_preferences_and_selected_abilities() {
    run_management_preferences_and_selected_abilities(true).await;
}

#[tokio::test]
async fn sqlite_oidc_dos_invariants_and_12_table_gc() {
    run_oidc_dos_invariants_and_12_table_gc(false).await;
}
#[tokio::test]
async fn postgres_oidc_dos_invariants_and_12_table_gc() {
    run_oidc_dos_invariants_and_12_table_gc(true).await;
}

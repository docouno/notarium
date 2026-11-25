//! End-to-end public-API regressions covering cross-layer seams on SQLite and PostgreSQL.
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use notarium_agents::{
    chats::{AgentRunSupervisor, ChatRunOptions, ExclusiveDataRoot, StartChatRun},
    keepers::KeeperScheduler,
    mcp::{
        ConfirmProposedDiff, EgressTarget, McpInvocationContext, PersonalToolInvocation,
        ToolRegistry,
    },
};
use notarium_canonical::{CreateFolderSpec, SqlBackendConfig, build_pg_connect_options};
use notarium_control::{
    auth::token::{TokenKind, mint},
    outbound::{NetworkPolicy, OutboundTransport, PrivateNetworkRule},
    service::{
        ControlPlane,
        provider::{ProviderConfig, ProviderService},
    },
};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, SpaceKind, SpaceRole},
    classes::{AbilityKind, DocClass},
    error::{CommitEffect, PortError, RetryAdvice, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope, NoteRef},
    ports::{schedules::*, *},
    receipt::{AccountCommandIdentity, CausalBasis, CommandIdentity},
    value::Timestamp,
};
use notarium_projections::{ProjectionConfig, ProjectorRuntime};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
    layout::SearchLayout,
    ports::{
        EmbeddingBackendTarget, RemoteIndexingGrant, ResolvedEmbeddingTarget,
        SearchModelResolverPort,
    },
};
use serde_json::{Value, json};
use sqlx::Connection as _;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

use super::{
    engine::{ProjectionFixture, ProjectionFixtures},
    real_reads::DerivedReads,
    runtime_ability_cases::{
        LoopbackProvider, approve_disclosure, identity, loopback_provider,
        loopback_provider_with_limits, read_request, send_ollama,
    },
    supervised_chat_cases::idle_leaf,
    *,
};

struct SeamSearchModelResolver(Arc<ProviderService>);

impl SearchModelResolverPort for SeamSearchModelResolver {
    fn resolve_model<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        explicit: Option<&'a ModelProfileId>,
        budget: &'a CallBudget,
    ) -> PortFuture<'a, Option<ResolvedEmbeddingTarget>> {
        Box::pin(async move {
            let resolved = self
                .0
                .resolve_search_embedding_model(
                    authority,
                    scope.clone(),
                    explicit.cloned(),
                    budget.clone(),
                )
                .await?;
            Ok(resolved.map(|item| ResolvedEmbeddingTarget {
                model: item.model,
                dimension: item.dimension,
                max_input_tokens: item.max_input_tokens,
                backend: EmbeddingBackendTarget::Remote {
                    provider: item.provider,
                    runtime_epochs: item.runtime_epochs,
                    project: item.project,
                },
            }))
        })
    }

    fn remote_indexing_revision<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        budget: CallBudget,
    ) -> PortFuture<'a, ContentDigest> {
        Box::pin(
            self.0
                .search_indexing_revision(authority, &scope.space_id, budget),
        )
    }

    fn acquire_remote_indexing_grant<'a>(
        &'a self,
        authority: &'a ServiceAuthority,
        scope: &'a HistoryScope,
        revision_actor: &'a PrincipalId,
        provider: &'a ProviderResourceId,
        project: Option<&'a FolderRef>,
        budget: CallBudget,
    ) -> PortFuture<'a, Option<RemoteIndexingGrant>> {
        Box::pin(async move {
            Ok(self
                .0
                .admit_search_indexing(
                    authority,
                    scope.clone(),
                    revision_actor,
                    provider,
                    project,
                    budget,
                )
                .await?
                .map(|(ctx, policy)| RemoteIndexingGrant { ctx, policy }))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_seam_hardening() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise_seams(false)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_seam_hardening() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(exercise_seams(true)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_keeper_single_connection_pool_no_deadlock() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    let fixture =
        RuntimeFixture::open_named_with_pg_pool(true, "keeper_pg_pool_one", Some(1)).await;
    assert!(matches!(
        fixture.canonical_config.sql,
        SqlBackendConfig::Postgres { pool_size: 1, .. }
    ));
    Box::pin(run_single_pool_keeper(&fixture)).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_authority_narrowing_chat_and_replay_seams() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    let mut fixture =
        box_step(|| RuntimeFixture::open_named(false, "authority_narrowing_seams")).await;
    let personal = fixture.personal_scope().await;
    box_step(|| authority_narrowing_chat_and_replay_seams(&mut fixture, &personal)).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_authority_narrowing_chat_and_replay_seams() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    let mut fixture =
        box_step(|| RuntimeFixture::open_named(true, "authority_narrowing_seams")).await;
    let personal = fixture.personal_scope().await;
    box_step(|| authority_narrowing_chat_and_replay_seams(&mut fixture, &personal)).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_centralized_control_and_delta_taint_isolation() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(run_centralized_control_and_delta_taint_isolation(false)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_centralized_control_and_delta_taint_isolation() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(run_centralized_control_and_delta_taint_isolation(true)).await;
}

async fn run_centralized_control_and_delta_taint_isolation(pg: bool) {
    let fixture = RuntimeFixture::open_named(pg, "centralized_control_delta_taint").await;
    let personal = fixture.personal_scope().await;
    let owner = fresh_owner(&fixture).await;
    let actor = owner.auth().principal().clone();
    let sa = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(&fixture, &owner, 0xD1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD1; 16]),
                    kind: SpaceKind::Shared,
                    name: "Centralized Narrowing Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(&fixture).await;
    let sa_p1 = create_project_folder(
        &fixture,
        &sa.history,
        &actor,
        FolderId::from_bytes([0xD1; 16]),
        "central-p1",
    )
    .await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, &owner, &listener, 0xD2, false).await;

    centralized_control_narrowing_assertions(
        &fixture,
        &local.provider,
        personal.scope(),
        &sa.history,
        &sa_p1,
        &actor,
    )
    .await;
    delta_log_and_seed_with_tainted_chat_assertions(&fixture, personal.scope(), &actor).await;

    fixture.close().await;
}

#[inline(never)]
fn box_step<'a, T, Fut>(
    make: impl FnOnce() -> Fut,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>
where
    Fut: std::future::Future<Output = T> + Send + 'a,
{
    Box::pin(make())
}

#[inline(never)]
async fn exercise_seams(pg: bool) {
    let mut fixture = box_step(|| RuntimeFixture::open_named(pg, "seam_hardening")).await;
    let personal = fixture.personal_scope().await;

    box_step(|| project_scoped_chat_starts_ai_and_blocks_foreign_project(&fixture, &personal))
        .await;
    box_step(|| remote_embedding_query_blocks_unconsented_model_sources(&fixture, &personal, pg))
        .await;
    box_step(|| cross_space_same_named_roles_keep_start_session_working(&fixture)).await;
    box_step(|| four_large_tool_results_do_not_wedge_32k_branch(&fixture, &personal)).await;
    box_step(|| composite_writes_upgrade_post_partial_commit_errors(&fixture, &personal)).await;
    box_step(|| {
        rollback_run_stops_active_keeper_and_rejects_unsettled_runs(&mut fixture, &personal)
    })
    .await;
    box_step(|| project_memory_proposal_preview_shows_destination(&fixture, &personal)).await;
    box_step(|| closed_chat_episode_recovers_and_role_typo_leaves_no_orphan(&fixture, &personal))
        .await;
    box_step(|| in_app_delete_note_replay_succeeds_with_same_key(&fixture, &personal)).await;
    box_step(|| keeper_one_shot_tick_handles_multi_boundary_clock_skew(&fixture)).await;
    box_step(|| bootstrap_continuation_sliding_ttl_survives_multi_page_resync(&fixture)).await;
    box_step(|| folder_heads_space_updated_index_present(&fixture, pg)).await;
    box_step(|| tainted_personal_chat_in_shared_space_releases_claim_cleanly(&fixture, &personal))
        .await;
    let promoted_setup = box_step(|| {
        project_only_consent_space_ability_and_unconsented_episode_hint(&fixture, &personal)
    })
    .await;
    box_step(|| {
        promoted_ability_project_only_consent_boundary(&fixture, &personal, promoted_setup)
    })
    .await;
    let cross_setup =
        box_step(|| cross_space_taint_oracle_and_write_isolation_probes(&fixture, &personal)).await;
    box_step(|| {
        cross_space_recent_and_ability_filter_taint_probes(&fixture, &personal, cross_setup)
    })
    .await;
    box_step(|| space_group_role_isolation_and_ability_list_oracle_probes(&fixture, &personal))
        .await;
    box_step(|| staged_taint_list_notes_cursor_and_proposal_preflight_probes(&fixture, &personal))
        .await;
    box_step(|| {
        confirmed_link_many_trashed_target_and_project_move_note_replays(&fixture, &personal)
    })
    .await;
    box_step(|| {
        runtime_skill_omission_project_only_shadowing_and_dedup_hygiene(&mut fixture, &personal)
    })
    .await;
    box_step(|| locate_ability_cap_and_legacy_mixed_case_id_pagination_parity(&fixture, &personal))
        .await;
    box_step(|| schedule_provider_replay_shared_chat_and_post_trash_seams(&fixture, &personal))
        .await;

    fixture.close().await;
}

async fn fresh_owner(fixture: &RuntimeFixture) -> AccountContext {
    AccountContext::new(
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
    )
}

async fn create_project_folder(
    fixture: &RuntimeFixture,
    scope: &HistoryScope,
    owner: &PrincipalId,
    folder_id: FolderId,
    slug: &str,
) -> FolderRef {
    let active_epoch = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch,
            folder_id: folder_id.clone(),
            parent: None,
            slug: slug.into(),
            display_name: slug.into(),
            is_project: true,
            project_slug: Some(slug.into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    FolderRef {
        space_id: scope.space_id.clone(),
        folder_id,
    }
}

async fn call_mcp(
    registry: &ToolRegistry,
    account: &AccountContext,
    key: [u8; 16],
    tool: &str,
    args: Value,
) -> Result<McpToolResult, PortError> {
    registry
        .call_tool(
            McpInvocationContext {
                account: account.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes(key),
            },
            tool,
            args,
        )
        .await
}

/// Project-scoped chats must start AI normally, while still preventing a
/// project-scoped AgentRun from mutating threads in another project or root.
async fn project_scoped_chat_starts_ai_and_blocks_foreign_project(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let project_a = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0x61; 16]),
        "chat-alpha",
    )
    .await;
    let project_b = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0x62; 16]),
        "chat-beta",
    )
    .await;

    let cmd = |tag: u8| CommandIdentity {
        scope: scope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([0x61, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
        hash: ContentDigest::from_bytes([0x61; 32]),
    };
    let thread_a = ChatThreadId::from_bytes([0x61; 16]);
    let thread_b = ChatThreadId::from_bytes([0x62; 16]);
    for (tag, tid, pf) in [
        (1, &thread_a, Some(project_a.folder_id.clone())),
        (2, &thread_b, Some(project_b.folder_id.clone())),
    ] {
        fixture
            .canonical
            .create_chat(
                personal.clone(),
                Mutation {
                    identity: cmd(tag),
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: tid.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: pf,
                        title: format!("Project thread {tag}"),
                    },
                },
            )
            .await
            .unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x61, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x63,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        limits: RunLimits {
            max_steps: 2,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
        ..ChatRunOptions::default()
    };

    // Normal enqueue_input on a project chat must both persist the human input
    // AND start the AI run (returning run = Some(_)).
    let submitted = supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: cmd(3),
                id: PendingInputId::from_bytes([0x61; 16]),
                thread: thread_a.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Hello project chat!".into(),
                mentions_agent: false,
            },
            options.clone(),
        )
        .await
        .unwrap();
    assert!(
        submitted.run.is_some(),
        "project chat submission must start an AI run"
    );
    let (mut wire, _prompt) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("project chat run must reach provider");
    send_ollama(
        &mut wire,
        json!({"role": "assistant", "content": "Project reply ok."}),
        "stop",
    )
    .await;
    let leaf = idle_leaf(fixture, personal, &thread_a).await;
    assert_eq!(leaf.get(), 2);

    // Explicit `start` on the same project chat must also succeed.
    let explicit_run = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: scope.clone(),
                thread: thread_a.clone(),
                expected_leaf: leaf,
                options,
            },
        )
        .await
        .expect("explicit start on project chat must not return SpaceReadOnly");
    let (mut wire, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("explicit start on project chat must reach provider");
    send_ollama(
        &mut wire,
        json!({"role": "assistant", "content": "Second project reply."}),
        "stop",
    )
    .await;
    let _ = idle_leaf(fixture, personal, &thread_a).await;
    assert_ne!(explicit_run, submitted.run.unwrap());

    // Security invariant: an AgentRun pinned to project A must STILL be
    // rejected with ResourceNotFound (matching an absent thread, closing the
    // thread-existence oracle) if it tries to claim or mutate project B's thread.
    let mut grants = owner.auth().spaces().clone();
    grants.get_mut(&scope.space_id).unwrap().project_root = Some(project_a.folder_id.clone());
    let run_a_id = AgentRunId::from_bytes([0x64; 16]);
    let run_a_auth = owner
        .auth()
        .for_agent_run(
            run_a_id.clone(),
            scope.space_id.clone(),
            ChatAudience::Personal,
            grants,
        )
        .unwrap();
    let run_a_ctx = SpaceContext::new(run_a_auth, scope.clone(), budget()).unwrap();
    let foreign_claim = fixture
        .canonical
        .claim_active_run(
            run_a_ctx.clone(),
            ClaimChatRun {
                thread: thread_b.clone(),
                run: run_a_id.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await;
    assert!(
        matches!(
            foreign_claim,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "project-A AgentRun must see ResourceNotFound on project-B thread (no existence oracle), got {foreign_claim:?}"
    );
    let absent_claim = fixture
        .canonical
        .claim_active_run(
            run_a_ctx.clone(),
            ClaimChatRun {
                thread: ChatThreadId::from_bytes([0x6E; 16]),
                run: run_a_id.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await;
    assert!(
        matches!(
            absent_claim,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "absent thread claim must also return ResourceNotFound, got {absent_claim:?}"
    );
    let foreign_create = fixture
        .canonical
        .create_chat(
            run_a_ctx.clone(),
            Mutation {
                identity: cmd(9),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: ChatThreadId::from_bytes([0x69; 16]),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: Some(project_a.folder_id.clone()),
                    title: "Disallowed agent create".into(),
                },
            },
        )
        .await;
    assert!(
        matches!(
            foreign_create,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "project-scoped AgentRun must not create chats, got {foreign_create:?}"
    );
    // Replaying an already-committed create_chat key as a project-scoped AgentRun
    // must still fail upfront with SpaceReadOnly instead of replaying the receipt.
    let replayed_create = fixture
        .canonical
        .create_chat(
            run_a_ctx.clone(),
            Mutation {
                identity: cmd(1),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread_a.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: Some(project_a.folder_id.clone()),
                    title: "Project thread 1".into(),
                },
            },
        )
        .await;
    assert!(
        matches!(
            replayed_create,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "project-scoped AgentRun must not replay committed create_chat, got {replayed_create:?}"
    );

    // An AgentRun must not forge Human entries or submit human chat queue inputs.
    let forged_human = fixture
        .canonical
        .append_chat(
            run_a_ctx.clone(),
            Mutation {
                identity: cmd(10),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread_a.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("forged human message".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            forged_human,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidAuthority
        ),
        "AgentRun must not append ChatEntryKind::Human, got {forged_human:?}"
    );
    let agent_queue = fixture
        .canonical
        .queue_chat_input(
            run_a_ctx,
            Mutation {
                identity: cmd(11),
                preconditions: Preconditions::default(),
                input: PendingChatInput {
                    id: PendingInputId::from_bytes([0x6B; 16]),
                    thread: thread_a.clone(),
                    sender: actor.clone(),
                    body: "agent forged queue input".into(),
                    queued_base_leaf: ThreadEntrySeq::ZERO,
                    in_flight_run: run_a_id.clone(),
                    mentions_agent: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            agent_queue,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidAuthority
        ),
        "AgentRun must not call queue_chat_input, got {agent_queue:?}"
    );
    let pat = fixture.pat(BearerScope::Write, false).await;
    let pat_space = SpaceContext::new(pat.auth().clone(), scope.clone(), budget()).unwrap();
    let pat_human_append = fixture
        .canonical
        .append_chat(
            pat_space.clone(),
            Mutation {
                identity: cmd(13),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread_a.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("pat forged human message".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            pat_human_append,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidAuthority
        ),
        "PAT bearer must not append ChatEntryKind::Human, got {pat_human_append:?}"
    );
    let pat_queue = fixture
        .canonical
        .queue_chat_input(
            pat_space,
            Mutation {
                identity: cmd(12),
                preconditions: Preconditions::default(),
                input: PendingChatInput {
                    id: PendingInputId::from_bytes([0x6C; 16]),
                    thread: thread_a,
                    sender: actor.clone(),
                    body: "pat forged queue input".into(),
                    queued_base_leaf: ThreadEntrySeq::ZERO,
                    in_flight_run: run_a_id,
                    mentions_agent: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            pat_queue,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidAuthority
        ),
        "PAT bearer must not call queue_chat_input, got {pat_queue:?}"
    );

    // Non-Keepers (including the Space owner) must NOT append to or fork a KeeperLog,
    // and an unrelated Keeper must see ResourceNotFound (not SpaceReadOnly).
    let keeper_log_id = ChatThreadId::from_bytes([0x6D; 16]);
    let make_keeper_ctx = |tag: u8, log: ChatThreadId| {
        let run = AgentRunId::from_bytes([tag; 16]);
        let auth = notarium_core::auth::EngineAuthContext::for_human(
            notarium_core::auth::VerifiedHuman::attest(
                actor.clone(),
                GrantId::from_bytes([tag; 16]),
                owner.auth().spaces().clone(),
                false,
            )
            .with_credential(
                notarium_core::auth::AuthenticatedCredential::ScheduledRun {
                    schedule: ScheduleId::from_bytes([tag; 16]),
                    run: run.clone(),
                    lease: LeaseEpoch::new(1).unwrap(),
                },
            ),
        )
        .for_keeper(run, scope.space_id.clone(), None, BTreeSet::new())
        .unwrap()
        .with_verified_keeper_log(log)
        .unwrap();
        SpaceContext::new(auth, scope.clone(), budget()).unwrap()
    };
    let keeper_ctx = make_keeper_ctx(0x6D, keeper_log_id.clone());
    fixture
        .canonical
        .create_chat(
            keeper_ctx,
            Mutation {
                identity: cmd(14),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: keeper_log_id.clone(),
                    kind: ChatThreadKind::KeeperLog,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Keeper audit log".into(),
                },
            },
        )
        .await
        .unwrap();
    let owner_append_log = fixture
        .canonical
        .append_chat(
            personal.clone(),
            Mutation {
                identity: cmd(15),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: keeper_log_id.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("human append to keeper log".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            owner_append_log,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "DirectHuman owner must not append to KeeperLog, got {owner_append_log:?}"
    );
    let owner_fork_log = fixture
        .canonical
        .fork_chat(
            personal.clone(),
            Mutation {
                identity: cmd(16),
                preconditions: Preconditions::default(),
                input: ForkChat {
                    thread: keeper_log_id.clone(),
                    parent: ThreadEntrySeq::ZERO,
                },
            },
        )
        .await;
    assert!(
        matches!(
            owner_fork_log,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "DirectHuman owner must not fork KeeperLog, got {owner_fork_log:?}"
    );
    let other_keeper_ctx = make_keeper_ctx(0x6F, ChatThreadId::from_bytes([0x6F; 16]));
    let other_keeper_append = fixture
        .canonical
        .append_chat(
            other_keeper_ctx,
            Mutation {
                identity: cmd(17),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: keeper_log_id.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("other keeper probe".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            other_keeper_append,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "unrelated Keeper must see ResourceNotFound on another KeeperLog, got {other_keeper_append:?}"
    );

    // A ChatAudience::Shared AgentRun on Alice's Space must NOT read or observe Alice's
    // private KeeperLog (both read_chat and append_chat must return ResourceNotFound).
    let shared_audience_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x6E; 16]),
            scope.space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shared_audience_ctx =
        SpaceContext::new(shared_audience_auth, scope.clone(), budget()).unwrap();
    let shared_read_log = fixture
        .canonical
        .read_chat(
            shared_audience_ctx.clone(),
            ChatRead {
                thread: keeper_log_id.clone(),
                leaf: ThreadEntrySeq::ZERO,
                before: None,
                max_entries: PageLimit::new(10).unwrap(),
            },
        )
        .await;
    assert!(
        matches!(
            shared_read_log,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "Shared-audience AgentRun must NOT read owner's private KeeperLog, got {shared_read_log:?}"
    );
    let shared_append_log = fixture
        .canonical
        .append_chat(
            shared_audience_ctx,
            Mutation {
                identity: cmd(18),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: keeper_log_id.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("shared audience probe".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            shared_append_log,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "Shared-audience AgentRun must see ResourceNotFound on KeeperLog write, got {shared_append_log:?}"
    );

    // Thread-existence oracles on queue methods:
    // 1. Project-A AgentRun calling list_pending_chat_inputs on out-of-project thread_b
    //    or KeeperLog must receive ResourceNotFound (not InvalidAuthority).
    let run_a_probe_ctx = SpaceContext::new(
        owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0x64; 16]),
                scope.space_id.clone(),
                ChatAudience::Personal,
                {
                    let mut g = owner.auth().spaces().clone();
                    g.get_mut(&scope.space_id).unwrap().project_root =
                        Some(project_a.folder_id.clone());
                    g
                },
            )
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    for probe_tid in [
        thread_b.clone(),
        keeper_log_id.clone(),
        ChatThreadId::from_bytes([0x68; 16]),
    ] {
        let res = fixture
            .canonical
            .list_pending_chat_inputs(run_a_probe_ctx.clone(), probe_tid)
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "list_pending_chat_inputs must hide invisible/absent threads as ResourceNotFound, got {res:?}"
        );
    }
    // 2. Project-scoped DirectHuman calling recover_active_run must fail with
    //    SpaceReadOnly before loading the thread (identical for existing and absent threads).
    let scoped_human = owner.auth().restrict_to_project(&project_a).unwrap();
    let scoped_human_space = SpaceContext::new(scoped_human, scope, budget()).unwrap();
    for probe_tid in [thread_b, ChatThreadId::from_bytes([0x67; 16])] {
        let res = fixture
            .canonical
            .recover_active_run(
                scoped_human_space.clone(),
                ChatRunRequest {
                    thread: probe_tid,
                    expected_run: AgentRunId::from_bytes([0x64; 16]),
                },
            )
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::SpaceReadOnly))),
            "project-scoped DirectHuman recover_active_run must fail with SpaceReadOnly before thread lookup, got {res:?}"
        );
    }
}

/// An AgentRun whose completion provider is consented to AgentMemory must
/// not send model-authored search queries to a remote embedding provider that is
/// only consented to UserDoc (falling back cleanly to lexical search), whereas a
/// narrow completion provider consented only to UserDoc may use it.
async fn remote_embedding_query_blocks_unconsented_model_sources(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    pg: bool,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let emb_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let emb_addr = emb_listener.local_addr().unwrap();
    let emb_hits = Arc::new(AtomicUsize::new(0));
    let emb_hits_srv = Arc::clone(&emb_hits);
    let emb_server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = emb_listener.accept().await {
            let emb_hits_srv = Arc::clone(&emb_hits_srv);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let header_end = loop {
                    let read = stream.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buf[..header_end]);
                let content_length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while buf.len() < header_end + content_length {
                    let read = stream.read(&mut tmp).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..read]);
                }
                let parsed: Value =
                    serde_json::from_slice(&buf[header_end..header_end + content_length])
                        .unwrap_or(Value::Null);
                let count = match parsed.get("input") {
                    Some(Value::Array(items)) => items.len().max(1),
                    _ => 1,
                };
                emb_hits_srv.fetch_add(1, Ordering::SeqCst);
                let mut unit = vec![0.0_f32; 64];
                unit[0] = 1.0;
                let embeddings = vec![unit; count];
                let body = serde_json::to_vec(&json!({
                    "model": "embed-fixture",
                    "embeddings": embeddings,
                    "prompt_eval_count": 8,
                }))
                .unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            });
        }
    });

    let chat_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_addr = chat_listener.local_addr().unwrap();
    let emb_res = ProviderResourceId::from_bytes([0x71; 16]);
    let emb_model = ModelProfileId::from_bytes([0x71; 16]);
    let chat_wide_res = ProviderResourceId::from_bytes([0x74; 16]);
    let chat_wide_model = ModelProfileId::from_bytes([0x74; 16]);
    let chat_narrow_res = ProviderResourceId::from_bytes([0x77; 16]);
    let chat_narrow_model = ModelProfileId::from_bytes([0x77; 16]);
    let emb_origin = format!("http://127.0.0.1:{}", emb_addr.port());
    let chat_origin = format!("http://127.0.0.1:{}", chat_addr.port());
    let loopback: ipnet::IpNet = "127.0.0.1/32".parse().unwrap();
    let network = NetworkPolicy::new(vec![
        PrivateNetworkRule::new(emb_res.clone(), &emb_origin, vec![loopback]).unwrap(),
        PrivateNetworkRule::new(chat_wide_res.clone(), &chat_origin, vec![loopback]).unwrap(),
        PrivateNetworkRule::new(chat_narrow_res.clone(), &chat_origin, vec![loopback]).unwrap(),
    ])
    .unwrap();
    let catalog = Arc::new(notarium_agents::abilities::SystemAbilityCatalog::new(
        Arc::new(fixture.canonical.clone()),
    ));
    let provider_svc = Arc::new(
        ProviderService::new(
            fixture.control.clone(),
            fixture.keyring.clone(),
            Arc::new(OutboundTransport::new(network)),
            catalog.clone(),
            ProviderConfig::default(),
        )
        .unwrap(),
    );

    // Resource 1: remote embedding provider consented ONLY to UserDoc.
    let saved_emb = provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x71).await,
                input: ProviderResourceSpec {
                    id: emb_res.clone(),
                    name: "UserDoc-only embedder".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: emb_origin,
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x72).await,
                input: PutProviderModel {
                    resource: emb_res.clone(),
                    expected: saved_emb.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: emb_model.clone(),
                        wire_name: "embed-fixture".into(),
                        kind: ProviderModelKind::Embedding { dimension: 64 },
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 4096,
                        max_output_tokens: 0,
                        tools: false,
                    },
                },
            },
        )
        .await
        .unwrap();
    let emb_info = provider_svc
        .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == emb_res)
        .unwrap();
    let att = provider_svc
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x73).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([0x73; 16]),
                    expected: None,
                    resource: emb_info.id.clone(),
                    resource_consent_epoch: emb_info.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: scope.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: [DocClass::UserDoc].into(),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    if att.state != ProviderAttachmentState::Approved {
        provider_svc
            .approve_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x6F).await,
                    input: ApproveProviderAttachment {
                        id: att.id,
                        expected: att.revision,
                        resource_consent_epoch: att.resource_consent_epoch,
                        credential_consent_epoch: att.credential_consent_epoch,
                        consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                            classes: [DocClass::UserDoc].into(),
                        }),
                    },
                },
            )
            .await
            .unwrap();
    }
    provider_svc
        .set_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x70).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Embedding,
                    resource: emb_res.clone(),
                    model: emb_model.clone(),
                },
            },
        )
        .await
        .unwrap();

    // Resource 2: wide chat provider consented to UserDoc + AgentMemory.
    let saved_wide = provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x74).await,
                input: ProviderResourceSpec {
                    id: chat_wide_res.clone(),
                    name: "Wide chat provider".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: chat_origin.clone(),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x75).await,
                input: PutProviderModel {
                    resource: chat_wide_res.clone(),
                    expected: saved_wide.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: chat_wide_model.clone(),
                        wire_name: "chat-wide".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 16_384,
                        max_output_tokens: 1024,
                        tools: true,
                    },
                },
            },
        )
        .await
        .unwrap();
    let wide_info = provider_svc
        .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == chat_wide_res)
        .unwrap();
    let wide_att = provider_svc
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x76).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([0x76; 16]),
                    expected: None,
                    resource: wide_info.id.clone(),
                    resource_consent_epoch: wide_info.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: scope.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: [DocClass::UserDoc, DocClass::AgentMemory].into(),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;

    // Resource 3: narrow chat provider consented ONLY to UserDoc.
    let saved_narrow = provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x77).await,
                input: ProviderResourceSpec {
                    id: chat_narrow_res.clone(),
                    name: "Narrow chat provider".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: chat_origin,
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x78).await,
                input: PutProviderModel {
                    resource: chat_narrow_res.clone(),
                    expected: saved_narrow.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: chat_narrow_model.clone(),
                        wire_name: "chat-narrow".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 16_384,
                        max_output_tokens: 1024,
                        tools: true,
                    },
                },
            },
        )
        .await
        .unwrap();
    let narrow_info = provider_svc
        .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == chat_narrow_res)
        .unwrap();
    provider_svc
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x79).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([0x79; 16]),
                    expected: None,
                    resource: narrow_info.id.clone(),
                    resource_consent_epoch: narrow_info.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: scope.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: [DocClass::UserDoc].into(),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();

    // Run one real completion step for `wide_run` on `chat_wide_res` and one for
    // `narrow_run` on `chat_narrow_res` so `provider_call_log` binds each run.
    let run_one_completion = |run_id: AgentRunId,
                              res_id: ProviderResourceId,
                              model_id: ModelProfileId,
                              intent_tag: u8| {
        let provider_svc = provider_svc.clone();
        let owner = owner.clone();
        let scope = scope.clone();
        let listener = &chat_listener;
        async move {
            let auth = owner
                .auth()
                .for_agent_run(
                    run_id,
                    scope.space_id.clone(),
                    ChatAudience::Personal,
                    owner.auth().spaces().clone(),
                )
                .unwrap();
            let ctx = SpaceContext::new(auth.clone(), scope.clone(), budget()).unwrap();
            let selection = provider_svc
                .select_provider(
                    ctx.clone(),
                    SelectProvider {
                        kind: PreferenceModelKind::Completion,
                        resource: Some(res_id),
                        model: Some(model_id),
                        project: None,
                    },
                )
                .await
                .unwrap();
            let req = CompletionRequest {
                intent: CommandKey::from_bytes([intent_tag; 16]),
                selection,
                secondary_projects: vec![],
                messages: vec![CompletionMessage {
                    role: CompletionRole::User,
                    instruction: Some(
                        ProviderInstruction::from_orchestrator("Plan search".into()).unwrap(),
                    ),
                    parts: vec![],
                    tool_calls: vec![],
                    result_for: None,
                }],
                tools: vec![],
                budget: CompletionBudget {
                    max_input_tokens: 4096,
                    max_output_tokens: 128,
                    max_tool_calls: 0,
                },
            };
            let call_fut = provider_svc.complete(ctx.clone(), req);
            let serve_fut = async {
                let (mut wire, _) = timeout(Duration::from_secs(10), read_request(listener))
                    .await
                    .unwrap();
                send_ollama(
                    &mut wire,
                    json!({"role": "assistant", "content": "done"}),
                    "stop",
                )
                .await;
            };
            let (stream_res, ()) = tokio::join!(call_fut, serve_fut);
            let mut stream = stream_res.unwrap();
            while let Some(ev) = stream.next().await.unwrap() {
                if matches!(ev, CompletionEvent::Finished(_)) {
                    break;
                }
            }
            ctx
        }
    };

    let wide_run_ctx = run_one_completion(
        AgentRunId::from_bytes([0x7A; 16]),
        chat_wide_res.clone(),
        chat_wide_model.clone(),
        0x7A,
    )
    .await;
    let narrow_run_ctx = run_one_completion(
        AgentRunId::from_bytes([0x7B; 16]),
        chat_narrow_res.clone(),
        chat_narrow_model.clone(),
        0x7B,
    )
    .await;

    // 1. Direct query_disclosure + direct embed for `wide_run` MUST refuse UserDoc-only embedder.
    let disclosed_wide = EmbeddingProviderPort::query_disclosure(
        provider_svc.as_ref(),
        wide_run_ctx.clone(),
        emb_res.clone(),
        emb_model.clone(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        disclosed_wide.is_empty(),
        "query_disclosure must return empty when AgentRun completion provider had AgentMemory consent but embedder allows only UserDoc"
    );
    let direct_wide = provider_svc
        .embed(
            wide_run_ctx.clone(),
            EmbeddingRequest::query(
                CommandKey::from_bytes([0x7C; 16]),
                emb_model.clone(),
                emb_res.clone(),
                EmbeddingQueryInput {
                    text: "secret copied from AgentMemory".into(),
                    tokens: 8,
                    classes: [DocClass::UserDoc].into(),
                    project_scope: None,
                    folder: None,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            direct_wide,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::ClassEgressForbidden
        ),
        "direct embed for wide AgentRun must fail with ClassEgressForbidden, got {direct_wide:?}"
    );
    assert_eq!(
        emb_hits.load(Ordering::SeqCst),
        0,
        "no HTTP bytes may reach the UserDoc-only embedding provider for wide AgentRun"
    );

    // 1b. Even if the owner narrows `chat_wide_res`'s attachment IN-PLACE to UserDoc-only
    //     AFTER `wide_run` already completed a call under `{UserDoc, AgentMemory}`, the
    //     recorded per-call disclosure snapshot must STILL block `wide_run` from hitting
    //     the UserDoc-only embedder!
    let owner = fresh_owner(fixture).await;
    let wide_att_narrowed = provider_svc
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x70 ^ 0x1F).await,
                input: RequestProviderAttachment {
                    id: wide_att.id.clone(),
                    expected: Some(wide_att.revision),
                    resource: wide_info.id.clone(),
                    resource_consent_epoch: wide_info.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: scope.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: [DocClass::UserDoc].into(),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let disclosed_after_narrow = EmbeddingProviderPort::query_disclosure(
        provider_svc.as_ref(),
        wide_run_ctx.clone(),
        emb_res.clone(),
        emb_model.clone(),
        None,
        None,
    )
    .await
    .unwrap();
    assert!(
        disclosed_after_narrow.is_empty(),
        "narrowing attachment in place must not launder historical AgentMemory disclosure for wide_run"
    );
    let direct_after_narrow = provider_svc
        .embed(
            wide_run_ctx.clone(),
            EmbeddingRequest::query(
                CommandKey::from_bytes([0x6A; 16]),
                emb_model.clone(),
                emb_res.clone(),
                EmbeddingQueryInput {
                    text: "still tainted by prior AgentMemory step".into(),
                    tokens: 8,
                    classes: [DocClass::UserDoc].into(),
                    project_scope: None,
                    folder: None,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            direct_after_narrow,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::ClassEgressForbidden
        ),
        "narrowing attachment in place must still reject wide_run embed with ClassEgressForbidden, got {direct_after_narrow:?}"
    );
    assert_eq!(emb_hits.load(Ordering::SeqCst), 0);
    // Restore `{UserDoc, AgentMemory}` consent on `chat_wide_res` for step 3(b)'s fresh unlogged run.
    provider_svc
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x6E).await,
                input: RequestProviderAttachment {
                    id: wide_att.id,
                    expected: Some(wide_att_narrowed.revision),
                    resource: wide_info.id,
                    resource_consent_epoch: wide_info.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: scope.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: [DocClass::UserDoc, DocClass::AgentMemory].into(),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap();

    // 2. Control positive case: `narrow_run` (whose completion provider only allowed
    //    UserDoc) IS allowed to query the UserDoc-only embedding provider!
    let disclosed_narrow = EmbeddingProviderPort::query_disclosure(
        provider_svc.as_ref(),
        narrow_run_ctx.clone(),
        emb_res.clone(),
        emb_model.clone(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(disclosed_narrow, [DocClass::UserDoc].into());
    let direct_narrow = provider_svc
        .embed(
            narrow_run_ctx.clone(),
            EmbeddingRequest::query(
                CommandKey::from_bytes([0x7E; 16]),
                emb_model.clone(),
                emb_res.clone(),
                EmbeddingQueryInput {
                    text: "strictly UserDoc query".into(),
                    tokens: 6,
                    classes: [DocClass::UserDoc].into(),
                    project_scope: None,
                    folder: None,
                },
            ),
        )
        .await
        .expect("narrow UserDoc-only AgentRun must be allowed to query UserDoc-only embedder");
    assert_eq!(direct_narrow.vectors.len(), 1);
    assert_eq!(emb_hits.load(Ordering::SeqCst), 1);

    // 2b. Project-substitution exfiltration on a Shared Space: a Space-wide AgentRun
    //     that completed Step 1 under a Space-wide UserDoc provider MUST NOT send
    //     model-authored queries to a remote embedder attached ONLY to `ProjectA`,
    //     even though both allow `UserDoc`. A `ProjectA`-confined run MAY query it.
    let emb_shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x21).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x21; 16]),
                    kind: SpaceKind::Shared,
                    name: "Embed Project Isolation".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let proj_a = create_project_folder(
        fixture,
        &emb_shared.history,
        &actor,
        FolderId::from_bytes([0x22; 16]),
        "emb-proj-a",
    )
    .await;
    let proj_emb_res = ProviderResourceId::from_bytes([0x23; 16]);
    let proj_emb_model = ModelProfileId::from_bytes([0x23; 16]);
    let shared_chat_res = ProviderResourceId::from_bytes([0x24; 16]);
    let shared_chat_model = ModelProfileId::from_bytes([0x24; 16]);
    let proj_chat_res = ProviderResourceId::from_bytes([0x25; 16]);
    let proj_chat_model = ModelProfileId::from_bytes([0x25; 16]);
    let proj_network = NetworkPolicy::new(vec![
        PrivateNetworkRule::new(
            proj_emb_res.clone(),
            &format!("http://127.0.0.1:{}", emb_addr.port()),
            vec![loopback],
        )
        .unwrap(),
        PrivateNetworkRule::new(
            shared_chat_res.clone(),
            &format!("http://127.0.0.1:{}", chat_addr.port()),
            vec![loopback],
        )
        .unwrap(),
        PrivateNetworkRule::new(
            proj_chat_res.clone(),
            &format!("http://127.0.0.1:{}", chat_addr.port()),
            vec![loopback],
        )
        .unwrap(),
    ])
    .unwrap();
    let proj_provider_svc = Arc::new(
        ProviderService::new(
            fixture.control.clone(),
            fixture.keyring.clone(),
            Arc::new(OutboundTransport::new(proj_network)),
            catalog.clone(),
            ProviderConfig::default(),
        )
        .unwrap(),
    );
    let attach_and_approve =
        |res_id: ProviderResourceId, target: ProviderAttachmentTarget, req_tag: u8, app_tag: u8| {
            let svc = proj_provider_svc.clone();
            let owner = owner.clone();
            async move {
                let info = svc
                    .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
                    .await
                    .unwrap()
                    .items
                    .into_iter()
                    .find(|item| item.id == res_id)
                    .unwrap();
                let att = svc
                    .request_attachment(
                        owner.clone(),
                        AccountMutation {
                            identity: identity(fixture, &owner, req_tag).await,
                            input: RequestProviderAttachment {
                                id: RequestId::from_bytes([req_tag; 16]),
                                expected: None,
                                resource: info.id,
                                resource_consent_epoch: info.consent_epoch,
                                credential_consent_epoch: None,
                                target,
                                consent: ProviderDisclosureConsent::attest_checked(
                                    ProviderDisclosure {
                                        classes: [DocClass::UserDoc].into(),
                                    },
                                ),
                                expires_at_ms: None,
                            },
                        },
                    )
                    .await
                    .unwrap()
                    .value;
                if att.state != ProviderAttachmentState::Approved {
                    svc.approve_attachment(
                        owner.clone(),
                        AccountMutation {
                            identity: identity(fixture, &owner, app_tag).await,
                            input: ApproveProviderAttachment {
                                id: att.id,
                                expected: att.revision,
                                resource_consent_epoch: att.resource_consent_epoch,
                                credential_consent_epoch: att.credential_consent_epoch,
                                consent: ProviderDisclosureConsent::attest_checked(
                                    ProviderDisclosure {
                                        classes: [DocClass::UserDoc].into(),
                                    },
                                ),
                            },
                        },
                    )
                    .await
                    .unwrap();
                }
            }
        };

    // Embedder attached ONLY to `ProjectA`.
    let saved_proj_emb = proj_provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x22).await,
                input: ProviderResourceSpec {
                    id: proj_emb_res.clone(),
                    name: "ProjectA-only embedder".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: format!("http://127.0.0.1:{}", emb_addr.port()),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    proj_provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x23).await,
                input: PutProviderModel {
                    resource: proj_emb_res.clone(),
                    expected: saved_proj_emb.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: proj_emb_model.clone(),
                        wire_name: "embed-fixture".into(),
                        kind: ProviderModelKind::Embedding { dimension: 64 },
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 4096,
                        max_output_tokens: 0,
                        tools: false,
                    },
                },
            },
        )
        .await
        .unwrap();
    attach_and_approve(
        proj_emb_res.clone(),
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: emb_shared.history.space_id.clone(),
        },
        0x11,
        0x12,
    )
    .await;
    attach_and_approve(
        proj_emb_res.clone(),
        ProviderAttachmentTarget::Project(proj_a.clone()),
        0x24,
        0x25,
    )
    .await;

    // Space-wide Shared chat provider (`UserDoc`-only, Space attachment).
    let saved_shared_chat = proj_provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x26).await,
                input: ProviderResourceSpec {
                    id: shared_chat_res.clone(),
                    name: "Shared Space-wide chat".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: format!("http://127.0.0.1:{}", chat_addr.port()),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    proj_provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x27).await,
                input: PutProviderModel {
                    resource: shared_chat_res.clone(),
                    expected: saved_shared_chat.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: shared_chat_model.clone(),
                        wire_name: "chat-shared-wide".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 16_384,
                        max_output_tokens: 1024,
                        tools: true,
                    },
                },
            },
        )
        .await
        .unwrap();
    attach_and_approve(
        shared_chat_res.clone(),
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: emb_shared.history.space_id.clone(),
        },
        0x13,
        0x14,
    )
    .await;
    attach_and_approve(
        shared_chat_res.clone(),
        ProviderAttachmentTarget::Space(emb_shared.history.space_id.clone()),
        0x28,
        0x29,
    )
    .await;

    // ProjectA-only Shared chat provider (`UserDoc`-only, ProjectA attachment).
    let saved_proj_chat = proj_provider_svc
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x2A).await,
                input: ProviderResourceSpec {
                    id: proj_chat_res.clone(),
                    name: "ProjectA-only chat provider".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: format!("http://127.0.0.1:{}", chat_addr.port()),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    proj_provider_svc
        .put_model(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x2B).await,
                input: PutProviderModel {
                    resource: proj_chat_res.clone(),
                    expected: saved_proj_chat.value.revision,
                    default: false,
                    model: ProviderModelSpec {
                        id: proj_chat_model.clone(),
                        wire_name: "chat-proj-a".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 16_384,
                        max_output_tokens: 1024,
                        tools: true,
                    },
                },
            },
        )
        .await
        .unwrap();
    attach_and_approve(
        proj_chat_res.clone(),
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: emb_shared.history.space_id.clone(),
        },
        0x15,
        0x16,
    )
    .await;
    attach_and_approve(
        proj_chat_res.clone(),
        ProviderAttachmentTarget::Project(proj_a.clone()),
        0x2C,
        0x2D,
    )
    .await;

    let run_shared_step = |run_tag: u8,
                           res_id: ProviderResourceId,
                           model_id: ModelProfileId,
                           project: Option<FolderRef>| {
        let svc = proj_provider_svc.clone();
        let owner = owner.clone();
        let shared_hist = emb_shared.history.clone();
        let listener = &chat_listener;
        async move {
            let auth = owner
                .auth()
                .for_agent_run(
                    AgentRunId::from_bytes([run_tag; 16]),
                    shared_hist.space_id.clone(),
                    ChatAudience::Shared,
                    owner.auth().spaces().clone(),
                )
                .unwrap();
            let ctx = SpaceContext::new(auth, shared_hist, budget()).unwrap();
            let sel = svc
                .select_provider(
                    ctx.clone(),
                    SelectProvider {
                        kind: PreferenceModelKind::Completion,
                        resource: Some(res_id),
                        model: Some(model_id),
                        project,
                    },
                )
                .await
                .unwrap();
            let call = svc.complete(
                ctx.clone(),
                CompletionRequest {
                    intent: CommandKey::from_bytes([run_tag; 16]),
                    selection: sel,
                    secondary_projects: vec![],
                    messages: vec![CompletionMessage {
                        role: CompletionRole::User,
                        instruction: Some(
                            ProviderInstruction::from_orchestrator("Shared search".into()).unwrap(),
                        ),
                        parts: vec![],
                        tool_calls: vec![],
                        result_for: None,
                    }],
                    tools: vec![],
                    budget: CompletionBudget {
                        max_input_tokens: 4096,
                        max_output_tokens: 128,
                        max_tool_calls: 0,
                    },
                },
            );
            let serve = async {
                let (mut wire, _) = timeout(Duration::from_secs(10), read_request(listener))
                    .await
                    .unwrap();
                send_ollama(
                    &mut wire,
                    json!({"role": "assistant", "content": "ok"}),
                    "stop",
                )
                .await;
            };
            let (stream_res, ()) = tokio::join!(call, serve);
            let mut stream = stream_res.unwrap();
            while let Some(ev) = stream.next().await.unwrap() {
                if matches!(ev, CompletionEvent::Finished(_)) {
                    break;
                }
            }
            ctx
        }
    };

    let shared_wide_run_ctx = run_shared_step(0x2E, shared_chat_res, shared_chat_model, None).await;
    let disclosed_sub = EmbeddingProviderPort::query_disclosure(
        proj_provider_svc.as_ref(),
        shared_wide_run_ctx.clone(),
        proj_emb_res.clone(),
        proj_emb_model.clone(),
        Some(proj_a.clone()),
        Some(proj_a.folder_id.clone()),
    )
    .await
    .unwrap();
    assert!(
        disclosed_sub.is_empty(),
        "Space-wide Shared AgentRun must NOT query ProjectA-only remote embedder (got {disclosed_sub:?})"
    );
    let direct_sub = proj_provider_svc
        .embed(
            shared_wide_run_ctx,
            EmbeddingRequest::query(
                CommandKey::from_bytes([0x2E, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                proj_emb_model.clone(),
                proj_emb_res.clone(),
                EmbeddingQueryInput {
                    text: "space-wide secret smuggled into ProjectA embedder".into(),
                    tokens: 8,
                    classes: [DocClass::UserDoc].into(),
                    project_scope: Some(proj_a.clone()),
                    folder: Some(proj_a.folder_id.clone()),
                },
            ),
        )
        .await;
    assert!(
        matches!(
            direct_sub,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::ClassEgressForbidden
        ),
        "Space-wide Shared AgentRun querying ProjectA-only embedder must fail with ClassEgressForbidden, got {direct_sub:?}"
    );
    assert_eq!(emb_hits.load(Ordering::SeqCst), 1);

    let proj_run_ctx =
        run_shared_step(0x2F, proj_chat_res, proj_chat_model, Some(proj_a.clone())).await;
    let disclosed_same_proj = EmbeddingProviderPort::query_disclosure(
        proj_provider_svc.as_ref(),
        proj_run_ctx.clone(),
        proj_emb_res.clone(),
        proj_emb_model.clone(),
        Some(proj_a.clone()),
        Some(proj_a.folder_id.clone()),
    )
    .await
    .unwrap();
    assert_eq!(disclosed_same_proj, [DocClass::UserDoc].into());
    let direct_same_proj = proj_provider_svc
        .embed(
            proj_run_ctx,
            EmbeddingRequest::query(
                CommandKey::from_bytes([0x2F, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                proj_emb_model,
                proj_emb_res,
                EmbeddingQueryInput {
                    text: "strictly ProjectA query".into(),
                    tokens: 6,
                    classes: [DocClass::UserDoc].into(),
                    project_scope: Some(proj_a.clone()),
                    folder: Some(proj_a.folder_id),
                },
            ),
        )
        .await
        .expect("ProjectA-confined AgentRun must be allowed to query ProjectA-only embedder");
    assert_eq!(direct_same_proj.vectors.len(), 1);
    assert_eq!(emb_hits.load(Ordering::SeqCst), 2);
    drop(narrow_run_ctx);

    // 3. On SQLite, wire real SearchEngine (VectorMode::RemoteOnly) + ToolRegistry
    //    against `provider_svc` and verify BOTH:
    //    (a) `wide_run_ctx` degrades to ProviderUnavailable + lexical hit with 0 query calls;
    //    (b) an unlogged AgentRun using `InAppProvider(chat_wide_res)` is ALSO blocked from
    //        sending query text to the UserDoc-only embedder (0 query calls, lexical hit ok);
    //    (c) an unlogged AgentRun using `InAppProvider(chat_narrow_res)` DOES invoke the
    //        remote embedder (+1 query call).
    if !pg {
        box_step(|| {
            remote_embedding_sqlite_search_and_probes(
                fixture,
                personal,
                &owner,
                &actor,
                &scope,
                provider_svc,
                catalog,
                &emb_res,
                &emb_hits,
                wide_run_ctx,
                &chat_wide_res,
                &chat_wide_model,
                &chat_narrow_res,
                &chat_narrow_model,
                &emb_shared,
            )
        })
        .await;
    }

    emb_server.abort();
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn remote_embedding_sqlite_search_and_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    owner: &AccountContext,
    actor: &PrincipalId,
    scope: &HistoryScope,
    provider_svc: Arc<ProviderService>,
    catalog: Arc<dyn ControlCatalogPort>,
    emb_res: &ProviderResourceId,
    emb_hits: &AtomicUsize,
    wide_run_ctx: SpaceContext,
    chat_wide_res: &ProviderResourceId,
    chat_wide_model: &ModelProfileId,
    chat_narrow_res: &ProviderResourceId,
    chat_narrow_model: &ModelProfileId,
    emb_shared: &AccessibleSpace,
) {
    let resolved_model = provider_svc
        .resolve_search_embedding_model(
            &ServiceAuthority::admit(ServicePurpose::Search),
            scope.clone(),
            None,
            budget(),
        )
        .await
        .unwrap()
        .expect("resolve_search_embedding_model must resolve personal embedding provider");
    assert_eq!(resolved_model.provider, *emb_res);
    let root = DataRoot::new(fixture.storage.root.as_ref().unwrap());
    let projector = ProjectorRuntime::start_sqlite(
        fixture.canonical.clone(),
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Projection),
            budget: budget(),
        },
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let proj = projector.engine();
    let mut deps = SearchDependencies::new(Arc::new(fixture.canonical.clone()), proj.clone());
    deps.model_resolver = Some(Arc::new(SeamSearchModelResolver(provider_svc.clone())));
    deps.providers = Some(provider_svc.clone());
    let search = Arc::new(SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    ));
    search.start_space(scope.clone()).unwrap();
    let emb_projections = Arc::new(ProjectionFixtures::default());
    let _ = emb_projections.real.set(DerivedReads {
        projection_calls: Default::default(),
        notes: proj.note_reads(),
        projection: proj.clone(),
        search: search.clone(),
    });
    let doc_id = NoteId::from_bytes([0x7F; 16]);
    let root_folder = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let created_note = fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x7F; 16]),
                    hash: ContentDigest::from_bytes([0x7F; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: doc_id.clone(),
                    parent: Some(root_folder),
                    slug: "lexical-fallback-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Lexical\n\nquasar telemetry beacon\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let layout = SearchLayout::open(&root, scope.clone()).unwrap();
    let mut probe_attempt = 0_u8;
    timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= created_note.receipt.seq()
                && manifest.vector_seq.is_some()
                && !manifest.embeddings_pending
            {
                probe_attempt = probe_attempt.wrapping_add(1);
                let mut probe_ctx = personal.clone();
                probe_ctx.budget.request = RequestId::from_bytes([
                    0x79,
                    probe_attempt,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    1,
                ]);
                if let Ok(probe) = search
                    .search(
                        probe_ctx,
                        SearchQuery {
                            text: "quasar telemetry beacon".into(),
                            filter: notarium_core::query::FieldFilterAstV1 {
                                version: 1,
                                predicate: notarium_core::query::Predicate::All(vec![]),
                            },
                            classes: [DocClass::UserDoc].into(),
                            folder: None,
                            causal: CausalBasis::Await(Default::default()),
                            include_chats: false,
                            top_k: PageLimit::new(5).unwrap(),
                            model: None,
                        },
                    )
                    .await
                    && probe.degraded.is_none()
                    && probe
                        .hits
                        .iter()
                        .any(|h| h.card.document.provenance().reference().note_id == doc_id)
                {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("remote vector indexing must publish in memory before query disclosure check");

    let hits_after_index = emb_hits.load(Ordering::SeqCst);
    assert!(
        hits_after_index >= 2,
        "expected remote indexing to hit embedder, got {hits_after_index}"
    );

    // (a) Direct SearchEngine query for `wide_run_ctx`: degrades cleanly to lexical, 0 wire calls.
    let res = search
        .search(
            wide_run_ctx,
            SearchQuery {
                text: "quasar telemetry beacon".into(),
                filter: notarium_core::query::FieldFilterAstV1 {
                    version: 1,
                    predicate: notarium_core::query::Predicate::All(vec![]),
                },
                classes: [DocClass::UserDoc].into(),
                folder: None,
                causal: CausalBasis::Await(Default::default()),
                include_chats: false,
                top_k: PageLimit::new(10).unwrap(),
                model: None,
            },
        )
        .await
        .unwrap();
    assert!(
        res.hits
            .iter()
            .any(|h| h.card.document.provenance().reference().note_id == doc_id),
        "lexical fallback must still return matching UserDoc hits"
    );
    assert!(
        matches!(res.degraded, Some(SearchDegradation::ProviderUnavailable)),
        "wide_run_ctx must degrade vector search instead of disclosing query text, got {:?}",
        res.degraded
    );
    assert_eq!(
        emb_hits.load(Ordering::SeqCst),
        hits_after_index,
        "zero HTTP calls may reach UserDoc-only embedder for wide_run_ctx"
    );

    // (b) Unlogged AgentRun calling MCP `search` through InAppProvider(chat_wide_res)
    //     must STILL be blocked by SearchRecipient::query_source_classes().
    let emb_registry = ToolRegistry::new(
        Arc::new(ControlPlane::new(provider_svc.as_ref().clone())),
        catalog,
        Arc::new(TestEngine(fixture.canonical.clone(), emb_projections)),
        fixture.control.clone(),
    )
    .with_vector_search(true);
    let personal_only_grants = std::collections::BTreeMap::from([(
        scope.space_id.clone(),
        owner.auth().spaces()[&scope.space_id].clone(),
    )]);
    let fresh_agent_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x7D; 16]),
            scope.space_id.clone(),
            ChatAudience::Personal,
            personal_only_grants,
        )
        .unwrap();
    let fresh_agent_account = AccountContext::new(fresh_agent_auth, budget());
    let wide_tool_res = emb_registry
        .call_tool(
            McpInvocationContext {
                account: fresh_agent_account.clone(),
                target: EgressTarget::InAppProvider {
                    provider: chat_wide_res.clone(),
                    model: chat_wide_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([0x7D; 16]),
            },
            "search",
            json!({ "query": "quasar telemetry beacon" }),
        )
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&wide_tool_res.structured_content)
            .unwrap()
            .contains(doc_id.as_str()),
        "unlogged wide InAppProvider search must still return lexical hits"
    );
    assert_eq!(
        wide_tool_res.structured_content["degraded"],
        json!(["provider_unavailable"]),
        "unlogged wide InAppProvider search must surface provider_unavailable degradation: {}",
        wide_tool_res.structured_content
    );
    assert_eq!(
        emb_hits.load(Ordering::SeqCst),
        hits_after_index,
        "unlogged wide InAppProvider search must NOT send query text to UserDoc-only embedder"
    );

    // (c) Positive control: same unlogged AgentRun with narrow UserDoc-only completion
    //     provider IS allowed to execute semantic query (+1 embedder HTTP call).
    let narrow_tool_res = emb_registry
        .call_tool(
            McpInvocationContext {
                account: fresh_agent_account,
                target: EgressTarget::InAppProvider {
                    provider: chat_narrow_res.clone(),
                    model: chat_narrow_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([0x7E; 16]),
            },
            "search",
            json!({ "query": "quasar telemetry beacon" }),
        )
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&narrow_tool_res.structured_content)
            .unwrap()
            .contains(doc_id.as_str())
    );
    assert_eq!(
        narrow_tool_res.structured_content["degraded"],
        json!([]),
        "narrow UserDoc-only InAppProvider search must not degrade: {}",
        narrow_tool_res.structured_content
    );
    assert_eq!(
        emb_hits.load(Ordering::SeqCst),
        hits_after_index + 1,
        "narrow UserDoc-only InAppProvider search must reach the UserDoc-only embedder (content={})",
        narrow_tool_res.structured_content
    );

    // (d) Unconsented Space/Project slug existence oracle: an InAppProvider AgentRun
    //     whose auth includes an unconsented Shared Space (`emb_shared`) must see
    //     ResourceNotFound (matching a bogus handle) on list_abilities, use_role,
    //     and list_notes when passing that project handle, without tainting auth.
    let probe_agent_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x7A, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            scope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let probe_agent_account = AccountContext::new(probe_agent_auth, budget());
    let unconsented_handle = format!("{}/emb-proj-a", emb_shared.slug);
    for (idx, (tool, args)) in [
        (
            "list_abilities",
            json!({ "view": "runtime", "project": unconsented_handle }),
        ),
        (
            "use_role",
            json!({ "role": "research", "project": unconsented_handle }),
        ),
        ("list_notes", json!({ "project": unconsented_handle })),
    ]
    .into_iter()
    .enumerate()
    {
        let res = emb_registry
            .call_tool(
                McpInvocationContext {
                    account: probe_agent_account.clone(),
                    target: EgressTarget::InAppProvider {
                        provider: chat_narrow_res.clone(),
                        model: chat_narrow_model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0x7B,
                        idx as u8 + 1,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        1,
                    ]),
                },
                tool,
                args,
            )
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "InAppProvider {tool} on unconsented Shared project must return ResourceNotFound, got {:?}",
            res.err()
        );
    }
    assert!(
        !probe_agent_account.auth().taint().is_tainted(),
        "rejected unconsented project probes must not taint caller"
    );
    // Invalid project component (`<space>/..`) must fail syntactically before
    // Space slug lookup so an existing unconsented Space slug and a missing
    // Space slug produce the exact same ValidationFailed error.
    for (idx, handle) in [
        format!("{}/..", emb_shared.slug),
        "missing-space/..".to_owned(),
    ]
    .into_iter()
    .enumerate()
    {
        for (tool_idx, (tool, args)) in [
            (
                "list_abilities",
                json!({ "view": "runtime", "project": handle }),
            ),
            ("use_role", json!({ "role": "research", "project": handle })),
            ("list_notes", json!({ "project": handle })),
        ]
        .into_iter()
        .enumerate()
        {
            let res = emb_registry
                .call_tool(
                    McpInvocationContext {
                        account: probe_agent_account.clone(),
                        target: EgressTarget::InAppProvider {
                            provider: chat_narrow_res.clone(),
                            model: chat_narrow_model.clone(),
                            primary_project: None,
                        },
                        request_key: CommandKey::from_bytes([
                            0x7C,
                            idx as u8 + 1,
                            tool_idx as u8 + 1,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            1,
                        ]),
                    },
                    tool,
                    args,
                )
                .await;
            assert!(
                matches!(
                    res,
                    Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                        if diagnostic.reason == ValidationReason::InvalidPathComponent
                ),
                "invalid project component `{handle}` on {tool} must fail with InvalidPathComponent before space lookup, got {:?}",
                res.err()
            );
        }
    }

    // (e) Cross-space BranchTaint and degradation isolation (boxed helper to keep debug frame compact).
    box_step(|| {
        unconsented_space_taint_isolation_probes(
            fixture,
            owner,
            actor,
            &emb_shared.history,
            &emb_registry,
            &probe_agent_account,
            chat_narrow_res,
            chat_narrow_model,
        )
    })
    .await;
    let (space_udoc, user_doc_note) = box_step(|| {
        real_search_preflight_setup_and_class_exclusion_probes(
            fixture,
            personal,
            &provider_svc,
            &search,
            &root,
            &emb_registry,
            chat_narrow_res,
            chat_narrow_model,
        )
    })
    .await;
    box_step(|| {
        real_search_preflight_taint_limit_and_engine_probes(
            fixture,
            personal,
            &search,
            &root,
            &emb_registry,
            chat_narrow_res,
            chat_narrow_model,
            &space_udoc,
            &user_doc_note,
        )
    })
    .await;

    search.shutdown().await;
    projector.shutdown().await.unwrap();
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn unconsented_space_taint_isolation_probes(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    actor: &PrincipalId,
    emb_shared_history: &HistoryScope,
    emb_registry: &ToolRegistry,
    probe_agent_account: &AccountContext,
    chat_narrow_res: &ProviderResourceId,
    chat_narrow_model: &ModelProfileId,
) {
    let emb_shared_ctx =
        SpaceContext::new(owner.auth().clone(), emb_shared_history.clone(), budget()).unwrap();
    let emb_shared_root = fixture
        .canonical
        .read_space(&emb_shared_history.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let secret_shared_note = NoteId::from_bytes([0x7D; 16]);
    fixture
        .canonical
        .create_note(
            emb_shared_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: emb_shared_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x7D; 16]),
                    hash: ContentDigest::from_bytes([0x7D; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: secret_shared_note.clone(),
                    parent: Some(emb_shared_root),
                    slug: "unconsented-secret-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Unconsented Secret\n\nunconsented-zephyr-token payload.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let make_probe_ctx = |sub: u8| McpInvocationContext {
        account: probe_agent_account.clone(),
        target: EgressTarget::InAppProvider {
            provider: chat_narrow_res.clone(),
            model: chat_narrow_model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x7D, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
        ]),
    };
    let search_probe = emb_registry
        .call_tool(
            make_probe_ctx(1),
            "search",
            json!({ "query": "unconsented-zephyr-token" }),
        )
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&search_probe.structured_content)
            .unwrap()
            .contains(secret_shared_note.as_str()),
        "search must not return notes from unconsented Shared Space: {}",
        search_probe.structured_content
    );
    assert_eq!(search_probe.structured_content["degraded"], json!([]));
    assert!(
        !probe_agent_account.auth().taint().is_tainted(),
        "search over unconsented Shared Space must not flip BranchTaint"
    );
    let recall_probe = emb_registry
        .call_tool(
            make_probe_ctx(2),
            "recall",
            json!({ "query": "unconsented-zephyr-token" }),
        )
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&recall_probe.structured_content)
            .unwrap()
            .contains(secret_shared_note.as_str()),
        "recall must not return sources from unconsented Shared Space: {}",
        recall_probe.structured_content
    );
    assert_eq!(recall_probe.structured_content["degraded"], json!([]));
    assert!(
        !probe_agent_account.auth().taint().is_tainted(),
        "recall over unconsented Shared Space must not flip BranchTaint"
    );
    let get_probe = emb_registry
        .call_tool(
            make_probe_ctx(3),
            "get_note",
            json!({ "ref": secret_shared_note }),
        )
        .await;
    assert!(
        matches!(
            get_probe,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "get_note on unconsented Shared Space must return ResourceNotFound, got {:?}",
        get_probe.err()
    );
    assert!(
        !probe_agent_account.auth().taint().is_tainted(),
        "get_note on unconsented Shared Space must not flip BranchTaint"
    );
    let recent_probe = emb_registry
        .call_tool(make_probe_ctx(4), "recent_activity", json!({}))
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&recent_probe.structured_content)
            .unwrap()
            .contains(secret_shared_note.as_str()),
        "recent_activity must not include notes from unconsented Shared Space"
    );
    assert!(
        !probe_agent_account.auth().taint().is_tainted(),
        "recent_activity must not flip BranchTaint from unconsented Shared Space"
    );
}

/// Two same-named roles in two different Shared Spaces must NOT break
/// `start_session({})` or runtime `list_abilities`, while bare `use_role` still
/// refuses ambiguous name resolution and exact `ref` succeeds.
async fn cross_space_same_named_roles_keep_start_session_working(fixture: &RuntimeFixture) {
    let owner = fresh_owner(fixture).await;
    let space_a = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x81).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x81; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared Alpha".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let space_b = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x82).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x82; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared Beta".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let role_a = call_mcp(
        &fixture.registry,
        &owner,
        [0x83; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "reviewer",
            "description": "Alpha reviewer",
            "instructions": "Review alpha docs.",
            "placement": { "home": "space", "space": space_a.slug },
        }),
    )
    .await
    .unwrap();
    let role_b = call_mcp(
        &fixture.registry,
        &owner,
        [0x84; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "reviewer",
            "description": "Beta reviewer",
            "instructions": "Review beta docs.",
            "placement": { "home": "space", "space": space_b.slug },
        }),
    )
    .await
    .unwrap();
    let ref_a = role_a.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let ref_b = role_b.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(ref_a, ref_b);

    let started = call_mcp(
        &fixture.registry,
        &owner,
        [0x85; 16],
        "start_session",
        json!({}),
    )
    .await
    .expect("start_session({}) must succeed despite same-named roles in two Shared Spaces");
    assert!(started.structured_content["session"]["id"].is_string());
    assert!(started.structured_content.get("delta").is_some());

    let listed = call_mcp(
        &fixture.registry,
        &owner,
        [0x86; 16],
        "list_abilities",
        json!({ "view": "runtime", "limit": 50 }),
    )
    .await
    .expect("runtime list_abilities must succeed with cross-Space same-named roles");
    let reviewer_refs: BTreeSet<&str> = listed.structured_content["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["name"] == "reviewer")
        .filter_map(|item| item["ref"].as_str())
        .collect();
    assert!(reviewer_refs.contains(ref_a.as_str()));
    assert!(reviewer_refs.contains(ref_b.as_str()));

    let ambiguous = call_mcp(
        &fixture.registry,
        &owner,
        [0x87; 16],
        "use_role",
        json!({ "name": "reviewer" }),
    )
    .await;
    assert!(
        matches!(
            ambiguous,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "ambiguous bare-name use_role must still reject instead of guessing, got {:?}",
        ambiguous.err()
    );
    let exact = call_mcp(
        &fixture.registry,
        &owner,
        [0x88; 16],
        "use_role",
        json!({ "name": ref_a }),
    )
    .await
    .expect("exact ref use_role must succeed");
    assert_eq!(exact.structured_content["name"], "reviewer");
}

/// PostgreSQL with canonical `pool_size = 1` must execute a Keeper turn
/// through its first provider call without deadlocking on canonical pool reuse.
async fn run_single_pool_keeper(fixture: &RuntimeFixture) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x91).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x91; 16]),
                    kind: SpaceKind::Shared,
                    name: "Pool-one Keeper".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let project = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0x92; 16]),
        "pool-one",
    )
    .await;
    let project_handle = format!("{}/pool-one", shared.slug);
    call_mcp(
        &fixture.registry,
        &owner,
        [0x93; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "pool-one-keeper-role",
            "description": "Role for single-conn pool test",
            "instructions": "Record one project observation.",
            "placement": { "home": "space", "space": shared.slug },
        }),
    )
    .await
    .unwrap();
    let AbilityResolution::Resolved(role) = fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "pool-one-keeper-role".into(),
                kind: AbilityKind::Role,
                project: Some(project.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("missing pool-one role");
    };
    let candidate = fixture
        .control
        .schedule_ability_candidate(
            owner.clone(),
            ScheduleAbilitySelection {
                space: project.space_id.clone(),
                project: Some(project.clone()),
                role: role.reference.identity(),
            },
        )
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x94, true).await;
    let classes: BTreeSet<DocClass> =
        [DocClass::Skill, DocClass::AgentMemory, DocClass::UserDoc].into();
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x96,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: project.space_id.clone(),
        },
        classes.clone(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x97,
        ProviderAttachmentTarget::Project(project.clone()),
        classes,
    )
    .await;
    local
        .provider
        .set_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x98).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(project.clone()),
                    kind: PreferenceModelKind::Completion,
                    resource: local.resource.id.clone(),
                    model: local.model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let due = Timestamp::parse("2025-01-05T03:00:00Z").unwrap();
    fixture
        .storage
        .clock
        .0
        .store(due.unix_seconds() * 1000, Ordering::SeqCst);
    let schedule = fixture
        .control
        .create_schedule(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x99).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([0x99; 16]),
                    definition: ScheduleDefinition {
                        space: project.space_id.clone(),
                        project: Some(project.clone()),
                        title: "PG pool=1 Keeper".into(),
                        init_prompt: "Record observation".into(),
                        cron: "0 0 3 * * Sun *".into(),
                        timezone: "UTC".into(),
                        approved_role: candidate.approved_role,
                        limits: RunLimits {
                            max_steps: 3,
                            max_tokens: 64_000,
                            timeout_ms: 15_000,
                        },
                    },
                    approved_skills: candidate.approved_skills,
                    next_slot: due,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;

    let scheduler = KeeperScheduler::new_local(
        local.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let mut worker = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick(due).await.unwrap() }
    });
    let (mut wire1, _) = tokio::select! {
        req = timeout(Duration::from_secs(12), read_request(&listener)) => {
            req.expect("PG pool_size=1 Keeper must reach first provider call without deadlock")
        }
        res = &mut worker => panic!("Keeper exited before provider call: {res:?}"),
    };
    send_ollama(
        &mut wire1,
        json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "function": {
                    "name": "remember_about_project",
                    "arguments": {
                        "project": project_handle,
                        "category": "progress",
                        "observation": "Single PG pool connection worked."
                    }
                }
            }]
        }),
        "tool_calls",
    )
    .await;
    let (mut wire2, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .expect("PG pool_size=1 Keeper must reach second provider call");
    send_ollama(
        &mut wire2,
        json!({"role": "assistant", "content": "Done."}),
        "stop",
    )
    .await;
    let report = timeout(Duration::from_secs(12), worker)
        .await
        .expect("PG pool_size=1 tick must finish")
        .unwrap();
    assert_eq!(report.succeeded, 1);
    let runs = fixture
        .control
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(owner)),
            schedule.id,
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(runs.items.len(), 1);
    assert_eq!(
        runs.items[0].status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Succeeded)
    );
}

/// Four 36 KiB `get_note` tool results in a single assistant step must not
/// wedge a 32,768-token model branch on the next turn.
async fn four_large_tool_results_do_not_wedge_32k_branch(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let root_folder = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let mut note_ids = Vec::new();
    let big_body = format!("# Big Note\n\n{}", "alpha beta gamma delta ".repeat(1_800));
    assert!(big_body.len() > 36 * 1024);
    for i in 0..4_u8 {
        let nid = NoteId::from_bytes([0xA1, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, i]);
        fixture
            .canonical
            .create_note(
                personal.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: scope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xA1, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, i,
                        ]),
                        hash: ContentDigest::from_bytes([0xA1; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: nid.clone(),
                        parent: Some(root_folder.clone()),
                        slug: format!("big-tool-note-{i}"),
                        class: DocClass::UserDoc,
                        carrier: big_body.clone(),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
        note_ids.push(nid);
    }

    let thread = ChatThreadId::from_bytes([0xA2; 16]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xA2; 16]),
                    hash: ContentDigest::from_bytes([0xA2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "32k 4-tool branch".into(),
                },
            },
        )
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local =
        loopback_provider_with_limits(fixture, &owner, &listener, 0xA3, true, 32_768, 1024).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xA5,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        limits: RunLimits {
            max_steps: 4,
            max_tokens: 120_000,
            timeout_ms: 20_000,
        },
        ..ChatRunOptions::default()
    };

    // Turn 1: model invokes 4 × get_note on >36 KiB notes in one step.
    supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xA6; 16]),
                    hash: ContentDigest::from_bytes([0xA6; 32]),
                },
                id: PendingInputId::from_bytes([0xA6; 16]),
                thread: thread.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Read all four notes.".into(),
                mentions_agent: false,
            },
            options.clone(),
        )
        .await
        .unwrap();
    let (mut wire1, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .unwrap();
    let tool_calls: Vec<Value> = note_ids
        .iter()
        .map(|nid| {
            json!({
                "function": {
                    "name": "get_note",
                    "arguments": { "ref": nid }
                }
            })
        })
        .collect();
    send_ollama(
        &mut wire1,
        json!({"role": "assistant", "content": "Reading 4 notes.", "tool_calls": tool_calls}),
        "tool_calls",
    )
    .await;
    let (mut wire2, prompt2) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("step 2 after 4 large tool results must fit in 32k window");
    let tool_msgs: Vec<&Value> = prompt2["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect();
    assert_eq!(tool_msgs.len(), 4);
    send_ollama(
        &mut wire2,
        json!({"role": "assistant", "content": "Summarized all four."}),
        "stop",
    )
    .await;
    let leaf1 = idle_leaf(fixture, personal, &thread).await;

    // Turn 2: follow-up turn on the SAME branch must succeed without TokenBudgetExceeded.
    supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor,
                    key: CommandKey::from_bytes([0xA7; 16]),
                    hash: ContentDigest::from_bytes([0xA7; 32]),
                },
                id: PendingInputId::from_bytes([0xA7; 16]),
                thread: thread.clone(),
                expected_leaf: leaf1,
                body: "Short follow-up question.".into(),
                mentions_agent: false,
            },
            options,
        )
        .await
        .unwrap();
    let (mut wire3, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("follow-up turn on 32k branch after 4 large tool outputs must not wedge");
    send_ollama(
        &mut wire3,
        json!({"role": "assistant", "content": "Follow-up ok."}),
        "stop",
    )
    .await;
    let leaf2 = idle_leaf(fixture, personal, &thread).await;
    assert!(leaf2 > leaf1);
}

/// Composite writes (`link_many` across two Spaces; `create_note`, `create_notes`,
/// and `move_note` into a new subfolder) must upgrade post-partial-commit
/// operational errors to `CommitEffect::Unknown` with `RetryAdvice::RetrySameCommand`
/// while preserving `DomainError` conflicts unchanged.
async fn composite_writes_upgrade_post_partial_commit_errors(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let personal_scope = personal.scope().clone();
    let personal_slug = fixture
        .canonical
        .read_space(&personal_scope.space_id)
        .await
        .unwrap()
        .slug;
    let _proj = create_project_folder(
        fixture,
        &personal_scope,
        &actor,
        FolderId::from_bytes([0xB1; 16]),
        "comp-writes",
    )
    .await;
    let project_handle = format!("{personal_slug}/comp-writes");

    // 1a. create_note into a NEW subfolder fails operationally after ensure_folder_path
    //     durably creates the subfolder -> must return Unknown + RetrySameCommand.
    fixture.projections.fail_next_create_note_not_committed();
    let err = call_mcp(
        &fixture.registry,
        &owner,
        [0xB2; 16],
        "create_note",
        json!({
            "project": project_handle,
            "path": "brand-new-sub",
            "title": "Composite create",
            "body": "Body text",
        }),
    )
    .await
    .err()
    .expect("create_note after subfolder creation must return injected deadline error");
    assert!(
        matches!(
            err,
            PortError::DeadlineExceeded(ref f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ),
        "create_note failing after creating subfolder must return Unknown+RetrySameCommand, got {err:?}"
    );
    // Retrying with the exact same request key succeeds cleanly.
    let created = call_mcp(
        &fixture.registry,
        &owner,
        [0xB2; 16],
        "create_note",
        json!({
            "project": project_handle,
            "path": "brand-new-sub",
            "title": "Composite create",
            "body": "Body text",
        }),
    )
    .await
    .expect("retry of create_note with same key must succeed");
    assert!(created.structured_content["noteId"].is_string());

    // 1b. Control: create_note directly in existing project root (no folder created)
    //     failing operationally preserves CommitEffect::NotCommitted.
    fixture.projections.fail_next_create_note_not_committed();
    let err_existing = call_mcp(
        &fixture.registry,
        &owner,
        [0xB3; 16],
        "create_note",
        json!({
            "project": project_handle,
            "title": "Existing folder create",
            "body": "Body text",
        }),
    )
    .await
    .err()
    .expect("create_note in existing folder must return injected deadline error");
    assert!(
        matches!(
            err_existing,
            PortError::DeadlineExceeded(ref f) if f.effect() == CommitEffect::NotCommitted
        ),
        "create_note without creating a folder must preserve NotCommitted, got {err_existing:?}"
    );

    // 2. link_many spanning two Spaces: Space 1 commits, Space 2 fails operationally
    //    -> must upgrade to Unknown + RetrySameCommand, and retry replays Space 1 + completes Space 2.
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xB4).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xB4; 16]),
                    kind: SpaceKind::Shared,
                    name: "Links Space B".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let _proj_b = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0xB5; 16]),
        "links-b",
    )
    .await;
    let proj_b_handle = format!("{}/links-b", shared.slug);
    let n1 = call_mcp(
        &fixture.registry,
        &owner,
        [0xB6; 16],
        "create_note",
        json!({"project": project_handle, "title": "Link A1", "body": "A1"}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let n2 = call_mcp(
        &fixture.registry,
        &owner,
        [0xB7; 16],
        "create_note",
        json!({"project": project_handle, "title": "Link A2", "body": "A2"}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let n3 = call_mcp(
        &fixture.registry,
        &owner,
        [0xB8; 16],
        "create_note",
        json!({"project": proj_b_handle, "title": "Link B1", "body": "B1"}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let n4 = call_mcp(
        &fixture.registry,
        &owner,
        [0xB9; 16],
        "create_note",
        json!({"project": proj_b_handle, "title": "Link B2", "body": "B2"}),
    )
    .await
    .unwrap()
    .structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();

    let link_args = json!({
        "links": [
            {"from": n1, "to": n2, "relation": "related"},
            {"from": n3, "to": n4, "relation": "related"},
        ]
    });
    fixture.projections.fail_nth_link_many_not_committed(2);
    let link_err = call_mcp(
        &fixture.registry,
        &owner,
        [0xBA; 16],
        "link_many",
        link_args.clone(),
    )
    .await
    .err()
    .expect("link_many failing on second Space must return injected deadline error");
    assert!(
        matches!(
            link_err,
            PortError::DeadlineExceeded(ref f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ),
        "link_many failing on 2nd Space after 1st committed must return Unknown+RetrySameCommand, got {link_err:?}"
    );
    let retried = call_mcp(
        &fixture.registry,
        &owner,
        [0xBA; 16],
        "link_many",
        link_args,
    )
    .await
    .expect("retrying link_many with same key must succeed across both Spaces");
    let items = retried.structured_content["results"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["ok"], true);
    assert_eq!(items[1]["ok"], true);

    // 3a. move_note into a NEW subfolder failing operationally after folder creation
    //     must return DeadlineExceeded(Unknown, RetrySameCommand), and retry succeeds.
    fixture.projections.fail_next_move_note_not_committed();
    let move_err = call_mcp(
        &fixture.registry,
        &owner,
        [0xBB; 16],
        "move_note",
        json!({ "ref": n1, "toFolder": "comp-writes/moved-new-sub" }),
    )
    .await
    .err()
    .expect("move_note after new subfolder creation must return injected deadline error");
    assert!(
        matches!(
            move_err,
            PortError::DeadlineExceeded(ref f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ),
        "move_note failing after creating subfolder must return Unknown+RetrySameCommand, got {move_err:?}"
    );
    let moved = call_mcp(
        &fixture.registry,
        &owner,
        [0xBB; 16],
        "move_note",
        json!({ "ref": n1, "toFolder": "comp-writes/moved-new-sub" }),
    )
    .await
    .expect("retrying move_note with same key must succeed");
    assert_eq!(moved.structured_content["noteId"], json!(n1));

    // 3b. move_note into a NEW subfolder hitting a concurrent DomainError::RevisionConflict
    //     must preserve PortError::Domain(RevisionConflict) instead of wrapping it as Unavailable.
    let n2_read = call_mcp(
        &fixture.registry,
        &owner,
        [0xBC; 16],
        "get_note",
        json!({ "ref": n2 }),
    )
    .await
    .unwrap();
    let n2_token = n2_read.structured_content["versionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let (entered_move, release_move) = fixture.projections.pause_note_move();
    let move_task = tokio::spawn({
        let registry = fixture.registry.clone();
        let owner = owner.clone();
        let n2 = n2.clone();
        async move {
            call_mcp(
                &registry,
                &owner,
                [0xBD; 16],
                "move_note",
                json!({ "ref": n2, "toFolder": "comp-writes/moved-conflict-sub" }),
            )
            .await
        }
    });
    let _cancel = timeout(Duration::from_secs(10), entered_move)
        .await
        .expect("move_note must reach canonical move_note pause after folder creation")
        .unwrap();
    call_mcp(
        &fixture.registry,
        &owner,
        [0xBE; 16],
        "edit_note",
        json!({
            "ref": n2,
            "operation": "append",
            "content": "Concurrent edit advancing revision.",
            "versionToken": n2_token,
        }),
    )
    .await
    .unwrap();
    let _ = release_move.send(());
    let conflict_err = timeout(Duration::from_secs(10), move_task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .expect("move_note after concurrent edit must return RevisionConflict");
    assert!(
        matches!(
            conflict_err,
            PortError::Domain(DomainError::RevisionConflict { .. })
        ),
        "move_note domain conflict after folder creation must preserve RevisionConflict, got {conflict_err:?}"
    );

    // 4. create_notes failing operationally on the 2nd note after the 1st note committed
    //    must upgrade to DeadlineExceeded(Unknown, RetrySameCommand), and retry succeeds.
    let batch_args = json!({
        "project": project_handle,
        "notes": [
            { "title": "Batch Note 1", "body": "First batch note" },
            { "title": "Batch Note 2", "body": "Second batch note" },
        ]
    });
    fixture.projections.fail_nth_create_note_not_committed(2);
    let batch_err = call_mcp(
        &fixture.registry,
        &owner,
        [0xBF; 16],
        "create_notes",
        batch_args.clone(),
    )
    .await
    .err()
    .expect("create_notes failing on 2nd note must return injected deadline error");
    assert!(
        matches!(
            batch_err,
            PortError::DeadlineExceeded(ref f)
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ),
        "create_notes failing on 2nd note after 1st committed must return Unknown+RetrySameCommand, got {batch_err:?}"
    );
    let batch_retried = call_mcp(
        &fixture.registry,
        &owner,
        [0xBF; 16],
        "create_notes",
        batch_args,
    )
    .await
    .expect("retrying create_notes with same key must succeed");
    let batch_results = batch_retried.structured_content["results"]
        .as_array()
        .unwrap();
    assert_eq!(batch_results.len(), 2);
    assert_eq!(batch_results[0]["ok"], true);
    assert_eq!(batch_results[1]["ok"], true);
}

/// `rollback_run` must enforce live Space write authority before fencing,
/// stop and drain active local Keepers and chat runs (including provider calls),
/// reject unsettled remote active schedule runs, and canonical must reject
/// rolling back active chat runs with or without prior document edits.
async fn rollback_run_stops_active_keeper_and_rejects_unsettled_runs(
    fixture: &mut RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xC1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xC1; 16]),
                    kind: SpaceKind::Shared,
                    name: "Rollback Keeper".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let project = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0xC2; 16]),
        "rb-proj",
    )
    .await;
    let project_handle = format!("{}/rb-proj", shared.slug);
    call_mcp(
        &fixture.registry,
        &owner,
        [0xC3; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "rb-keeper-role",
            "description": "Rollback race role",
            "instructions": "Write memory in two steps.",
            "placement": { "home": "space", "space": shared.slug },
        }),
    )
    .await
    .unwrap();
    let AbilityResolution::Resolved(role) = fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "rb-keeper-role".into(),
                kind: AbilityKind::Role,
                project: Some(project.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("missing rb-keeper-role");
    };
    let candidate = fixture
        .control
        .schedule_ability_candidate(
            owner.clone(),
            ScheduleAbilitySelection {
                space: project.space_id.clone(),
                project: Some(project.clone()),
                role: role.reference.identity(),
            },
        )
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0xC4, true).await;
    let classes: BTreeSet<DocClass> =
        [DocClass::Skill, DocClass::AgentMemory, DocClass::UserDoc].into();
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xC6,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: project.space_id.clone(),
        },
        classes.clone(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xC7,
        ProviderAttachmentTarget::Project(project.clone()),
        classes,
    )
    .await;
    local
        .provider
        .set_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xC8).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(project.clone()),
                    kind: PreferenceModelKind::Completion,
                    resource: local.resource.id.clone(),
                    model: local.model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let due = Timestamp::parse("2025-02-02T03:00:00Z").unwrap();
    fixture
        .storage
        .clock
        .0
        .store(due.unix_seconds() * 1000, Ordering::SeqCst);
    let schedule = fixture
        .control
        .create_schedule(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xC9).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([0xC9; 16]),
                    definition: ScheduleDefinition {
                        space: project.space_id.clone(),
                        project: Some(project.clone()),
                        title: "Active rollback Keeper".into(),
                        init_prompt: "Write step 1 and step 2".into(),
                        cron: "0 0 3 * * Sun *".into(),
                        timezone: "UTC".into(),
                        approved_role: candidate.approved_role,
                        limits: RunLimits {
                            max_steps: 4,
                            max_tokens: 64_000,
                            timeout_ms: 20_000,
                        },
                    },
                    approved_skills: candidate.approved_skills,
                    next_slot: due,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;

    let scheduler = KeeperScheduler::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let worker = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick(due).await.unwrap() }
    });

    // Step 1: Keeper calls `remember_about_project` ("step1-obs").
    let (mut wire1, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .unwrap();
    send_ollama(
        &mut wire1,
        json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "function": {
                    "name": "remember_about_project",
                    "arguments": {
                        "project": project_handle,
                        "category": "decisions",
                        "observation": "step1-obs"
                    }
                }
            }]
        }),
        "tool_calls",
    )
    .await;

    // Wait for step 2's provider call to arrive and HOLD the socket open (Keeper active between step 1 & step 2!).
    let (_wire2, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .unwrap();
    let runs = fixture
        .control
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(owner.clone())),
            schedule.id.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    let active_keeper_run = runs.items[0].run.clone();
    assert!(matches!(
        runs.items[0].status,
        ScheduleRunStatus::Claimed | ScheduleRunStatus::Running
    ));

    // Unauthorized callers (Space Viewer and PAT bearer) must NOT cancel the active Keeper
    // and must NOT receive a liveness oracle (`InvalidState`).
    let viewer_id = fixture
        .control
        .create_account(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xC0).await,
                input: NewAccount {
                    username: "rbviewer".into(),
                    email: None,
                    display_name: "Rollback Viewer".into(),
                },
            },
        )
        .await
        .unwrap()
        .value
        .id;
    let shared_owner_ctx =
        SpaceContext::new(owner.auth().clone(), shared.history.clone(), budget()).unwrap();
    fixture
        .control
        .change_membership(
            shared_owner_ctx,
            MembershipChange {
                command: CommandKey::from_bytes([
                    0xC0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                member: viewer_id.clone(),
                role: Some(SpaceRole::Viewer),
                expected: ControlRevision::new(1).unwrap(),
            },
        )
        .await
        .unwrap();
    let viewer_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &viewer_id,
            &AuthSessionId::from_bytes([0xC0; 16]),
            &viewer_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let viewer_auth = fixture
        .control
        .resolve(support::evidence(
            AuthEvidenceKind::Session,
            viewer_token.secret.expose(),
        ))
        .await
        .unwrap();
    let viewer_account = AccountContext::new(viewer_auth, budget());
    // Space Viewer calling supervisor.redact_chat_entry must fail upfront with SpaceReadOnly
    // before acquiring thread gates or invoking cluster write admission.
    let viewer_redact = supervisor
        .redact_chat_entry(
            viewer_account.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: viewer_account.auth().principal().clone(),
                    key: CommandKey::from_bytes([
                        0xC0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9,
                    ]),
                    hash: ContentDigest::from_bytes([0xC0; 32]),
                },
                preconditions: Preconditions::default(),
                input: RedactChatEntry {
                    thread: ChatThreadId::from_bytes([0xC0; 16]),
                    entry: ThreadEntrySeq::new(1).unwrap(),
                    expected_thread_revision: RevisionId::from_bytes([0xC0; 16]),
                },
            },
        )
        .await;
    assert!(
        matches!(
            viewer_redact,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "Viewer redact_chat_entry must fail upfront with SpaceReadOnly, got {viewer_redact:?}"
    );
    // A Space Viewer AgentRun calling list_pending_chat_inputs must fail with SpaceReadOnly
    // before loading thread metadata.
    let viewer_agent_auth = viewer_account
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xC0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]),
            shared.history.space_id.clone(),
            ChatAudience::Shared,
            viewer_account.auth().spaces().clone(),
        )
        .unwrap();
    let viewer_agent_ctx =
        SpaceContext::new(viewer_agent_auth, shared.history.clone(), budget()).unwrap();
    let viewer_pending = fixture
        .canonical
        .list_pending_chat_inputs(viewer_agent_ctx, ChatThreadId::from_bytes([0xC0; 16]))
        .await;
    assert!(
        matches!(
            viewer_pending,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "Viewer AgentRun list_pending_chat_inputs must fail with SpaceReadOnly, got {viewer_pending:?}"
    );
    let pat_account = fixture.pat(BearerScope::Write, false).await;
    let project_scoped_owner = AccountContext::new(
        owner.auth().restrict_to_project(&project).unwrap(),
        budget(),
    );
    let tainted_owner = fresh_owner(fixture).await;
    tainted_owner.auth().taint().mark_external_read();

    let unauthorized_cases: [(&str, AccountContext, u8, &str); 4] = [
        ("viewer", viewer_account.clone(), 0xC1, "access_denied"),
        ("pat", pat_account, 0xC2, "access_denied"),
        (
            "project_scoped_owner",
            project_scoped_owner,
            0xC3,
            "access_denied",
        ),
        ("tainted_owner", tainted_owner, 0xC4, "cross_space_tainted"),
    ];
    for (label, caller, key_tag, expected) in unauthorized_cases {
        let denied_rb = supervisor
            .rollback_run(
                caller.clone(),
                shared.history.clone(),
                active_keeper_run.clone(),
                CommandKey::from_bytes([0xCF, key_tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            )
            .await;
        let denied_check = fixture
            .control
            .ensure_run_inactive(
                caller,
                shared.history.space_id.clone(),
                active_keeper_run.clone(),
            )
            .await;
        let matches_expected = |err: Option<&PortError>| match expected {
            "access_denied" => matches!(err, Some(PortError::Domain(DomainError::AccessDenied))),
            "cross_space_tainted" => {
                matches!(err, Some(PortError::Domain(DomainError::CrossSpaceTainted)))
            }
            "invalid_authority" => matches!(
                err,
                Some(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidAuthority
            ),
            _ => unreachable!(),
        };
        assert!(
            matches_expected(denied_rb.as_ref().err()),
            "{label} rollback_run expected {expected}, got {denied_rb:?}"
        );
        assert!(
            matches_expected(denied_check.as_ref().err()),
            "{label} ensure_run_inactive expected {expected}, got {denied_check:?}"
        );
    }
    // Confirm the active Keeper was NOT cancelled by the unauthorized callers.
    let still_active = fixture
        .control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(owner.clone())),
            schedule.id.clone(),
            active_keeper_run.clone(),
        )
        .await
        .unwrap();
    assert!(
        matches!(
            still_active.status,
            ScheduleRunStatus::Claimed | ScheduleRunStatus::Running
        ),
        "unauthorized rollback attempts must leave active Keeper running, got {:?}",
        still_active.status
    );

    // Create a second Shared-Space Editor (`bob`) and verify that WHILE Alice's
    // active Keeper HAS already committed step-1 memory edits (`has_edits == true`
    // in `agent_run_heads`), Bob receives InvalidState from BOTH
    // `ensure_run_inactive` and `supervisor.rollback_run`, leaving Alice's Keeper
    // active and step-1 memory intact (non-vacuous coverage of `agent_run_has_head`).
    let bob_account = box_step(|| {
        create_shared_editor_bob_and_verify_edited_keeper(
            fixture,
            &owner,
            &shared.history,
            &project,
            &schedule.id,
            &active_keeper_run,
            &supervisor,
        )
    })
    .await;

    // Now invoke `rollback_run` while Keeper is mid-run! It must cancel & drain Keeper,
    // settle `agent_schedule_runs`, and roll back step 1's memory cleanly.
    let rolled = timeout(
        Duration::from_secs(15),
        supervisor.rollback_run(
            owner.clone(),
            shared.history.clone(),
            active_keeper_run.clone(),
            CommandKey::from_bytes([0xCA; 16]),
        ),
    )
    .await
    .expect("rollback_run must not hang waiting on active local Keeper")
    .expect("rollback_run must cancel active local Keeper and roll back step 1");
    assert_eq!(rolled.value.trashed.len(), 1);
    let _ = timeout(Duration::from_secs(10), worker)
        .await
        .unwrap()
        .unwrap();

    // Verify schedule run is terminal (never completed step 2) and memory was rolled back.
    let settled = fixture
        .control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(owner.clone())),
            schedule.id.clone(),
            active_keeper_run.clone(),
        )
        .await
        .unwrap();
    assert!(!matches!(
        settled.status,
        ScheduleRunStatus::Claimed
            | ScheduleRunStatus::Running
            | ScheduleRunStatus::Terminal(ScheduleOutcome::Succeeded)
    ));
    let mem_target = fixture
        .control
        .inspect_memory_target(
            owner.clone(),
            MemoryTarget::Project {
                folder: project.clone(),
            },
            "decisions".into(),
        )
        .await
        .unwrap();
    assert!(
        mem_target.revision.is_none(),
        "step 1 memory note must be rolled back (trashed) with no step 2 writes"
    );

    // 2. Remote/unsettled active Keeper: a second claimed slot with NO local RevocationHub
    //    entry must be rejected by `rollback_run` with ValidationReason::InvalidState.
    let next_due = Timestamp::parse("2025-02-09T03:00:00Z").unwrap();
    let after_next = Timestamp::parse("2025-02-16T03:00:00Z").unwrap();
    fixture
        .storage
        .clock
        .0
        .store(next_due.unix_seconds() * 1000, Ordering::SeqCst);
    let shared_ctx =
        SpaceContext::new(owner.auth().clone(), shared.history.clone(), budget()).unwrap();
    let live_sched = fixture
        .control
        .get_schedule(shared_ctx, schedule.id.clone())
        .await
        .unwrap();
    let claim = fixture
        .control
        .claim_schedule(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Scheduler),
                budget: budget(),
            },
            ClaimSchedule {
                schedule: live_sched.id.clone(),
                slot: next_due,
                expected: live_sched.revision,
                current_role: live_sched.definition.approved_role.clone(),
                next_slot: Some(after_next),
            },
        )
        .await
        .unwrap();
    let ScheduleClaim::Claimed {
        run: remote_run, ..
    } = claim
    else {
        panic!("expected claimed remote schedule run, got {claim:?}");
    };
    let remote_rb = supervisor
        .rollback_run(
            owner.clone(),
            shared.history.clone(),
            remote_run.clone(),
            CommandKey::from_bytes([0xCB; 16]),
        )
        .await;
    assert!(
        matches!(
            remote_rb,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "rollback_run must reject unsettled remote active schedule run with InvalidState, got {remote_rb:?}"
    );

    // 2b. Foreign Shared-Space Editor isolation (zero-edit Keeper + active & completed zero-edit Personal chat).
    // Refresh Bob's session after advancing the fixture clock by 7 days to `next_due`.
    let (bob_account, alice_shared_ctx) = box_step(|| {
        rollback_foreign_editor_isolation(
            fixture,
            &owner,
            &actor,
            &shared.history,
            &project,
            &supervisor,
            &listener,
            bob_account.auth().principal().clone(),
            remote_run,
        )
    })
    .await;

    // 3. Direct canonical rollback while `chat_threads.active_run_id = run` must reject with InvalidState.
    let chat_tid = ChatThreadId::from_bytes([0xCC; 16]);
    let chat_run = AgentRunId::from_bytes([0xCC; 16]);
    let pscope = personal.scope().clone();
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xCC; 16]),
                    hash: ContentDigest::from_bytes([0xCC; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: chat_tid.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Active chat rollback guard".into(),
                },
            },
        )
        .await
        .unwrap();
    let run_auth = owner
        .auth()
        .for_agent_run(
            chat_run.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_ctx = SpaceContext::new(run_auth, pscope.clone(), budget()).unwrap();
    let claim_res = fixture
        .canonical
        .claim_active_run(
            run_ctx.clone(),
            ClaimChatRun {
                thread: chat_tid.clone(),
                run: chat_run.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(claim_res, ClaimChatRunOutcome::Claimed));
    let root_folder = fixture
        .canonical
        .read_space(&pscope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    fixture
        .canonical
        .create_note(
            run_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xCD; 16]),
                    hash: ContentDigest::from_bytes([0xCD; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([0xCD; 16]),
                    parent: Some(root_folder),
                    slug: "active-chat-run-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Active run note\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let fenced_rb = fixture
        .control_plane
        .fence_canonical_effect(
            owner.auth().clone(),
            personal.clone(),
            CanonicalEffect::ChatRollback,
        )
        .await
        .unwrap();
    let active_chat_rb = fixture
        .canonical
        .rollback_agent_run_by_id(
            fenced_rb,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xCE; 16]),
                    hash: ContentDigest::from_bytes([0xCE; 32]),
                },
                preconditions: Preconditions::default(),
                input: chat_run.clone(),
            },
        )
        .await;
    assert!(
        matches!(
            active_chat_rb,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "canonical rollback must reject an active chat run, got {active_chat_rb:?}"
    );

    // 4. Direct canonical rollback of an active chat run with ZERO document edits
    //    (no `agent_run_heads` row) must STILL return InvalidState, not ResourceNotFound.
    let empty_tid = ChatThreadId::from_bytes([0xCF; 16]);
    let empty_run = AgentRunId::from_bytes([0xCF; 16]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xCF; 16]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: empty_tid.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Active chat with zero edits".into(),
                },
            },
        )
        .await
        .unwrap();
    let empty_run_auth = owner
        .auth()
        .for_agent_run(
            empty_run.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let empty_run_ctx = SpaceContext::new(empty_run_auth, pscope.clone(), budget()).unwrap();
    let empty_claim = fixture
        .canonical
        .claim_active_run(
            empty_run_ctx,
            ClaimChatRun {
                thread: empty_tid,
                run: empty_run.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(empty_claim, ClaimChatRunOutcome::Claimed));
    let fenced_empty = fixture
        .control_plane
        .fence_canonical_effect(
            owner.auth().clone(),
            personal.clone(),
            CanonicalEffect::ChatRollback,
        )
        .await
        .unwrap();
    let active_empty_rb = fixture
        .canonical
        .rollback_agent_run_by_id(
            fenced_empty,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xCE, 0xCF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: empty_run.clone(),
            },
        )
        .await;
    assert!(
        matches!(
            active_empty_rb,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "canonical rollback must reject an active zero-edit chat run with InvalidState, got {active_empty_rb:?}"
    );

    box_step(|| {
        rollback_canonical_replay_and_archived_finish(
            fixture,
            personal,
            &owner,
            &actor,
            &shared.history,
            alice_shared_ctx,
            &bob_account,
            &viewer_account,
            chat_run,
            empty_run,
        )
    })
    .await;
    drop(pscope);
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn create_shared_editor_bob_and_verify_edited_keeper(
    fixture: &mut RuntimeFixture,
    owner: &AccountContext,
    shared_history: &HistoryScope,
    project: &FolderRef,
    schedule_id: &ScheduleId,
    active_keeper_run: &AgentRunId,
    supervisor: &AgentRunSupervisor,
) -> AccountContext {
    let bob_id = fixture
        .control
        .create_account(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 0x1C).await,
                input: NewAccount {
                    username: "rbeditor".into(),
                    email: None,
                    display_name: "Rollback Editor Bob".into(),
                },
            },
        )
        .await
        .unwrap()
        .value
        .id;
    let shared_owner_ctx =
        SpaceContext::new(owner.auth().clone(), shared_history.clone(), budget()).unwrap();
    let expected_rev = fixture
        .control
        .context_scope(
            owner.clone(),
            ContextScope::Space(shared_history.space_id.clone()),
        )
        .await
        .unwrap()
        .revision;
    fixture
        .control
        .change_membership(
            shared_owner_ctx,
            MembershipChange {
                command: CommandKey::from_bytes([
                    0x1C, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                member: bob_id.clone(),
                role: Some(SpaceRole::Editor),
                expected: expected_rev,
            },
        )
        .await
        .unwrap();
    let bob_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &bob_id,
            &AuthSessionId::from_bytes([0x1C; 16]),
            &bob_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let bob_account = AccountContext::new(
        fixture
            .control
            .resolve(support::evidence(
                AuthEvidenceKind::Session,
                bob_token.secret.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    let bob_active_check = fixture
        .control
        .ensure_run_inactive(
            bob_account.clone(),
            shared_history.space_id.clone(),
            active_keeper_run.clone(),
        )
        .await;
    assert!(
        matches!(
            bob_active_check,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "foreign Editor ensure_run_inactive on edited active Keeper must return InvalidState, got {bob_active_check:?}"
    );
    let bob_active_rb = supervisor
        .rollback_run(
            bob_account.clone(),
            shared_history.clone(),
            active_keeper_run.clone(),
            CommandKey::from_bytes([0x1C, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]),
        )
        .await;
    assert!(
        matches!(
            bob_active_rb,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "foreign Editor rollback_run on edited active Keeper must return InvalidState, got {bob_active_rb:?}"
    );
    let still_active_after_bob = fixture
        .control
        .get_schedule_run(
            ScheduleRunContext::Owner(Box::new(owner.clone())),
            schedule_id.clone(),
            active_keeper_run.clone(),
        )
        .await
        .unwrap();
    assert!(matches!(
        still_active_after_bob.status,
        ScheduleRunStatus::Claimed | ScheduleRunStatus::Running
    ));
    let mem_before_owner_rb = fixture
        .control
        .inspect_memory_target(
            owner.clone(),
            MemoryTarget::Project {
                folder: project.clone(),
            },
            "decisions".into(),
        )
        .await
        .unwrap();
    assert!(
        mem_before_owner_rb.revision.is_some(),
        "foreign Editor rollback_run must leave step-1 memory note intact"
    );
    bob_account
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn rollback_foreign_editor_isolation(
    fixture: &mut RuntimeFixture,
    owner: &AccountContext,
    actor: &PrincipalId,
    shared_history: &HistoryScope,
    project: &FolderRef,
    supervisor: &AgentRunSupervisor,
    listener: &TcpListener,
    bob_id: PrincipalId,
    remote_run: AgentRunId,
) -> (AccountContext, SpaceContext) {
    let bob_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &bob_id,
            &AuthSessionId::from_bytes([0x1C, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            &bob_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let bob_account = AccountContext::new(
        fixture
            .control
            .resolve(support::evidence(
                AuthEvidenceKind::Session,
                bob_token.secret.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    let shared_owner_ctx =
        SpaceContext::new(owner.auth().clone(), shared_history.clone(), budget()).unwrap();
    fixture
        .control
        .ensure_run_inactive(
            bob_account.clone(),
            shared_history.space_id.clone(),
            remote_run.clone(),
        )
        .await
        .expect(
            "foreign Editor must not get InvalidState liveness oracle for Alice's zero-edit Keeper",
        );
    let bob_remote_rb = supervisor
        .rollback_run(
            bob_account.clone(),
            shared_history.clone(),
            remote_run,
            CommandKey::from_bytes([0x1C, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
        )
        .await;
    assert!(
        matches!(
            bob_remote_rb,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "foreign Editor rollback_run on Alice's zero-edit Keeper must return ResourceNotFound, got {bob_remote_rb:?}"
    );
    // Start a real active Personal chat run for Alice in `shared`, hold its
    // provider socket open, and prove Bob's `rollback_run` returns ResourceNotFound
    // without cancelling Alice's live Personal turn.
    let alice_priv_thread = ChatThreadId::from_bytes([0xC6; 16]);
    fixture
        .canonical
        .create_chat(
            shared_owner_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xC6; 16]),
                    hash: ContentDigest::from_bytes([0xC6; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: alice_priv_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: Some(project.folder_id.clone()),
                    title: "Alice private shared-space chat".into(),
                },
            },
        )
        .await
        .unwrap();
    let alice_priv_run = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: shared_history.clone(),
                thread: alice_priv_thread.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                options: ChatRunOptions::default(),
            },
        )
        .await
        .unwrap();
    let (mut alice_priv_wire, _) = timeout(Duration::from_secs(12), read_request(listener))
        .await
        .expect("Alice's Personal chat in shared space must reach provider");
    let bob_priv_rb = supervisor
        .rollback_run(
            bob_account.clone(),
            shared_history.clone(),
            alice_priv_run.clone(),
            CommandKey::from_bytes([0xC6, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
        )
        .await;
    assert!(
        matches!(
            bob_priv_rb,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "foreign Editor rollback_run on Alice's active Personal chat must return ResourceNotFound, got {bob_priv_rb:?}"
    );
    send_ollama(
        &mut alice_priv_wire,
        json!({"role": "assistant", "content": "Alice private reply survived Bob."}),
        "stop",
    )
    .await;
    let alice_priv_leaf = idle_leaf(fixture, &shared_owner_ctx, &alice_priv_thread).await;
    assert_eq!(
        alice_priv_leaf.get(),
        1,
        "Alice's active Personal chat turn must survive Bob's unauthorized rollback_run"
    );
    // Even AFTER Alice's read-only Personal chat turn has committed its reply via
    // `append_chat` (zero note edits), `append_chat_tx` must NOT have populated
    // `agent_run_heads`, so Bob's `rollback_run` must still see ResourceNotFound
    // (NOT a no-op Committed rollback existence oracle).
    let bob_post_append_rb = supervisor
        .rollback_run(
            bob_account.clone(),
            shared_history.clone(),
            alice_priv_run,
            CommandKey::from_bytes([0xC6, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]),
        )
        .await;
    assert!(
        matches!(
            bob_post_append_rb,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "chat-only Personal run must not expose an agent_run_heads existence oracle to foreign Editors, got {bob_post_append_rb:?}"
    );
    (bob_account, shared_owner_ctx)
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn rollback_canonical_replay_and_archived_finish(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    owner: &AccountContext,
    actor: &PrincipalId,
    shared_history: &HistoryScope,
    alice_shared_ctx: SpaceContext,
    bob_account: &AccountContext,
    viewer_account: &AccountContext,
    chat_run: AgentRunId,
    empty_run: AgentRunId,
) {
    let pscope = personal.scope().clone();
    let unfenced_active_empty = fixture
        .canonical
        .rollback_agent_run_by_id(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xCE, 0xCF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: empty_run.clone(),
            },
        )
        .await;
    assert!(
        matches!(
            unfenced_active_empty,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "prepare_agent_run_rollback must reject an active zero-edit chat run with InvalidState, got {unfenced_active_empty:?}"
    );
    let ro_rb_pat = fixture.pat(BearerScope::Read, false).await;
    let ro_rb_ctx = SpaceContext::new(ro_rb_pat.auth().clone(), pscope.clone(), budget()).unwrap();
    let ro_rb_unfenced = fixture
        .canonical
        .rollback_agent_run_by_id(
            ro_rb_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: ro_rb_pat.auth().principal().clone(),
                    key: CommandKey::from_bytes([
                        0xCE, 0xCF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: empty_run.clone(),
            },
        )
        .await;
    assert!(
        matches!(
            ro_rb_unfenced,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "unfenced read-only bearer rollback must return SpaceReadOnly before active-run check, got {ro_rb_unfenced:?}"
    );
    let ro_effect = fixture
        .revocations
        .register_canonical_effect(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Revocation),
                budget: budget(),
            },
            vec![RevocationSelector::Space(pscope.space_id.clone())],
            Cancellation::default(),
        )
        .await
        .unwrap();
    let ro_rb_fenced_ctx = ro_rb_ctx
        .with_canonical_effect(&ro_rb_pat, ro_effect)
        .unwrap();
    let ro_rb_fenced = fixture
        .canonical
        .rollback_agent_run_by_id(
            ro_rb_fenced_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: ro_rb_pat.auth().principal().clone(),
                    key: CommandKey::from_bytes([
                        0xCE, 0xCF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: empty_run,
            },
        )
        .await;
    assert!(
        matches!(
            ro_rb_fenced,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "fenced read-only bearer rollback (`direct_by_id == true`) must ALSO return SpaceReadOnly before active-run check, got {ro_rb_fenced:?}"
    );

    // 4c. On the `!direct_by_id` path, reusing an already-committed rollback CommandKey
    //     with a different command hash against a STILL-ACTIVE chat run (`chat_run`,
    //     which has an `agent_run_heads` row and `active_run_id = chat_run`) must
    //     report IdempotencyKeyReused BEFORE `prepare_agent_run_rollback` rejects the
    //     active run with InvalidState.
    let finished_run =
        AgentRunId::from_bytes([0xCE, 0xCC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let finished_run_auth = owner
        .auth()
        .for_agent_run(
            finished_run.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let finished_run_ctx = SpaceContext::new(finished_run_auth, pscope.clone(), budget()).unwrap();
    let p_root = fixture
        .canonical
        .read_space(&pscope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    fixture
        .canonical
        .create_note(
            finished_run_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xCE, 0xCC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xCE; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([
                        0xCE, 0xCC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    parent: Some(p_root),
                    slug: "finished-run-for-replay".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Finished run note\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let committed_rb_key =
        CommandKey::from_bytes([0xCE, 0xCA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .rollback_agent_run_by_id(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: committed_rb_key.clone(),
                    hash: ContentDigest::from_bytes([0xC1; 32]),
                },
                preconditions: Preconditions::default(),
                input: finished_run,
            },
        )
        .await
        .unwrap();
    let reused_key_rb = fixture
        .canonical
        .rollback_agent_run_by_id(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: committed_rb_key,
                    hash: ContentDigest::from_bytes([0xC2; 32]),
                },
                preconditions: Preconditions::default(),
                input: chat_run,
            },
        )
        .await;
    assert!(
        matches!(
            reused_key_rb,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ),
        "reusing committed rollback CommandKey against active chat_run on !direct_by_id path must return IdempotencyKeyReused, got {reused_key_rb:?}"
    );

    box_step(|| {
        archived_space_finish_run_isolation(
            fixture,
            owner,
            actor,
            shared_history,
            alice_shared_ctx,
            bob_account,
            viewer_account,
            &ro_rb_pat,
        )
    })
    .await;
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn archived_space_finish_run_isolation(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    actor: &PrincipalId,
    shared_history: &HistoryScope,
    alice_shared_ctx: SpaceContext,
    bob_account: &AccountContext,
    viewer_account: &AccountContext,
    ro_rb_pat: &AccountContext,
) {
    // 5. Closing/Archived Space `finish_run_if_queue_empty` must ONLY allow the
    //    active claim owner's live writable AgentRun matching `active_run_id`:
    //    - Viewer AgentRun on an archived `SpaceGroup` thread (bypasses owner &
    //      audience checks -> genuinely exercises `!writable_grant`) -> ResourceNotFound
    //    - Read-only bearer AgentRun on archived `SpaceGroup` -> ResourceNotFound
    //    - Different AgentRun (`wrong_run`) by the thread owner -> ResourceNotFound (not Ok(Changed))
    //    - Repeated call after `Cleared` (`active_run_id == None`) -> ResourceNotFound
    //    - Non-owner Editor on archived `Personal` thread -> ResourceNotFound
    let arch_thread = ChatThreadId::from_bytes([0xC7; 16]);
    let arch_run = AgentRunId::from_bytes([0xC7; 16]);
    let arch_group_thread = ChatThreadId::from_bytes([0xC8; 16]);
    let arch_group_run = AgentRunId::from_bytes([0xC8; 16]);
    let wrong_run = AgentRunId::from_bytes([0xC9; 16]);
    fixture
        .canonical
        .create_chat(
            alice_shared_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xC7; 16]),
                    hash: ContentDigest::from_bytes([0xC7; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: arch_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Archived space finish auth".into(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .create_chat(
            alice_shared_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xC8; 16]),
                    hash: ContentDigest::from_bytes([0xC8; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: arch_group_thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Archived space group finish auth".into(),
                },
            },
        )
        .await
        .unwrap();
    let arch_owner_auth = owner
        .auth()
        .for_agent_run(
            arch_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let arch_owner_ctx =
        SpaceContext::new(arch_owner_auth, shared_history.clone(), budget()).unwrap();
    let wrong_run_auth = owner
        .auth()
        .for_agent_run(
            wrong_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let wrong_run_ctx =
        SpaceContext::new(wrong_run_auth, shared_history.clone(), budget()).unwrap();
    assert!(matches!(
        fixture
            .canonical
            .claim_active_run(
                arch_owner_ctx.clone(),
                ClaimChatRun {
                    thread: arch_thread.clone(),
                    run: arch_run.clone(),
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    ));
    let arch_group_owner_auth = owner
        .auth()
        .for_agent_run(
            arch_group_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let arch_group_owner_ctx =
        SpaceContext::new(arch_group_owner_auth, shared_history.clone(), budget()).unwrap();
    assert!(matches!(
        fixture
            .canonical
            .claim_active_run(
                arch_group_owner_ctx.clone(),
                ClaimChatRun {
                    thread: arch_group_thread.clone(),
                    run: arch_group_run.clone(),
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    ));
    let bob_agent_auth = bob_account
        .auth()
        .for_agent_run(
            arch_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Personal,
            bob_account.auth().spaces().clone(),
        )
        .unwrap();
    let bob_agent_ctx =
        SpaceContext::new(bob_agent_auth, shared_history.clone(), budget()).unwrap();
    let viewer_arch_group_auth = viewer_account
        .auth()
        .for_agent_run(
            arch_group_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Shared,
            viewer_account.auth().spaces().clone(),
        )
        .unwrap();
    let viewer_arch_group_ctx =
        SpaceContext::new(viewer_arch_group_auth, shared_history.clone(), budget()).unwrap();
    let ro_arch_group_auth = ro_rb_pat
        .auth()
        .for_agent_run(
            arch_group_run.clone(),
            shared_history.space_id.clone(),
            ChatAudience::Shared,
            ro_rb_pat.auth().spaces().clone(),
        )
        .unwrap();
    let ro_arch_group_ctx =
        SpaceContext::new(ro_arch_group_auth, shared_history.clone(), budget()).unwrap();
    let space_rev = fixture
        .control
        .context_scope(
            owner.clone(),
            ContextScope::Space(shared_history.space_id.clone()),
        )
        .await
        .unwrap()
        .revision;
    fixture
        .control
        .change_space_lifecycle(
            alice_shared_ctx,
            SpaceLifecycleChange {
                command: CommandKey::from_bytes([
                    0xC7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                lifecycle: notarium_core::auth::SpaceLifecycle::Archived,
                expected: space_rev,
            },
        )
        .await
        .unwrap();
    for (label, ctx, thread, expected_run) in [
        (
            "bob_non_owner_personal",
            bob_agent_ctx,
            arch_thread.clone(),
            arch_run.clone(),
        ),
        (
            "viewer_space_group",
            viewer_arch_group_ctx,
            arch_group_thread.clone(),
            arch_group_run.clone(),
        ),
        (
            "ro_bearer_space_group",
            ro_arch_group_ctx,
            arch_group_thread.clone(),
            arch_group_run.clone(),
        ),
        (
            "owner_wrong_expected_run",
            wrong_run_ctx,
            arch_thread.clone(),
            wrong_run,
        ),
    ] {
        let denied_finish = fixture
            .canonical
            .finish_run_if_queue_empty(
                ctx,
                ChatRunRequest {
                    thread,
                    expected_run,
                },
            )
            .await;
        assert!(
            matches!(
                denied_finish,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "{label} finish_run_if_queue_empty on archived Space must return ResourceNotFound, got {denied_finish:?}"
        );
    }
    let owner_finish = fixture
        .canonical
        .finish_run_if_queue_empty(
            arch_owner_ctx.clone(),
            ChatRunRequest {
                thread: arch_thread.clone(),
                expected_run: arch_run.clone(),
            },
        )
        .await
        .expect("active claim owner must still clear its own run while Space is archived");
    assert!(matches!(owner_finish, FinishChatRunOutcome::Cleared));
    // Post-clear call (`active_run_id == None`) on an archived Space must also return ResourceNotFound.
    let post_clear = fixture
        .canonical
        .finish_run_if_queue_empty(
            arch_owner_ctx,
            ChatRunRequest {
                thread: arch_thread,
                expected_run: arch_run,
            },
        )
        .await;
    assert!(
        matches!(
            post_clear,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "post-clear finish_run_if_queue_empty on archived Space must return ResourceNotFound, got {post_clear:?}"
    );
    let group_owner_finish = fixture
        .canonical
        .finish_run_if_queue_empty(
            arch_group_owner_ctx,
            ChatRunRequest {
                thread: arch_group_thread,
                expected_run: arch_group_run,
            },
        )
        .await
        .expect(
            "active SpaceGroup claim owner must still clear its own run while Space is archived",
        );
    assert!(matches!(group_owner_finish, FinishChatRunOutcome::Cleared));
}

/// `remember_about_project` and `remember_about_user` proposal previews
/// must expose `target`, `spaceId`, and (for project memory) `projectFolder` so
/// humans can disambiguate destination projects.
async fn project_memory_proposal_preview_shows_destination(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let personal_slug = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .slug;
    let project = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0xD1; 16]),
        "mem-preview",
    )
    .await;
    let project_handle = format!("{personal_slug}/mem-preview");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0xD3, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xD5,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory, DocClass::Profile].into(),
    )
    .await;

    let propose_and_preview = |tag: u8, tool_name: &'static str, args: Value| {
        let personal = personal.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        let scope = scope.clone();
        let local_registry = local.registry.clone();
        let res_id = local.resource.id.clone();
        let model_id = local.model.clone();
        async move {
            let thread = ChatThreadId::from_bytes([tag; 16]);
            let run = AgentRunId::from_bytes([tag; 16]);
            let cmd = |sub: u8| CommandIdentity {
                scope: scope.clone(),
                actor: actor.clone(),
                key: CommandKey::from_bytes([tag, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
                hash: ContentDigest::from_bytes([tag; 32]),
            };
            fixture
                .canonical
                .create_chat(
                    personal.clone(),
                    Mutation {
                        identity: cmd(1),
                        preconditions: Preconditions::default(),
                        input: CreateChat {
                            thread: thread.clone(),
                            kind: ChatThreadKind::Personal,
                            owner: actor.clone(),
                            project_folder: None,
                            title: format!("Memory preview {tag}"),
                        },
                    },
                )
                .await
                .unwrap();
            let run_auth = owner
                .auth()
                .for_agent_run(
                    run.clone(),
                    scope.space_id.clone(),
                    ChatAudience::Personal,
                    owner.auth().spaces().clone(),
                )
                .unwrap();
            let run_scope = SpaceContext::new(run_auth.clone(), scope.clone(), budget()).unwrap();
            fixture
                .canonical
                .claim_active_run(
                    run_scope.clone(),
                    ClaimChatRun {
                        thread: thread.clone(),
                        run,
                        expected_leaf: ThreadEntrySeq::ZERO,
                        previous_run: None,
                    },
                )
                .await
                .unwrap();
            let key = CommandKey::from_bytes([tag, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
            let model_entry = fixture
                .canonical
                .append_chat(
                    run_scope.clone(),
                    Mutation {
                        identity: cmd(2),
                        preconditions: Preconditions::default(),
                        input: AppendChat {
                            thread: thread.clone(),
                            parent: ThreadEntrySeq::ZERO,
                            kind: ChatEntryKind::Model,
                            body: ChatInputBody::Text("Propose memory update.".into()),
                            tool_calls: vec![ProviderToolCall {
                                id: ProviderToolCallId::new(key.as_str().into()).unwrap(),
                                name: tool_name.into(),
                                arguments: args.as_object().unwrap().clone().into_iter().collect(),
                            }],
                            provenance: Some(ChatProvenance::default()),
                            interruption: None,
                            proposed_diff: None,
                            proposed_effect: None,
                            referenced_notes: vec![],
                            tainted: false,
                        },
                    },
                )
                .await
                .unwrap();
            run_auth.taint().mark_external_read();
            let tool_res = local_registry
                .call_personal_tool(
                    McpInvocationContext {
                        account: AccountContext::new(run_auth, budget()),
                        target: EgressTarget::InAppProvider {
                            provider: res_id,
                            model: model_id,
                            primary_project: None,
                        },
                        request_key: key.clone(),
                    },
                    PersonalToolInvocation {
                        source: scope.clone(),
                        thread: thread.clone(),
                        leaf: model_entry.value.seq,
                        owner: owner.clone(),
                    },
                    tool_name,
                    args,
                )
                .await
                .unwrap();
            assert_eq!(tool_res.structured_content["outcome"], "approvalRequired");
            let proposal = tool_res.proposal().expect("typed memory proposal");
            let tool_entry = fixture
                .canonical
                .append_chat(
                    run_scope,
                    Mutation {
                        identity: cmd(3),
                        preconditions: Preconditions::default(),
                        input: AppendChat {
                            thread: thread.clone(),
                            parent: model_entry.value.seq,
                            kind: ChatEntryKind::Tool { call_id: key },
                            body: ChatInputBody::Text(tool_res.content[0].text.clone()),
                            tool_calls: vec![],
                            provenance: Some(tool_res.provenance.clone()),
                            interruption: None,
                            proposed_diff: Some(proposal.envelope().to_owned()),
                            proposed_effect: Some(proposal.effect()),
                            referenced_notes: vec![],
                            tainted: true,
                        },
                    },
                )
                .await
                .unwrap();
            local_registry
                .preview_proposed_diff(
                    owner,
                    ConfirmProposedDiff {
                        source: scope,
                        thread,
                        entry: tool_entry.value.seq,
                        proposal: proposal.id(),
                    },
                )
                .await
                .unwrap()
        }
    };

    let proj_preview = propose_and_preview(
        0xD6,
        "remember_about_project",
        json!({
            "project": project_handle,
            "category": "architecture",
            "observation": "Uses SQLite and PG parity."
        }),
    )
    .await;
    let proj_mem = proj_preview.memory.expect("project memory preview");
    assert_eq!(proj_mem["target"], "project");
    assert_eq!(proj_mem["spaceId"], json!(scope.space_id));
    assert_eq!(proj_mem["projectFolder"], json!(project.folder_id));
    assert_eq!(proj_mem["category"], "architecture");

    let user_preview = propose_and_preview(
        0xD7,
        "remember_about_user",
        json!({
            "category": "preferences",
            "observation": "Prefers concise summaries."
        }),
    )
    .await;
    let user_mem = user_preview.memory.expect("user memory preview");
    assert_eq!(user_mem["target"], "user");
    assert_eq!(user_mem["spaceId"], json!(scope.space_id));
    assert!(user_mem.get("projectFolder").is_none());
    assert_eq!(user_mem["category"], "preferences");
}

/// Closing a chat thread's deterministic episode must not permanently
/// disable AI in that thread; and `start_session` role pre-validation must
/// reject role typos and `ProjectUnavailable` without mutating episodes while
/// letting ambiguous named sessions return `recentSessions`.
async fn closed_chat_episode_recovers_and_role_typo_leaves_no_orphan(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let thread = ChatThreadId::from_bytes([0xE1; 16]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xE1; 16]),
                    hash: ContentDigest::from_bytes([0xE1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Closed episode recovery".into(),
                },
            },
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0xE2, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xE4,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        limits: RunLimits {
            max_steps: 2,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
        ..ChatRunOptions::default()
    };

    // Turn 1 opens generation-0 deterministic episode.
    supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xE5; 16]),
                    hash: ContentDigest::from_bytes([0xE5; 32]),
                },
                id: PendingInputId::from_bytes([0xE5; 16]),
                thread: thread.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "First turn".into(),
                mentions_agent: false,
            },
            options.clone(),
        )
        .await
        .unwrap();
    let (mut wire1, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .unwrap();
    send_ollama(
        &mut wire1,
        json!({"role": "assistant", "content": "First reply."}),
        "stop",
    )
    .await;
    let leaf1 = idle_leaf(fixture, personal, &thread).await;

    // Close the deterministic generation-0 episode directly in Control.
    let mut h = blake3::Hasher::new_derive_key("notarium.chats.episode.v1");
    for part in [
        scope.space_id.as_str().as_bytes(),
        thread.as_str().as_bytes(),
        actor.as_str().as_bytes(),
    ] {
        h.update(&(part.len() as u64).to_be_bytes());
        h.update(part);
    }
    let ep0 = EpisodeId::from_bytes(h.finalize().as_bytes()[..16].try_into().unwrap());
    let loaded = fixture
        .control
        .get_episode(owner.clone(), ep0.clone())
        .await
        .unwrap();
    fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xE6).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: loaded.id,
                    expected: loaded.revision,
                    name: loaded.name,
                    active_role: loaded.active_role,
                    project_hint: loaded.project_hint,
                    lifecycle: EpisodeLifecycle::Closed,
                }),
            },
        )
        .await
        .unwrap();

    // Turn 2 on the SAME thread must cleanly open generation-1 episode and succeed!
    supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor,
                    key: CommandKey::from_bytes([0xE7; 16]),
                    hash: ContentDigest::from_bytes([0xE7; 32]),
                },
                id: PendingInputId::from_bytes([0xE7; 16]),
                thread: thread.clone(),
                expected_leaf: leaf1,
                body: "Second turn after episode close".into(),
                mentions_agent: false,
            },
            options,
        )
        .await
        .unwrap();
    let (mut wire2, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .expect("chat turn after closing deterministic episode must reach provider");
    send_ollama(
        &mut wire2,
        json!({"role": "assistant", "content": "Recovered after close."}),
        "stop",
    )
    .await;
    let leaf2 = idle_leaf(fixture, personal, &thread).await;
    assert!(leaf2 > leaf1);

    // Part B: Named `start_session` with a typo in `role` fails WITHOUT creating
    // an orphan active episode, so the corrected retry creates a `"new"` session (not `"forked"`).
    let typo = call_mcp(
        &fixture.registry,
        &owner,
        [0xE8; 16],
        "start_session",
        json!({
            "session": { "name": "no-orphan-named-session" },
            "role": "nonexistent-role-typo",
        }),
    )
    .await;
    assert!(
        matches!(typo, Err(PortError::Domain(DomainError::ResourceNotFound))),
        "role typo must fail with ResourceNotFound, got {:?}",
        typo.err()
    );
    let fixed = call_mcp(
        &fixture.registry,
        &owner,
        [0xE9; 16],
        "start_session",
        json!({ "session": { "name": "no-orphan-named-session" } }),
    )
    .await
    .unwrap();
    assert_eq!(
        fixed.structured_content["session"]["state"], "new",
        "corrected named start_session must be 'new', not 'forked' from an orphan episode"
    );

    // Part C: `start_session` with explicit `role` on a CLOSED `ProjectUnavailable`
    // episode by `id` must reject BEFORE mutating or forking the episode.
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let gone_proj = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0xEA; 16]),
        "ep-gone-proj",
    )
    .await;
    let ep_gone = EpisodeId::from_bytes([0xEA; 16]);
    let started_gone = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xEA).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_gone.clone(),
                        name: Some("closed-gone-ep".into()),
                    },
                    project_hint: Some(gone_proj.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    let EpisodeStartResult::New(initial_gone) = started_gone.value else {
        panic!("expected new episode for ep_gone");
    };
    fixture
        .control
        .update_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xEB).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: initial_gone.id,
                    expected: initial_gone.revision,
                    name: initial_gone.name,
                    active_role: initial_gone.active_role,
                    project_hint: initial_gone.project_hint,
                    lifecycle: EpisodeLifecycle::Closed,
                }),
            },
        )
        .await
        .unwrap();
    let trashed_gone = fixture
        .canonical
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
            scope.space_id.as_str(),
            gone_proj.folder_id.as_str(),
        ))
        .await
        .unwrap();
    assert_eq!(trashed_gone, 1);
    let ep_before = fixture
        .control
        .get_episode(owner.clone(), ep_gone.clone())
        .await
        .unwrap();
    assert!(
        ep_before
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable)
    );
    let gone_reopen = call_mcp(
        &fixture.registry,
        &owner,
        [0xEC; 16],
        "start_session",
        json!({ "session": { "id": ep_gone }, "role": "research" }),
    )
    .await;
    assert!(
        matches!(
            gone_reopen,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "start_session with role on closed ProjectUnavailable episode must fail closed, got {:?}",
        gone_reopen.err()
    );
    let ep_after = fixture
        .control
        .get_episode(owner.clone(), ep_gone)
        .await
        .unwrap();
    assert_eq!(ep_after.revision, ep_before.revision);
    assert_eq!(
        fixture
            .control
            .named_episode_project_hint(owner.clone(), "closed-gone-ep".into())
            .await
            .unwrap(),
        NamedEpisodePreview::NoMatch,
        "failed start_session on closed ProjectUnavailable episode must not fork an active episode"
    );

    // Part C2: An ACTIVE named episode bound to a now-trashed project must return
    // `NamedEpisodePreview::ProjectUnavailable` (never leaking the hidden raw `FolderRef`),
    // and `start_session` with a role must fail closed with `ResourceNotFound`.
    let active_gone_proj = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0xE9; 16]),
        "ep-active-gone-proj",
    )
    .await;
    fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xE9).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::from_bytes([0xE9; 16]),
                        name: Some("active-gone-ep".into()),
                    },
                    project_hint: Some(active_gone_proj.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    let trashed_active = fixture
        .canonical
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
            scope.space_id.as_str(),
            active_gone_proj.folder_id.as_str(),
        ))
        .await
        .unwrap();
    assert_eq!(trashed_active, 1);
    assert_eq!(
        fixture
            .control
            .named_episode_project_hint(owner.clone(), "active-gone-ep".into())
            .await
            .unwrap(),
        NamedEpisodePreview::ProjectUnavailable,
        "named_episode_project_hint must validate the stored project via catalog and never leak a trashed FolderRef"
    );
    let active_gone_res = call_mcp(
        &fixture.registry,
        &owner,
        [0xE8, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "start_session",
        json!({ "session": { "name": "active-gone-ep" }, "role": "research" }),
    )
    .await;
    assert!(
        matches!(
            active_gone_res,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "start_session on active named episode with trashed project must fail closed, got {:?}",
        active_gone_res.err()
    );

    // Part D: Named session pre-validation preserves `recentSessions` on ambiguous names
    // and resolves project-scoped roles on unique project-bound named sessions.
    let personal_slug = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .slug;
    let role_proj = create_project_folder(
        fixture,
        &scope,
        &actor,
        FolderId::from_bytes([0xED; 16]),
        "named-role-proj",
    )
    .await;
    let role_proj_handle = format!("{personal_slug}/named-role-proj");
    call_mcp(
        &fixture.registry,
        &owner,
        [0xED; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "proj-only-role",
            "description": "Project-scoped role",
            "instructions": "Only inside named-role-proj.",
            "placement": { "home": "project", "project": role_proj_handle },
        }),
    )
    .await
    .unwrap();
    for (idx, tag) in [(1_u8, 0xEE_u8), (2_u8, 0xEF_u8)] {
        fixture
            .control
            .start_or_resume_episode(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, tag).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: EpisodeId::from_bytes([
                                0xE0, idx, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx,
                            ]),
                            name: Some("ambig-sprint".into()),
                        },
                        project_hint: Some(role_proj.clone()),
                        guard: EpisodeRevisionGuard::Target,
                    },
                },
            )
            .await
            .unwrap();
    }
    let ambig_res = call_mcp(
        &fixture.registry,
        &owner,
        [0xE1, 0xAA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "start_session",
        json!({
            "session": { "name": "ambig-sprint" },
            "role": "proj-only-role",
        }),
    )
    .await
    .expect("ambiguous named start_session with project-scoped role must return recentSessions");
    assert_eq!(
        ambig_res.structured_content["recentSessions"]
            .as_array()
            .map(Vec::len),
        Some(2),
        "ambiguous named start_session must return both matching episodes: {}",
        ambig_res.structured_content
    );

    let unique_ep_id = EpisodeId::from_bytes([0xE0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x3E).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: unique_ep_id.clone(),
                        name: Some("proj-unique-sprint".into()),
                    },
                    project_hint: Some(role_proj.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .unwrap();
    let preview = fixture
        .control
        .named_episode_project_hint(owner.clone(), "proj-unique-sprint".into())
        .await
        .unwrap();
    assert_eq!(
        preview,
        NamedEpisodePreview::Unique(Some(role_proj.clone()))
    );
    let direct_resolve = fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "proj-only-role".into(),
                kind: AbilityKind::Role,
                project: Some(role_proj.clone()),
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(direct_resolve, AbilityResolution::Resolved(_)),
        "direct resolve_ability for proj-only-role with role_proj must succeed, got {direct_resolve:?}"
    );
    let unique_res = call_mcp(
        &fixture.registry,
        &owner,
        [0xE1, 0xAB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "start_session",
        json!({
            "session": { "name": "proj-unique-sprint" },
            "role": "proj-only-role",
        }),
    )
    .await
    .expect("unique project-bound named session must resolve project-scoped role without explicit project");
    assert_eq!(
        unique_res.structured_content["session"]["parentId"],
        json!(unique_ep_id)
    );
    assert_eq!(
        unique_res.structured_content["activeRole"]["name"],
        json!("proj-only-role")
    );
}

/// Retrying a committed `delete_note` through in-app `ToolRegistry`
/// with the same `request_key` must replay cleanly instead of returning
/// `ResourceNotFound`.
async fn in_app_delete_note_replay_succeeds_with_same_key(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let scope = personal.scope().clone();
    let root_folder = fixture
        .canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let note_id = NoteId::from_bytes([0xF1; 16]);
    fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xF1; 16]),
                    hash: ContentDigest::from_bytes([0xF1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note_id.clone(),
                    parent: Some(root_folder),
                    slug: "delete-replay-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Delete replay\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0xF2, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xF4,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: scope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF5; 16]),
            scope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_account = AccountContext::new(run_auth, budget());
    let target = EgressTarget::InAppProvider {
        provider: local.resource.id.clone(),
        model: local.model.clone(),
        primary_project: None,
    };
    let same_key = CommandKey::from_bytes([0xF6; 16]);
    let first = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: run_account.clone(),
                target: target.clone(),
                request_key: same_key.clone(),
            },
            "delete_note",
            json!({ "ref": note_id }),
        )
        .await
        .unwrap();
    assert_eq!(first.structured_content["outcome"], "trashed");

    let replayed = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: run_account.clone(),
                target: target.clone(),
                request_key: same_key,
            },
            "delete_note",
            json!({ "ref": note_id }),
        )
        .await
        .expect("retrying committed in-app delete_note with same key must replay cleanly");
    assert_eq!(replayed.structured_content["outcome"], "trashed");

    // A brand-new key on the already-trashed note must still fail with ResourceNotFound.
    let fresh = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: run_account,
                target,
                request_key: CommandKey::from_bytes([0xF7; 16]),
            },
            "delete_note",
            json!({ "ref": note_id }),
        )
        .await;
    assert!(
        matches!(fresh, Err(PortError::Domain(DomainError::ResourceNotFound))),
        "fresh delete_note on trashed note must still fail with ResourceNotFound, got {:?}",
        fresh.err()
    );
}

/// One-shot `KeeperScheduler::tick(now)` must succeed even when
/// Control's clock is ahead of `now` by more than two cron boundaries.
async fn keeper_one_shot_tick_handles_multi_boundary_clock_skew(fixture: &RuntimeFixture) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x51).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x51; 16]),
                    kind: SpaceKind::Shared,
                    name: "Skew Keeper".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let project = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0x52; 16]),
        "skew-proj",
    )
    .await;
    call_mcp(
        &fixture.registry,
        &owner,
        [0x53; 16],
        "create_ability",
        json!({
            "kind": "role",
            "name": "skew-keeper-role",
            "description": "Skew role",
            "instructions": "Finish cleanly.",
            "placement": { "home": "space", "space": shared.slug },
        }),
    )
    .await
    .unwrap();
    let AbilityResolution::Resolved(role) = fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: "skew-keeper-role".into(),
                kind: AbilityKind::Role,
                project: Some(project.clone()),
            },
        )
        .await
        .unwrap()
    else {
        panic!("missing skew role");
    };
    let candidate = fixture
        .control
        .schedule_ability_candidate(
            owner.clone(),
            ScheduleAbilitySelection {
                space: project.space_id.clone(),
                project: Some(project.clone()),
                role: role.reference.identity(),
            },
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x54, true).await;
    let classes: BTreeSet<DocClass> =
        [DocClass::Skill, DocClass::AgentMemory, DocClass::UserDoc].into();
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x56,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: project.space_id.clone(),
        },
        classes.clone(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x57,
        ProviderAttachmentTarget::Project(project.clone()),
        classes,
    )
    .await;
    local
        .provider
        .set_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x58).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(project.clone()),
                    kind: PreferenceModelKind::Completion,
                    resource: local.resource.id.clone(),
                    model: local.model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let t0 = Timestamp::parse("2025-03-01T10:00:00Z").unwrap();
    let tick_now = Timestamp::parse("2025-03-01T10:01:00Z").unwrap();
    let control_now = Timestamp::parse("2025-03-01T10:05:30Z").unwrap();
    fixture
        .storage
        .clock
        .0
        .store(t0.unix_seconds() * 1000, Ordering::SeqCst);
    let _schedule = fixture
        .control
        .create_schedule(
            owner,
            AccountMutation {
                identity: identity(fixture, &fresh_owner(fixture).await, 0x59).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([0x59; 16]),
                    definition: ScheduleDefinition {
                        space: project.space_id.clone(),
                        project: Some(project.clone()),
                        title: "Multi-boundary skew".into(),
                        init_prompt: "Check skew".into(),
                        cron: "0 * * * * * *".into(),
                        timezone: "UTC".into(),
                        approved_role: candidate.approved_role.clone(),
                        limits: RunLimits {
                            max_steps: 2,
                            max_tokens: 32_000,
                            timeout_ms: 15_000,
                        },
                    },
                    approved_skills: candidate.approved_skills.clone(),
                    next_slot: t0,
                    paused: false,
                },
            },
        )
        .await
        .unwrap();

    // Advance Control's clock 5 cron boundaries ahead of the one-shot `tick(tick_now)` timestamp.
    fixture
        .storage
        .clock
        .0
        .store(control_now.unix_seconds() * 1000, Ordering::SeqCst);
    let scheduler = KeeperScheduler::new_local(
        local.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let worker = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick(tick_now).await.unwrap() }
    });
    let (mut wire, _) = timeout(Duration::from_secs(12), read_request(&listener))
        .await
        .expect("one-shot tick must advance past 5 cron boundaries and claim");
    send_ollama(
        &mut wire,
        json!({"role": "assistant", "content": "Skew ok."}),
        "stop",
    )
    .await;
    let report = timeout(Duration::from_secs(12), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.succeeded, 1);

    // Also verify a schedule misfired by 60 minutes PLUS multi-boundary forward
    // Control clock skew (3.5 minutes and 6.5 minutes ahead of `tick_now`),
    // proving independent forward/backward cursors never starve forward skew.
    let t_misfire = Timestamp::parse("2025-03-01T09:00:00Z").unwrap();
    let tick_misfire = Timestamp::parse("2025-03-01T10:00:00Z").unwrap();
    let control_fwd = Timestamp::parse("2025-03-01T10:03:30Z").unwrap();
    let control_fwd_far = Timestamp::parse("2025-03-01T10:06:30Z").unwrap();
    for (tag, ctrl_ts, title) in [
        (0x1D_u8, control_fwd, "Misfire plus 3.5m forward skew"),
        (0x1E_u8, control_fwd_far, "Misfire plus 6.5m forward skew"),
    ] {
        fixture
            .storage
            .clock
            .0
            .store(t_misfire.unix_seconds() * 1000, Ordering::SeqCst);
        let owner_for_sched = fresh_owner(fixture).await;
        fixture
            .control
            .create_schedule(
                owner_for_sched.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner_for_sched, tag).await,
                    input: CreateSchedule {
                        id: ScheduleId::from_bytes([tag; 16]),
                        definition: ScheduleDefinition {
                            space: project.space_id.clone(),
                            project: Some(project.clone()),
                            title: title.into(),
                            init_prompt: "Check misfire skew".into(),
                            cron: "0 * * * * * *".into(),
                            timezone: "UTC".into(),
                            approved_role: candidate.approved_role.clone(),
                            limits: RunLimits {
                                max_steps: 2,
                                max_tokens: 32_000,
                                timeout_ms: 15_000,
                            },
                        },
                        approved_skills: candidate.approved_skills.clone(),
                        next_slot: t_misfire,
                        paused: false,
                    },
                },
            )
            .await
            .unwrap();
        fixture
            .storage
            .clock
            .0
            .store(ctrl_ts.unix_seconds() * 1000, Ordering::SeqCst);
        let worker = tokio::spawn({
            let scheduler = scheduler.clone();
            async move { scheduler.tick(tick_misfire).await.unwrap() }
        });
        let (mut wire, _) = timeout(Duration::from_secs(12), read_request(&listener))
            .await
            .expect(title);
        send_ollama(
            &mut wire,
            json!({"role": "assistant", "content": "Misfire skew ok."}),
            "stop",
        )
        .await;
        let report = timeout(Duration::from_secs(12), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(report.succeeded, 1, "{title}");
    }
}

/// Verify `idx_folder_heads_space_updated` (canonical) and `call_run` (control)
/// are installed on both SQLite and PG.
async fn folder_heads_space_updated_index_present(fixture: &RuntimeFixture, pg: bool) {
    let (folder_idx, call_run_idx): (i64, i64) = match &fixture.canonical_config.sql {
        SqlBackendConfig::Postgres {
            connect, schema, ..
        } => {
            assert!(pg);
            let mut conn = sqlx::PgConnection::connect_with(&build_pg_connect_options(connect))
                .await
                .unwrap();
            let folder_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pg_indexes
                 WHERE schemaname = $1
                   AND tablename = 'folder_heads'
                   AND indexname = 'idx_folder_heads_space_updated'",
            )
            .bind(schema)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            let call_run_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pg_indexes
                 WHERE schemaname = 'v1_control'
                   AND tablename = 'provider_call_log'
                   AND indexname = 'call_run'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            conn.close().await.unwrap();
            (folder_count, call_run_count)
        }
        SqlBackendConfig::Sqlite { data_root, .. } => {
            assert!(!pg);
            let url = format!("sqlite:{}", data_root.canonical().display());
            let mut conn = sqlx::SqliteConnection::connect(&url).await.unwrap();
            let folder_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index'
                   AND tbl_name = 'folder_heads'
                   AND name = 'idx_folder_heads_space_updated'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            conn.close().await.unwrap();
            let ctrl_url = format!("sqlite:{}", data_root.control().display());
            let mut ctrl_conn = sqlx::SqliteConnection::connect(&ctrl_url).await.unwrap();
            let call_run_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index'
                   AND tbl_name = 'provider_call_log'
                   AND name = 'call_run'",
            )
            .fetch_one(&mut ctrl_conn)
            .await
            .unwrap();
            ctrl_conn.close().await.unwrap();
            (folder_count, call_run_count)
        }
    };
    assert_eq!(folder_idx, 1, "idx_folder_heads_space_updated must exist");
    assert_eq!(
        call_run_idx, 1,
        "provider_call_log call_run index must exist in control schema"
    );
}

/// Multi-page `start_session` delta pagination must renew the continuation
/// idle TTL on each page while still expiring unused earlier tokens.
async fn bootstrap_continuation_sliding_ttl_survives_multi_page_resync(fixture: &RuntimeFixture) {
    struct RestoreTtl(Arc<ToolRegistry>);
    impl Drop for RestoreTtl {
        fn drop(&mut self) {
            self.0
                .set_bootstrap_continuation_ttl_for_tests(Duration::from_secs(15 * 60));
        }
    }
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x41).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x41; 16]),
                    kind: SpaceKind::Shared,
                    name: "Bootstrap Sliding TTL".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let shared_ctx =
        SpaceContext::new(owner.auth().clone(), shared.history.clone(), budget()).unwrap();
    let root_folder = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap()
        .root_folder_id;
    // Create 45 notes (> 2 pages at PAGE_SIZE = 20) so pagination spans 3 pages.
    for i in 0..45_u8 {
        fixture
            .canonical
            .create_note(
                shared_ctx.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: shared.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0x42, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, i,
                        ]),
                        hash: ContentDigest::from_bytes([0x42; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: NoteId::from_bytes([
                            0x42, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, i,
                        ]),
                        parent: Some(root_folder.clone()),
                        slug: format!("ttl-note-{i:02}"),
                        class: DocClass::UserDoc,
                        carrier: format!("# TTL Note {i}\n"),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
    }

    // First verify invalid session locator alongside deliveryReceipt fails
    // upfront WITHOUT advancing the durable ack cursor (under default TTL so
    // DB latency cannot eat into the short sliding-TTL window below).
    let pre_page = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x43, 0xBA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "start_session",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(
        pre_page.structured_content["delta"]["complete"],
        json!(false)
    );
    let pre_receipt = pre_page.structured_content["delta"]["deliveryReceipt"]
        .as_str()
        .expect("pre_page must emit a deliveryReceipt")
        .to_owned();
    let bad_session_with_receipt = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x43, 0xBB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "start_session",
        json!({ "deliveryReceipt": pre_receipt, "session": {} }),
    )
    .await;
    assert!(
        matches!(
            bad_session_with_receipt,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidQuery
        ),
        "start_session with invalid session locator and deliveryReceipt must fail with InvalidQuery, got {:?}",
        bad_session_with_receipt.err()
    );
    let unacked_check = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x43, 0xBC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "start_session",
        json!({ "acknowledge": false }),
    )
    .await
    .unwrap();
    assert_eq!(
        unacked_check.structured_content["delta"]["complete"],
        json!(false)
    );
    assert_eq!(
        unacked_check.structured_content["delta"]["changes"],
        pre_page.structured_content["delta"]["changes"],
        "rejected start_session with invalid session locator must not advance durable ack cursor"
    );

    let _restore = RestoreTtl(fixture.registry.clone());
    fixture
        .registry
        .set_bootstrap_continuation_ttl_for_tests(Duration::from_millis(1500));

    let page1 = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x43; 16],
        "start_session",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(page1.structured_content["delta"]["complete"], json!(false));
    let cont1 = page1.structured_content["delta"]["continuation"]
        .as_str()
        .expect("page 1 must emit a continuation cursor")
        .to_owned();
    let receipt1 = page1.structured_content["delta"]["deliveryReceipt"]
        .as_str()
        .expect("page 1 must emit a deliveryReceipt")
        .to_owned();

    // Sleep 850ms (< 1500ms TTL, generous margin against CI jitter) and advance to Page 2.
    tokio::time::sleep(Duration::from_millis(850)).await;
    let page2 = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x44; 16],
        "start_session",
        json!({ "continuation": cont1, "deliveryReceipt": receipt1 }),
    )
    .await
    .expect("page 2 within idle TTL must succeed");
    assert_eq!(page2.structured_content["delta"]["complete"], json!(false));
    let cont2 = page2.structured_content["delta"]["continuation"]
        .as_str()
        .expect("page 2 must emit a continuation cursor")
        .to_owned();
    let receipt2 = page2.structured_content["delta"]["deliveryReceipt"]
        .as_str()
        .expect("page 2 must emit a deliveryReceipt")
        .to_owned();

    // Sleep another 850ms: total elapsed since Page 1 is 1700ms (> 1500ms), so `cont1`
    // MUST be expired (`CursorStale`), while `cont2` (only 850ms idle) MUST still succeed!
    tokio::time::sleep(Duration::from_millis(850)).await;
    let expired1 = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x45; 16],
        "start_session",
        json!({ "continuation": cont1, "deliveryReceipt": receipt1 }),
    )
    .await;
    assert!(
        matches!(
            expired1,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale
        ),
        "old page-1 continuation past 1500ms TTL must fail with CursorStale, got {:?}",
        expired1.err()
    );
    let page3 = call_mcp(
        &fixture.registry,
        &fresh_owner(fixture).await,
        [0x46; 16],
        "start_session",
        json!({ "continuation": cont2, "deliveryReceipt": receipt2 }),
    )
    .await
    .expect("page 3 must succeed under sliding TTL even past page 1's original deadline");
    assert!(
        page3.structured_content["delta"]["changes"]
            .as_array()
            .is_some_and(|changes| !changes.is_empty()),
        "page 3 must deliver remaining changes: {}",
        page3.structured_content
    );
}

#[inline(never)]
async fn tainted_personal_chat_in_shared_space_releases_claim_cleanly(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x02).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x31; 16]),
                    kind: SpaceKind::Shared,
                    name: "Tainted Claim Cleanup Shared".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let shared_ctx = SpaceContext::new(owner.auth().clone(), shared.history.clone(), budget())
        .expect("owner shared space context");
    let tid = ChatThreadId::from_bytes([0x31; 16]);
    fixture
        .canonical
        .create_chat(
            shared_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x31; 16]),
                    hash: ContentDigest::from_bytes([0x31; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: tid.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Personal chat in Shared Space".into(),
                },
            },
        )
        .await
        .unwrap();
    let personal_root = fixture
        .canonical
        .read_space(&pscope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let personal_note = NoteId::from_bytes([0x31; 16]);
    fixture
        .canonical
        .create_note(
            SpaceContext::new(owner.auth().clone(), pscope.clone(), budget()).unwrap(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x31; 16]),
                    hash: ContentDigest::from_bytes([0x31; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: personal_note.clone(),
                    parent: Some(personal_root),
                    slug: "taint-source-personal".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Personal Secret\n\nPrivate note body.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    // 1. Direct canonical lifecycle: a Personal chat AgentRun in a Shared Space
    //    whose auth becomes cross-space tainted must still be rejected by
    //    `append_chat` (CrossSpaceTainted), yet MUST be able to inspect pending
    //    inputs, dismiss its queued rows, and clear its own `active_run_id` claim.
    let run1 = AgentRunId::from_bytes([0x31; 16]);
    let run1_auth = owner
        .auth()
        .for_agent_run(
            run1.clone(),
            shared.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run1_shared =
        SpaceContext::new(run1_auth.clone(), shared.history.clone(), budget()).unwrap();
    let claim1 = fixture
        .canonical
        .claim_active_run(
            run1_shared.clone(),
            ClaimChatRun {
                thread: tid.clone(),
                run: run1.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(claim1, ClaimChatRunOutcome::Claimed));
    let _ = fixture
        .canonical
        .get_note(
            SpaceContext::new(run1_auth.clone(), pscope.clone(), budget()).unwrap(),
            GetNote {
                note: personal_note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert!(
        run1_auth.taint().is_tainted(),
        "reading a Personal-space note from a Shared-space AgentRun must flip BranchTaint"
    );
    let tainted_append = fixture
        .canonical
        .append_chat(
            run1_shared.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x31, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0x31; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: tid.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Must be blocked".into()),
                    tool_calls: vec![],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await;
    assert!(
        matches!(
            tainted_append,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ),
        "tainted AgentRun append_chat in Shared Space must fail with CrossSpaceTainted, got {tainted_append:?}"
    );
    let pending1 = fixture
        .canonical
        .list_pending_chat_inputs(run1_shared.clone(), tid.clone())
        .await
        .expect("tainted active claim owner must still list pending inputs");
    assert!(pending1.is_empty());
    let cleared1 = fixture
        .canonical
        .finish_run_if_queue_empty(
            run1_shared.clone(),
            ChatRunRequest {
                thread: tid.clone(),
                expected_run: run1.clone(),
            },
        )
        .await
        .expect("tainted active claim owner must still release active_run_id");
    assert!(matches!(cleared1, FinishChatRunOutcome::Cleared));

    // Also verify `dismiss_chat_input` + `finish_run_if_queue_empty` with a
    // pending row queued against a tainted active run.
    let run2 = AgentRunId::from_bytes([0x32; 16]);
    let run2_auth = owner
        .auth()
        .for_agent_run(
            run2.clone(),
            shared.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run2_shared =
        SpaceContext::new(run2_auth.clone(), shared.history.clone(), budget()).unwrap();
    assert!(matches!(
        fixture
            .canonical
            .claim_active_run(
                run2_shared.clone(),
                ClaimChatRun {
                    thread: tid.clone(),
                    run: run2.clone(),
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    ));
    let queued_id = PendingInputId::from_bytes([0x32; 16]);
    let queued_sub = fixture
        .canonical
        .submit_user_chat_input(
            shared_ctx.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x32; 16]),
                    hash: ContentDigest::from_bytes([0x32; 32]),
                },
                id: queued_id.clone(),
                thread: tid.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Queued while run2 runs".into(),
                mentions_agent: false,
            },
        )
        .await
        .unwrap();
    assert!(matches!(queued_sub, SubmitUserChatOutcome::Queued(_)));
    let _ = fixture
        .canonical
        .get_note(
            SpaceContext::new(run2_auth.clone(), pscope.clone(), budget()).unwrap(),
            GetNote {
                note: personal_note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert!(run2_auth.taint().is_tainted());
    let pending2 = fixture
        .canonical
        .list_pending_chat_inputs(run2_shared.clone(), tid.clone())
        .await
        .expect("tainted run2 must list queued pending inputs");
    assert_eq!(pending2.len(), 1);
    assert_eq!(pending2[0].id, queued_id);
    // Non-owning tainted AgentRun (run1_shared) must fail identically with
    // InvalidAuthority for BOTH an absent PendingInputId AND the real queued_id
    // (closing the pending-input existence oracle & non-owning lifecycle leak).
    for probe_input in [
        PendingInputId::from_bytes([0x32, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        queued_id.clone(),
    ] {
        let non_owner_dismiss = fixture
            .canonical
            .dismiss_chat_input(
                run1_shared.clone(),
                DismissPending {
                    thread: tid.clone(),
                    input: probe_input,
                },
            )
            .await;
        assert!(
            matches!(
                non_owner_dismiss,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidAuthority
            ),
            "non-owning tainted AgentRun dismiss_chat_input must fail with InvalidAuthority, got {non_owner_dismiss:?}"
        );
    }

    assert!(
        fixture
            .canonical
            .dismiss_chat_input(
                run2_shared.clone(),
                DismissPending {
                    thread: tid.clone(),
                    input: queued_id,
                },
            )
            .await
            .expect("tainted run2 must dismiss its queued pending input")
    );
    assert!(matches!(
        fixture
            .canonical
            .finish_run_if_queue_empty(
                run2_shared,
                ChatRunRequest {
                    thread: tid.clone(),
                    expected_run: run2,
                },
            )
            .await
            .expect("tainted run2 must clear active_run_id after dismissing queue"),
        FinishChatRunOutcome::Cleared
    ));

    // 2. End-to-end AgentRunSupervisor proof: a supervised Personal chat run in
    //    a Shared Space reads a Personal-space note via tool call, becomes
    //    tainted, fails assistant commit with CrossSpaceTainted, releases its
    //    active_run_id cleanly, and allows a subsequent clean turn to commit!
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x04, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x06,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x07,
        ProviderAttachmentTarget::Space(shared.history.space_id.clone()),
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x08,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: shared.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let options = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        limits: RunLimits {
            max_steps: 3,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
        ..ChatRunOptions::default()
    };
    let submitted = supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x33; 16]),
                    hash: ContentDigest::from_bytes([0x33; 32]),
                },
                id: PendingInputId::from_bytes([0x33; 16]),
                thread: tid.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Please read my personal note.".into(),
                mentions_agent: false,
            },
            options.clone(),
        )
        .await
        .unwrap();
    assert!(submitted.run.is_some());
    let (mut wire1, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("step 1 must reach provider");
    let mut run_stream = supervisor
        .subscribe(owner.clone(), shared.history.clone(), tid.clone(), None)
        .await
        .unwrap()
        .expect("active run stream must be subscribable");
    send_ollama(
        &mut wire1,
        json!({
            "role": "assistant",
            "content": "Checking personal note.",
            "tool_calls": [{
                "function": {
                    "name": "get_note",
                    "arguments": { "ref": personal_note }
                }
            }]
        }),
        "tool_calls",
    )
    .await;
    // After get_note succeeds on Personal space, run.auth is cross-space tainted.
    // Committing the Tool entry into the Shared Space fails with CrossSpaceTainted
    // before step 2 can be dispatched; wait directly on the stream closing cleanly.
    let stream_ev: Vec<Value> = timeout(Duration::from_secs(15), async {
        let mut events = Vec::new();
        loop {
            match run_stream.next().await {
                notarium_agents::chats::stream::StreamRead::Frame(frame) => {
                    events.push(serde_json::from_slice(frame.payload()).unwrap());
                }
                notarium_agents::chats::stream::StreamRead::Closed => return events,
                notarium_agents::chats::stream::StreamRead::CatchUpRequired(_) => (),
            }
        }
    })
    .await
    .expect("tainted run stream must close promptly");
    assert_eq!(
        stream_ev.last().and_then(|ev| ev.get("type")),
        Some(&json!("run_failed")),
        "tainted run must terminate with run_failed: {stream_ev:?}"
    );
    let settled_leaf = idle_leaf(fixture, &shared_ctx, &tid).await;
    assert_eq!(
        settled_leaf,
        ThreadEntrySeq::new(2).unwrap(),
        "only Human(1) and Model(2) must commit before tainted Tool(3) is blocked"
    );
    let branch_after_taint = fixture
        .canonical
        .read_chat(
            shared_ctx.clone(),
            ChatRead {
                thread: tid.clone(),
                leaf: settled_leaf,
                before: None,
                max_entries: PageLimit::new(20).unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(
        branch_after_taint.thread.active_run.is_none(),
        "tainted Personal chat in Shared Space must release active_run_id instead of wedging thread"
    );
    assert!(
        branch_after_taint
            .entries
            .iter()
            .all(|e| !matches!(e.kind, ChatEntryKind::Tool { .. })),
        "tainted tool result must never commit into Shared Space: {:?}",
        branch_after_taint.entries
    );

    // Follow-up clean turn on the exact same thread MUST succeed!
    let clean_run = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: shared.history.clone(),
                thread: tid.clone(),
                expected_leaf: settled_leaf,
                options,
            },
        )
        .await
        .expect("follow-up clean start on previously tainted Shared thread must succeed");
    let (mut wire3, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("clean follow-up run must reach provider");
    send_ollama(
        &mut wire3,
        json!({"role": "assistant", "content": "Clean follow-up reply."}),
        "stop",
    )
    .await;
    let final_leaf = idle_leaf(fixture, &shared_ctx, &tid).await;
    assert!(final_leaf > settled_leaf);
    let final_branch = fixture
        .canonical
        .read_chat(
            shared_ctx,
            ChatRead {
                thread: tid,
                leaf: final_leaf,
                before: None,
                max_entries: PageLimit::new(20).unwrap(),
            },
        )
        .await
        .unwrap();
    assert!(final_branch.thread.active_run.is_none());
    assert!(
        final_branch.entries.iter().any(
            |e| matches!(&e.body, ChatBody::Inline(s) if s.contains("Clean follow-up reply."))
        ),
        "clean follow-up reply must commit after tainted run released claim"
    );
    let _ = clean_run;
}

struct PromotedAbilityProbeSetup {
    proj_space: AccessibleSpace,
    proj_p1: FolderRef,
    p2_role_ref: String,
    local: LoopbackProvider,
    listener: TcpListener,
}

#[inline(never)]
async fn project_only_consent_space_ability_and_unconsented_episode_hint(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) -> PromotedAbilityProbeSetup {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();

    // 1. Unconsented Shared Space with a project + subfolder, bound to an episode
    //    via ExternalMcp (`episode.project_hint`).
    let unconsented = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x0C).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x36; 16]),
                    kind: SpaceKind::Shared,
                    name: "Unconsented Hint Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let proj_unconsented = create_project_folder(
        fixture,
        &unconsented.history,
        &actor,
        FolderId::from_bytes([0x36; 16]),
        "hint-proj",
    )
    .await;
    let active_epoch = fixture
        .canonical
        .read_space(&unconsented.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: unconsented.history.clone(),
            active_epoch,
            folder_id: FolderId::from_bytes([0x36, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            parent: Some(proj_unconsented.folder_id.clone()),
            slug: "sub".into(),
            display_name: "sub".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let started = call_mcp(
        &fixture.registry,
        &owner,
        [0x36, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "start_session",
        json!({ "project": format!("{}/hint-proj", unconsented.slug) }),
    )
    .await
    .unwrap();
    let hint_ep_id = started.structured_content["session"]["id"]
        .as_str()
        .expect("start_session must return session id")
        .to_owned();

    // 2. Shared Space with project-only consent on `proj_p1` (UserDoc + Skill),
    //    NO Space-wide consent and NO consent on `proj_p2`, plus an OwnedSpace
    //    role `space-guide` and an OwnedProject(proj_p2) role `p2-guide`.
    let proj_space = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x0D).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x39; 16]),
                    kind: SpaceKind::Shared,
                    name: "Project Consent Ability Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let proj_p1 = create_project_folder(
        fixture,
        &proj_space.history,
        &actor,
        FolderId::from_bytes([0x39; 16]),
        "proj-one",
    )
    .await;
    let _proj_p2 = create_project_folder(
        fixture,
        &proj_space.history,
        &actor,
        FolderId::from_bytes([0x3A; 16]),
        "proj-two",
    )
    .await;
    let space_role = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "space-guide",
            "description": "Shared space role",
            "instructions": "Follow space conventions.",
            "placement": { "home": "space", "space": proj_space.slug },
        }),
    )
    .await
    .unwrap();
    let space_role_ref = space_role.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let p2_role = call_mcp(
        &fixture.registry,
        &owner,
        [0x3A, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p2-guide",
            "description": "Unconsented sibling project role",
            "instructions": "Secret p2 instructions.",
            "placement": {
                "home": "project",
                "project": format!("{}/proj-two", proj_space.slug),
            },
        }),
    )
    .await
    .unwrap();
    let p2_role_ref = p2_role.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x47, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x49,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x4A,
        ProviderAttachmentTarget::Project(proj_p1.clone()),
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x4B,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: proj_space.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;

    // Positive control: under ExternalMcp, `hint_ep_id` genuinely resolves `sub`.
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: unconsented.history.space_id.clone(),
            note_id: NoteId::from_bytes([0x36; 16]),
        },
        notes: Vec::new(),
    });
    let ext_list = call_mcp(
        &fixture.registry,
        &owner,
        [0x36, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "list_notes",
        json!({ "session": hint_ep_id }),
    )
    .await
    .unwrap();
    assert!(
        serde_json::to_string(&ext_list.structured_content)
            .unwrap()
            .contains("\"sub\""),
        "ExternalMcp positive control must resolve subfolder via episode.project_hint: {}",
        ext_list.structured_content
    );

    // (a) Unconsented episode.project_hint MUST fail with ResourceNotFound AND
    //     never flip cross-space BranchTaint across search, recall, list_notes,
    //     and rename_folder.
    let hint_probe_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x36; 16]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let hint_probe_account = AccountContext::new(hint_probe_auth.clone(), budget());
    for (idx, (tool, args)) in [
        ("search", json!({ "query": "hint", "session": hint_ep_id })),
        ("recall", json!({ "query": "hint", "session": hint_ep_id })),
        ("list_notes", json!({ "session": hint_ep_id })),
        (
            "rename_folder",
            json!({ "folder": "sub", "name": "renamed", "session": hint_ep_id }),
        ),
        (
            "move_folder",
            json!({ "folder": "sub", "toFolder": "other", "session": hint_ep_id }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let res = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: hint_probe_account.clone(),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0x36,
                        0x10 + idx as u8,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        1,
                    ]),
                },
                tool,
                args,
            )
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "{tool} with unconsented cross-Space episode.project_hint must return ResourceNotFound, got {:?}",
            res.err()
        );
        assert!(
            !hint_probe_auth.taint().is_tainted(),
            "{tool} with unconsented episode.project_hint must not flip BranchTaint"
        );
    }

    // (b) Under project-only consent on `proj_p1`, Space-level (`OwnedSpace`)
    //     abilities in the SAME Space MUST remain readable via `get_ability`
    //     and `use_role`, while sibling-project (`OwnedProject(proj_p2)`)
    //     abilities MUST be rejected!
    let p1_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x39; 16]),
            proj_space.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let p1_account = AccountContext::new(p1_run_auth, budget());
    let got_space_role = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: p1_account.clone(),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: Some(proj_p1.clone()),
                },
                request_key: CommandKey::from_bytes([
                    0x39, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "get_ability",
            json!({ "ref": space_role_ref }),
        )
        .await
        .expect("OwnedSpace ability in same Space must be readable under project-only consent");
    assert!(
        got_space_role.structured_content["instructions"]
            .as_str()
            .is_some_and(|s| s.contains("Follow space conventions.")),
        "unexpected get_ability payload: {}",
        got_space_role.structured_content
    );
    let used_space_role = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: p1_account.clone(),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: Some(proj_p1.clone()),
                },
                request_key: CommandKey::from_bytes([
                    0x39, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "use_role",
            json!({ "role": space_role_ref }),
        )
        .await
        .expect(
            "use_role on OwnedSpace role in same Space must succeed under project-only consent",
        );
    assert!(
        used_space_role.structured_content["instructions"]
            .as_str()
            .is_some_and(|s| s.contains("Follow space conventions."))
    );
    let p2_denied = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: p1_account,
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: Some(proj_p1.clone()),
                },
                request_key: CommandKey::from_bytes([
                    0x39, 0x13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                ]),
            },
            "get_ability",
            json!({ "ref": p2_role_ref }),
        )
        .await;
    assert!(
        matches!(
            p2_denied,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "sibling-project ability must collapse to exact ResourceNotFound under proj_p1-only consent (no existence oracle), got {:?}",
        p2_denied.err()
    );

    PromotedAbilityProbeSetup {
        proj_space,
        proj_p1,
        p2_role_ref,
        local,
        listener,
    }
}

#[inline(never)]
async fn promoted_ability_project_only_consent_boundary(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    setup: PromotedAbilityProbeSetup,
) {
    let PromotedAbilityProbeSetup {
        proj_space,
        proj_p1,
        p2_role_ref,
        local,
        listener,
    } = setup;
    let owner = fresh_owner(fixture).await;

    // (c) Promoted-from project-only consent boundary (including republished
    //     OwnedSpace abilities and runtime_abilities + ProviderService::complete!):
    //     Promote `p2-guide` (from unconsented `proj_p2`) to OwnedSpace and
    //     republish so both `current` and `published` placements are OwnedSpace
    //     while `promoted_from == OwnedProject(proj_p2)`. Do the same for a
    //     `p1-guide` authored in consented `proj_p1` as positive control.
    let p1_role = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p1-promoted-guide",
            "description": "Consented project role to promote",
            "instructions": "Consented p1 instructions v1.",
            "placement": {
                "home": "project",
                "project": format!("{}/proj-one", proj_space.slug),
            },
        }),
    )
    .await
    .unwrap();
    let p1_role_ref = p1_role.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let p2_promoted_1 = call_mcp(
        &fixture.registry,
        &owner,
        [0x3A, 0x21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "edit_ability",
        json!({
            "ref": p2_role_ref,
            "home": { "home": "space" },
        }),
    )
    .await
    .unwrap();
    let p2_promoted_ref_1 = p2_promoted_1.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let p2_republished = call_mcp(
        &fixture.registry,
        &owner,
        [0x3A, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": p2_promoted_ref_1,
            "versionToken": p2_promoted_1.structured_content["versionToken"],
            "instructions": "Promoted p2 instructions v2 (republished at OwnedSpace).",
            "availability": { "mode": "all-projects" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    let p2_repub_ref = p2_republished.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();

    let p1_promoted_1 = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 0x21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "edit_ability",
        json!({
            "ref": p1_role_ref,
            "home": { "home": "space" },
        }),
    )
    .await
    .unwrap();
    let p1_promoted_ref_1 = p1_promoted_1.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let p1_republished = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": p1_promoted_ref_1,
            "versionToken": p1_promoted_1.structured_content["versionToken"],
            "instructions": "Promoted p1 instructions v2 (republished at OwnedSpace).",
            "availability": { "mode": "all-projects" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    let p1_repub_ref = p1_republished.structured_content["ref"]
        .as_str()
        .unwrap()
        .to_owned();

    let p1_run_auth_2 = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x39, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            proj_space.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let p1_account_2 = AccountContext::new(p1_run_auth_2, budget());
    for (idx, (tool, args)) in [
        ("get_ability", json!({ "ref": p2_repub_ref })),
        ("use_role", json!({ "role": p2_repub_ref })),
    ]
    .into_iter()
    .enumerate()
    {
        let denied = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: p1_account_2.clone(),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: Some(proj_p1.clone()),
                    },
                    request_key: CommandKey::from_bytes([
                        0x3A,
                        0x30 + idx as u8,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        1,
                    ]),
                },
                tool,
                args,
            )
            .await;
        assert!(
            matches!(
                denied,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "{tool} must reject republished OwnedSpace ability promoted from unconsented proj_p2 with ResourceNotFound, got {:?}",
            denied.err()
        );
    }
    let p1_repub_ok = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: p1_account_2,
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: Some(proj_p1.clone()),
                },
                request_key: CommandKey::from_bytes([
                    0x39, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "use_role",
            json!({ "role": p1_repub_ref }),
        )
        .await
        .expect("republished OwnedSpace ability promoted from consented proj_p1 must succeed");
    assert!(
        p1_repub_ok.structured_content["instructions"]
            .as_str()
            .is_some_and(|s| s.contains("Promoted p1 instructions v2"))
    );

    // Runtime loader + ProviderService::complete check (`runtime_abilities::interactive`
    // and `admission.rs` `ProviderCurrentContent::Ability::in_project`):
    // Run on `personal` primary Space (where `run.auth` has full read access to
    // `proj_space` with `project_root = None`) and an episode whose `project_hint`
    // is consented `proj_p1`, proving the denial comes from `promoted_from` and NOT
    // from `project_root`!
    let ep_id = EpisodeId::from_bytes([0x39, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let _ = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x4F).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_id.clone(),
                        name: None,
                    },
                    project_hint: Some(proj_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let p1_handle = format!("{}/proj-one", proj_space.slug);
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 0x42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "use_role",
        json!({ "role": p2_repub_ref, "project": p1_handle, "session": ep_id }),
    )
    .await
    .unwrap();

    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x39, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let primary_ctx =
        SpaceContext::new(run_auth.clone(), personal.scope().clone(), budget()).unwrap();
    let primary_sel = local
        .provider
        .select_provider(
            primary_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let rt_denied = notarium_agents::mcp::runtime_abilities::interactive(
        &local.registry,
        &primary_ctx,
        &primary_sel,
        &ep_id,
    )
    .await;
    assert!(
        matches!(rt_denied, Err(PortError::Domain(DomainError::AccessDenied))),
        "runtime_abilities::interactive must reject republished OwnedSpace ability promoted from unconsented proj_p2 with AccessDenied, got {:?}",
        rt_denied.err()
    );

    // Direct ProviderService::complete defense-in-depth check: even if a caller
    // constructs a `ProviderMessage::Ability` for `p2_repub` directly, `admission.rs`
    // must reject it under `proj_p1`-only secondary consent before reaching the wire!
    let p2_active = fixture
        .control
        .get_episode(owner.clone(), ep_id.clone())
        .await
        .unwrap()
        .active_role
        .expect("episode must have active p2_repub role");
    let p2_repub_id = p2_active.id;
    let p2_repub_rev = p2_active.revision;
    let p2_space_ctx =
        SpaceContext::new(run_auth.clone(), proj_space.history.clone(), budget()).unwrap();
    let p2_sel = local
        .provider
        .select_provider(
            p2_space_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: Some(proj_p1.clone()),
            },
        )
        .await
        .unwrap();
    let p2_res = fixture
        .canonical
        .read_ability_resource(
            p2_space_ctx.clone(),
            ReadAbilityResource {
                ability: p2_repub_id,
                package_revision: p2_repub_rev,
                resource: notarium_core::model::AbilityResourceName::Entrypoint,
            },
        )
        .await
        .unwrap();
    let p2_msg = notarium_core::classes::ProviderMessage::Ability(Box::new(
        notarium_core::classes::ClassEgressFence::ability(
            p2_res,
            p2_space_ctx.auth(),
            &p2_sel.policy,
        )
        .unwrap(),
    ));
    let direct_req = CompletionRequest {
        intent: CommandKey::from_bytes([0x3A, 0x45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        selection: primary_sel.clone(),
        secondary_projects: vec![proj_p1.clone()],
        messages: vec![CompletionMessage {
            role: CompletionRole::System,
            instruction: Some(
                ProviderInstruction::from_orchestrator("Use active role.".into()).unwrap(),
            ),
            parts: vec![p2_msg],
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 4096,
            max_output_tokens: 256,
            max_tool_calls: 0,
        },
    };
    let direct_err = match local
        .provider
        .complete(primary_ctx.clone(), direct_req)
        .await
    {
        Ok(mut stream) => stream
            .next()
            .await
            .expect_err("ProviderService::complete must reject promoted proj_p2 ability"),
        Err(err) => err,
    };
    assert!(
        matches!(
            direct_err,
            PortError::Domain(DomainError::ValidationFailed { .. } | DomainError::AccessDenied)
        ),
        "ProviderService::complete must deny promoted proj_p2 ability under proj_p1-only consent: {direct_err:?}"
    );
    assert!(
        timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "promoted proj_p2 role must never reach provider socket"
    );

    // Positive runtime control: switch episode to `p1_repub` (promoted from
    // consented `proj_p1`) -> BOTH `runtime_abilities::interactive` AND
    // `ProviderService::complete` MUST succeed and reach the wire!
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0x39, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "use_role",
        json!({ "role": p1_repub_ref, "project": p1_handle, "session": ep_id }),
    )
    .await
    .unwrap();
    let rt_ok = notarium_agents::mcp::runtime_abilities::interactive(
        &local.registry,
        &primary_ctx,
        &primary_sel,
        &ep_id,
    )
    .await
    .expect("runtime_abilities::interactive must allow republished OwnedSpace ability promoted from consented proj_p1");
    assert_eq!(rt_ok.secondary_projects, std::slice::from_ref(&proj_p1));
    let ok_req = CompletionRequest {
        intent: CommandKey::from_bytes([0x39, 0x45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        selection: primary_sel,
        secondary_projects: rt_ok.secondary_projects,
        messages: vec![CompletionMessage {
            role: CompletionRole::System,
            instruction: Some(
                ProviderInstruction::from_orchestrator("Use active role.".into()).unwrap(),
            ),
            parts: rt_ok.parts,
            tool_calls: vec![],
            result_for: None,
        }],
        tools: vec![],
        budget: CompletionBudget {
            max_input_tokens: 4096,
            max_output_tokens: 256,
            max_tool_calls: 0,
        },
    };
    let wire_task = tokio::spawn(async move {
        let (mut ok_wire, ok_prompt) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .expect("promoted proj_p1 role must reach provider");
        send_ollama(
            &mut ok_wire,
            json!({"role": "assistant", "content": "Allowed promoted p1 ok."}),
            "stop",
        )
        .await;
        ok_prompt
    });
    let mut stream = local
        .provider
        .complete(primary_ctx, ok_req)
        .await
        .expect("ProviderService::complete must accept promoted proj_p1 role");
    let mut finished = false;
    while let Some(ev) = stream.next().await.unwrap() {
        finished |= matches!(ev, CompletionEvent::Finished(CompletionFinish::Stop));
    }
    assert!(finished);
    let ok_prompt = wire_task.await.unwrap();
    assert!(
        serde_json::to_string(&ok_prompt)
            .unwrap()
            .contains("Promoted p1 instructions v2"),
        "prompt must carry consented promoted proj_p1 role instructions"
    );
}

struct CrossSpaceProbeSetup {
    local: LoopbackProvider,
    _listener: TcpListener,
    space_write_id: SpaceId,
}

#[inline(never)]
async fn cross_space_taint_oracle_and_write_isolation_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) -> CrossSpaceProbeSetup {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let personal_root = fixture
        .canonical
        .read_space(&pscope.space_id)
        .await
        .unwrap()
        .root_folder_id;

    // 1. Shared Space consented ONLY for AgentMemory (no UserDoc!) with 2 UserDoc
    //    notes inside `proj_iso` to verify list_notes hides pagination/incomplete
    //    and missing paths never flip BranchTaint.
    let space_mem = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x89).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x89; 16]),
                    kind: SpaceKind::Shared,
                    name: "AgentMemory Only List Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let space_write = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x8A).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x8A; 16]),
                    kind: SpaceKind::Shared,
                    name: "Consented Cross Space Write Probe".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let proj_mem = create_project_folder(
        fixture,
        &space_mem.history,
        &actor,
        FolderId::from_bytes([0x89; 16]),
        "mem-proj",
    )
    .await;
    let mem_ctx =
        SpaceContext::new(owner.auth().clone(), space_mem.history.clone(), budget()).unwrap();
    let mut mem_notes = Vec::new();
    for idx in 1_u8..=3 {
        let note_id = NoteId::from_bytes([0x89, idx, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx]);
        fixture
            .canonical
            .create_note(
                mem_ctx.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: space_mem.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0x89, idx, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx,
                        ]),
                        hash: ContentDigest::from_bytes([0x89; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note_id.clone(),
                        parent: Some(proj_mem.folder_id.clone()),
                        slug: format!("hidden-udoc-{idx}"),
                        class: DocClass::UserDoc,
                        carrier: format!("# Hidden {idx}\n\nUnconsented user doc {idx}.\n"),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
        mem_notes.push(note_id);
    }
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: space_mem.history.space_id.clone(),
            note_id: mem_notes[0].clone(),
        },
        notes: mem_notes,
    });

    let proj_write = create_project_folder(
        fixture,
        &space_write.history,
        &actor,
        FolderId::from_bytes([0x8A; 16]),
        "write-proj",
    )
    .await;
    let write_epoch = fixture
        .canonical
        .read_space(&space_write.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: space_write.history.clone(),
            active_epoch: write_epoch,
            folder_id: FolderId::from_bytes([0x8A, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            parent: Some(proj_write.folder_id.clone()),
            slug: "wsub".into(),
            display_name: "wsub".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let write_note = NoteId::from_bytes([0x8A; 16]);
    fixture
        .canonical
        .create_note(
            SpaceContext::new(owner.auth().clone(), space_write.history.clone(), budget()).unwrap(),
            Mutation {
                identity: CommandIdentity {
                    scope: space_write.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x8A; 16]),
                    hash: ContentDigest::from_bytes([0x8A; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: write_note.clone(),
                    parent: Some(proj_write.folder_id.clone()),
                    slug: "target-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Target\n\nBody text.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    // Add an OwnedSpace role in `space_write` to test `list_abilities(q: ...)` taint isolation.
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0x8A, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_ability",
        json!({
            "kind": "role",
            "name": "write-space-role",
            "description": "Special role in write space",
            "instructions": "Instructions for write space role that intentionally exceed the minimum 100-byte activation token budget so budget_tokens=100 rejects cleanly.",
            "placement": { "home": "space", "space": space_write.slug },
        }),
    )
    .await
    .unwrap();
    // Create a fresher personal note AFTER `space_write` so `recent_activity(limit: 1)`
    // fills exclusively from `personal` without returning any `space_write` item.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let fresh_personal_note = NoteId::from_bytes([0x8B; 16]);
    fixture
        .canonical
        .create_note(
            SpaceContext::new(owner.auth().clone(), pscope.clone(), budget()).unwrap(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0x8B; 16]),
                    hash: ContentDigest::from_bytes([0x8B; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: fresh_personal_note.clone(),
                    parent: Some(personal_root),
                    slug: "freshest-personal-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Fresh Personal\n\nNewest item.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x8B, true).await;
    // Tags used: 0x8B, 0x8C (loopback); approvals use tag & tag+3 -> 0x8D(+0x90), 0x8E(+0x91?),
    // avoid 0x91 (already used!). Use 0xF8..0xFE (100% unused!) or 0xA9..0xAF!
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xA9,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xAA,
        ProviderAttachmentTarget::Space(space_mem.history.space_id.clone()),
        [DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xAB,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: space_mem.history.space_id.clone(),
        },
        [DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xF8,
        ProviderAttachmentTarget::Space(space_write.history.space_id.clone()),
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xF9,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: space_write.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;

    let make_run = |tag: u8| {
        let auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0x89, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let acc = AccountContext::new(auth.clone(), budget());
        (auth, acc)
    };
    let make_ctx = |acc: &AccountContext, tag: u8| McpInvocationContext {
        account: acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x89, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };

    // (1) list_notes on AgentMemory-only Space: missing path returns empty +
    //     ZERO taint, and listing root hides UserDoc items, nextCursor, and incomplete!
    let (missing_auth, missing_acc) = make_run(1);
    let missing_list = local
        .registry
        .call_tool(
            make_ctx(&missing_acc, 1),
            "list_notes",
            json!({
                "project": format!("{}/mem-proj", space_mem.slug),
                "path": "does-not-exist",
            }),
        )
        .await
        .unwrap();
    assert_eq!(missing_list.structured_content["items"], json!([]));
    assert!(missing_list.structured_content.get("folderPage").is_none());
    assert!(
        missing_list.structured_content.get("total").is_none(),
        "InAppProvider empty list_notes response must omit total (no empty-shape oracle): {}",
        missing_list.structured_content
    );
    assert!(
        !missing_auth.taint().is_tainted(),
        "list_notes on missing cross-Space path must not flip BranchTaint"
    );

    // Invalid cursor on a consented cross-Space folder must reject before
    // committing live folder metadata taint.
    let stale_cursor_err = local
        .registry
        .call_tool(
            make_ctx(&missing_acc, 3),
            "list_notes",
            json!({
                "project": format!("{}/mem-proj", space_mem.slug),
                "cursor": "notes_00000000000000000000000000000000",
            }),
        )
        .await;
    assert!(
        matches!(
            &stale_cursor_err,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale
        ),
        "stale cursor must return CursorStale, got {:?}",
        stale_cursor_err.as_ref().err()
    );
    assert!(
        !missing_auth.taint().is_tainted(),
        "rejected stale cursor on cross-Space folder must not flip BranchTaint"
    );

    // Positive control: under ExternalMcp, `space_mem/mem-proj` genuinely has
    // paginated UserDoc items (1 item + nextCursor at limit 1).
    let ext_mem_list = call_mcp(
        &fixture.registry,
        &owner,
        [0x89, 0x9F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "list_notes",
        json!({
            "project": format!("{}/mem-proj", space_mem.slug),
            "limit": 1,
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        ext_mem_list.structured_content["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        ext_mem_list.structured_content["nextCursor"].is_string(),
        "ExternalMcp positive control must paginate the 3 UserDoc notes in space_mem"
    );

    let (_mem_auth, mem_acc) = make_run(2);
    let mem_list = local
        .registry
        .call_tool(
            make_ctx(&mem_acc, 2),
            "list_notes",
            json!({
                "project": format!("{}/mem-proj", space_mem.slug),
                "limit": 1,
            }),
        )
        .await
        .unwrap();
    assert_eq!(mem_list.structured_content["items"], json!([]));
    assert!(
        mem_list.structured_content.get("nextCursor").is_none(),
        "list_notes on AgentMemory-only Space must not emit nextCursor for unconsented UserDocs: {}",
        mem_list.structured_content
    );
    assert!(
        mem_list.structured_content.get("incomplete").is_none(),
        "list_notes on AgentMemory-only Space must not emit incomplete for unconsented UserDocs"
    );
    assert!(
        mem_list.structured_content.get("folderPage").is_none(),
        "list_notes on AgentMemory-only Space must omit folderPage uniformly (no cover-note oracle): {}",
        mem_list.structured_content
    );
    assert!(
        mem_list.structured_content.get("total").is_none(),
        "InAppProvider list_notes must omit total uniformly: {}",
        mem_list.structured_content
    );

    // (2) Cross-space rejected write tools MUST return SpaceReadOnly without
    //     flipping BranchTaint (no CrossSpaceTainted conversion or taint leak).
    let (write_auth, write_acc) = make_run(3);
    for (idx, (tool, args)) in [
        ("delete_note", json!({ "ref": write_note })),
        (
            "edit_note",
            json!({ "ref": write_note, "operation": "append", "content": "nope" }),
        ),
        (
            "rename_folder",
            json!({
                "project": format!("{}/write-proj", space_write.slug),
                "folder": "wsub",
                "name": "renamed",
            }),
        ),
        (
            "move_folder",
            json!({
                "project": format!("{}/write-proj", space_write.slug),
                "folder": "wsub",
                "toFolder": "",
            }),
        ),
        (
            "rename_project",
            json!({
                "project": format!("{}/write-proj", space_write.slug),
                "slug": "write-proj-renamed",
            }),
        ),
        (
            "link",
            json!({
                "from": write_note,
                "toTitle": "Other",
                "relation": "related",
            }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let res = local
            .registry
            .call_tool(make_ctx(&write_acc, 10 + idx as u8), tool, args)
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::SpaceReadOnly))),
            "cross-space direct {tool} must fail with SpaceReadOnly, got {:?}",
            res.err()
        );
        assert!(
            !write_auth.taint().is_tainted(),
            "rejected cross-space direct {tool} must not flip BranchTaint"
        );
    }

    CrossSpaceProbeSetup {
        local,
        _listener: listener,
        space_write_id: space_write.history.space_id,
    }
}

#[inline(never)]
async fn cross_space_recent_and_ability_filter_taint_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    setup: CrossSpaceProbeSetup,
) {
    let CrossSpaceProbeSetup {
        local,
        _listener,
        space_write_id,
    } = setup;
    let owner = fresh_owner(fixture).await;
    let pscope = personal.scope().clone();
    let make_run = |tag: u8| {
        let auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0x89, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let acc = AccountContext::new(auth.clone(), budget());
        (auth, acc)
    };
    let make_ctx = |acc: &AccountContext, tag: u8| McpInvocationContext {
        account: acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x89, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };

    // (3) recent_activity(limit: 1) filled exclusively by personal Space must
    //     NOT flip BranchTaint even though consented `space_write` had changes!
    let (recent_auth, recent_acc) = make_run(4);
    let recent_res = local
        .registry
        .call_tool(
            make_ctx(&recent_acc, 20),
            "recent_activity",
            json!({ "limit": 1 }),
        )
        .await
        .unwrap();
    let recent_items = recent_res.structured_content["items"].as_array().unwrap();
    assert_eq!(recent_items.len(), 1);
    assert_eq!(recent_items[0]["spaceId"], json!(pscope.space_id));
    assert!(
        !recent_auth.taint().is_tainted(),
        "recent_activity returning 0 cross-Space items must not flip BranchTaint"
    );
    // Positive control for Probe 3: widening limit returns `space_write` item AND flips taint!
    let recent_wide = local
        .registry
        .call_tool(
            make_ctx(&recent_acc, 22),
            "recent_activity",
            json!({ "limit": 20 }),
        )
        .await
        .unwrap();
    let recent_wide_items = recent_wide.structured_content["items"].as_array().unwrap();
    assert!(
        recent_wide_items
            .iter()
            .any(|item| item["spaceId"] == json!(space_write_id)),
        "recent_activity positive control must include space_write item: {recent_wide_items:?}"
    );
    assert!(
        recent_auth.taint().is_tainted(),
        "recent_activity delivering a cross-Space item MUST flip BranchTaint"
    );

    // (4) list_abilities(q: "nonexistent-needle-xyz") must NOT flip BranchTaint
    //     when cross-Space abilities fail the query filter, while matching
    //     `write-space-role` returns it AND flips BranchTaint (positive control).
    let (ab_auth, ab_acc) = make_run(5);
    let ab_res = local
        .registry
        .call_tool(
            make_ctx(&ab_acc, 21),
            "list_abilities",
            json!({ "view": "runtime", "limit": 50, "q": "nonexistent-needle-xyz" }),
        )
        .await
        .unwrap();
    assert_eq!(ab_res.structured_content["items"], json!([]));
    assert!(
        !ab_auth.taint().is_tainted(),
        "list_abilities with zero matching cross-Space items must not flip BranchTaint"
    );
    let ab_pos = local
        .registry
        .call_tool(
            make_ctx(&ab_acc, 23),
            "list_abilities",
            json!({ "view": "runtime", "limit": 50, "q": "write-space-role" }),
        )
        .await
        .unwrap();
    let ab_pos_items = ab_pos.structured_content["items"].as_array().unwrap();
    let write_role_ref = ab_pos_items
        .iter()
        .find(|item| item["name"] == "write-space-role")
        .expect("list_abilities positive control must return cross-Space write-space-role")["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        ab_auth.taint().is_tainted(),
        "list_abilities delivering cross-Space ability MUST flip BranchTaint"
    );

    // (5) Budget-exceeded cross-Space use_role must reject with BudgetExceeded
    //     WITHOUT flipping BranchTaint!
    let (budget_auth, budget_acc) = make_run(6);
    let budget_err = local
        .registry
        .call_tool(
            make_ctx(&budget_acc, 24),
            "use_role",
            json!({ "role": write_role_ref, "budgetTokens": 100 }),
        )
        .await;
    assert!(
        matches!(
            &budget_err,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::BudgetExceeded
        ),
        "use_role over budgetTokens must fail with BudgetExceeded, got {:?}",
        budget_err.as_ref().err()
    );
    assert!(
        !budget_auth.taint().is_tainted(),
        "budget-rejected cross-Space use_role must not flip BranchTaint"
    );
    // Positive control on the same run: raising budgetTokens delivers the role
    // and flips cross-Space BranchTaint.
    let budget_ok = local
        .registry
        .call_tool(
            make_ctx(&budget_acc, 25),
            "use_role",
            json!({ "role": write_role_ref, "budgetTokens": 500 }),
        )
        .await
        .unwrap();
    assert_eq!(budget_ok.structured_content["name"], "write-space-role");
    assert!(
        budget_auth.taint().is_tainted(),
        "admitted cross-Space use_role MUST flip BranchTaint"
    );
}

struct PreflightProbeRecipient {
    admit_all: bool,
}

impl SearchRecipient for PreflightProbeRecipient {
    fn filters_notes(&self) -> bool {
        true
    }

    fn admit<'a>(
        &'a self,
        _card: &'a notarium_core::classes::ClassifiedMetadata,
    ) -> PortFuture<'a, bool> {
        let admit = self.admit_all;
        Box::pin(async move { Ok(admit) })
    }
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn real_search_preflight_setup_and_class_exclusion_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    provider_svc: &Arc<ProviderService>,
    search: &Arc<SearchEngine>,
    root: &DataRoot,
    emb_registry: &ToolRegistry,
    chat_narrow_res: &ProviderResourceId,
    chat_narrow_model: &ModelProfileId,
) -> (AccessibleSpace, NoteId) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let space_udoc = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x3C).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([
                        0xFF, 0x3C, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3C,
                    ]),
                    kind: SpaceKind::Shared,
                    name: "UserDoc Only Preflight Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    assert!(
        personal.scope().space_id < space_udoc.history.space_id,
        "personal SpaceId must sort ahead of space_udoc for deterministic tie-break"
    );
    let owner = fresh_owner(fixture).await;
    // Consent ONLY DocClass::UserDoc (NOT AgentMemory) on `space_udoc`.
    let consent = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: [DocClass::UserDoc].into(),
        })
    };
    let info = provider_svc
        .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == *chat_narrow_res)
        .unwrap();
    for (target, req_tag, app_tag) in [
        (
            ProviderAttachmentTarget::Space(space_udoc.history.space_id.clone()),
            0x3D_u8,
            0x3F_u8,
        ),
        (
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: space_udoc.history.space_id.clone(),
            },
            0x18_u8,
            0x19_u8,
        ),
    ] {
        let attachment = provider_svc
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, req_tag).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([req_tag; 16]),
                        expected: None,
                        resource: info.id.clone(),
                        resource_consent_epoch: info.consent_epoch,
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
            let _ = provider_svc
                .approve_attachment(
                    owner.clone(),
                    AccountMutation {
                        identity: identity(fixture, &owner, app_tag).await,
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

    search.start_space(space_udoc.history.clone()).unwrap();
    let udoc_ctx =
        SpaceContext::new(owner.auth().clone(), space_udoc.history.clone(), budget()).unwrap();
    let udoc_root = fixture
        .canonical
        .read_space(&space_udoc.history.space_id)
        .await
        .unwrap()
        .root_folder_id;
    let agent_mem_note = NoteId::from_bytes([0x3C, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let user_doc_note = NoteId::from_bytes([0x3C, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    fixture
        .canonical
        .create_note(
            udoc_ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space_udoc.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x3C, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0x3C; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: agent_mem_note.clone(),
                    parent: Some(udoc_root.clone()),
                    slug: "agent-memory-only".into(),
                    class: DocClass::AgentMemory,
                    carrier: "# Agent Mem\n\nquartz-agentmem-only-token\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let created_udoc = fixture
        .canonical
        .create_note(
            udoc_ctx,
            Mutation {
                identity: CommandIdentity {
                    scope: space_udoc.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x3C, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0x3D; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: user_doc_note.clone(),
                    parent: Some(udoc_root),
                    slug: "userdoc-allowed".into(),
                    class: DocClass::UserDoc,
                    carrier: "# User Doc\n\nquartz-userdoc-allowed-token\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let layout = SearchLayout::open(root, space_udoc.history.clone()).unwrap();
    timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(Some(manifest)) = layout.search_manifest()
                && manifest.tantivy_seq >= created_udoc.receipt.seq()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("space_udoc lexical index must catch up");

    // 1. MCP `search` & `recall` with `class: "agent-memory"` on a UserDoc-only
    //    consented Shared Space must skip that Space (0 hits, degraded == [],
    //    and BranchTaint stays false).
    let probe_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x3C; 16]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let probe_account = AccountContext::new(probe_auth.clone(), budget());
    for (idx, (tool, args)) in [
        (
            "search",
            json!({ "query": "quartz-agentmem-only-token", "class": "agent-memory" }),
        ),
        ("recall", json!({ "query": "quartz-agentmem-only-token" })),
    ]
    .into_iter()
    .enumerate()
    {
        let res = emb_registry
            .call_tool(
                McpInvocationContext {
                    account: probe_account.clone(),
                    target: EgressTarget::InAppProvider {
                        provider: chat_narrow_res.clone(),
                        model: chat_narrow_model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0x3C,
                        0x20 + idx as u8,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        1,
                    ]),
                },
                tool,
                args,
            )
            .await
            .unwrap();
        assert!(
            !serde_json::to_string(&res.structured_content)
                .unwrap()
                .contains(agent_mem_note.as_str()),
            "{tool} must not return AgentMemory hits from UserDoc-only consented Space"
        );
        if tool == "search" {
            // `search` explicitly requested `class: "agent-memory"`, which is
            // disjoint from `space_udoc`'s `UserDoc`-only policy, so `space_udoc`
            // must be skipped completely without leaking vector degradation.
            assert_eq!(res.structured_content["degraded"], json!([]));
        }
        assert!(
            !probe_auth.taint().is_tainted(),
            "{tool} class-excluded on UserDoc-only Shared Space must not flip BranchTaint"
        );
    }

    (space_udoc, user_doc_note)
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn real_search_preflight_taint_limit_and_engine_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    search: &Arc<SearchEngine>,
    root: &DataRoot,
    emb_registry: &ToolRegistry,
    chat_narrow_res: &ProviderResourceId,
    chat_narrow_model: &ModelProfileId,
    space_udoc: &AccessibleSpace,
    user_doc_note: &NoteId,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let probe_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x3C, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let probe_account = AccountContext::new(probe_auth.clone(), budget());

    // 2. Multi-space search limit cut & recall maxPerSource packing MUST NOT
    //    flip cross-space BranchTaint when zero hits from `space_udoc` are delivered!
    let personal_root = fixture
        .canonical
        .read_space(&personal.scope().space_id)
        .await
        .unwrap()
        .root_folder_id;
    let personal_quartz = NoteId::from_bytes([0x3C, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    let created_personal_q = fixture
        .canonical
        .create_note(
            SpaceContext::new(owner.auth().clone(), personal.scope().clone(), budget()).unwrap(),
            Mutation {
                identity: CommandIdentity {
                    scope: personal.scope().clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x3C, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9,
                    ]),
                    hash: ContentDigest::from_bytes([0x3E; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: personal_quartz.clone(),
                    parent: Some(personal_root),
                    slug: "personal-quartz-winner".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Quartz Winner\n\nquartz-userdoc-allowed-token quartz-userdoc-allowed-token quartz-userdoc-allowed-token\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let personal_layout = SearchLayout::open(root, personal.scope().clone()).unwrap();
    timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(Some(manifest)) = personal_layout.search_manifest()
                && manifest.tantivy_seq >= created_personal_q.receipt.seq()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("personal lexical index must catch up");

    let limit_probe_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x3C, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let limit_probe_acc = AccountContext::new(limit_probe_auth.clone(), budget());
    let limit_cut = emb_registry
        .call_tool(
            McpInvocationContext {
                account: limit_probe_acc.clone(),
                target: EgressTarget::InAppProvider {
                    provider: chat_narrow_res.clone(),
                    model: chat_narrow_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0x3C, 0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "search",
            json!({ "query": "quartz-userdoc-allowed-token", "limit": 1 }),
        )
        .await
        .unwrap();
    let limit_results = limit_cut.structured_content["results"].as_array().unwrap();
    assert_eq!(limit_results.len(), 1);
    assert_eq!(
        limit_results[0]["noteId"],
        json!(personal_quartz),
        "personal higher-scoring hit must win limit: 1"
    );
    assert!(
        !limit_probe_auth.taint().is_tainted(),
        "cross-Space search hit dropped by multi-space limit cut must not flip BranchTaint"
    );

    let pack_dropped = emb_registry
        .call_tool(
            McpInvocationContext {
                account: limit_probe_acc.clone(),
                target: EgressTarget::InAppProvider {
                    provider: chat_narrow_res.clone(),
                    model: chat_narrow_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0x3C, 0x26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "recall",
            json!({
                "query": "quartz-userdoc-allowed-token",
                "budgetTokens": 200,
                "maxPerSource": 1,
            }),
        )
        .await
        .unwrap();
    assert_eq!(pack_dropped.structured_content["sources"], json!([]));
    assert!(
        !limit_probe_auth.taint().is_tainted(),
        "recall hit dropped by maxPerSource packing must not flip BranchTaint"
    );
    // Positive MCP recall control: widening maxPerSource returns `user_doc_note` AND flips BranchTaint.
    let mcp_recall_pos = emb_registry
        .call_tool(
            McpInvocationContext {
                account: limit_probe_acc,
                target: EgressTarget::InAppProvider {
                    provider: chat_narrow_res.clone(),
                    model: chat_narrow_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0x3C, 0x27, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                ]),
            },
            "recall",
            json!({
                "query": "quartz-userdoc-allowed-token",
                "budgetTokens": 2000,
                "maxPerSource": 500,
            }),
        )
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&mcp_recall_pos.structured_content)
            .unwrap()
            .contains(user_doc_note.as_str()),
        "positive MCP recall control must return consented UserDoc hit from space_udoc: {}",
        mcp_recall_pos.structured_content
    );
    assert!(
        limit_probe_auth.taint().is_tainted(),
        "positive MCP recall delivering cross-Space source MUST flip BranchTaint"
    );

    // 3. Direct real SearchEngine + ProjectionEngine preflight test (un-detached
    //    auth): zero-match non-recipient search, rejected recipient search, AND
    //    max_per_source-packed-out direct recall_for MUST all keep BranchTaint false,
    //    while positive admitted search_for & recall_for MUST return `user_doc_note`
    //    AND flip BranchTaint == true!
    let make_query = |text: &str| SearchQuery {
        text: text.into(),
        filter: notarium_core::query::FieldFilterAstV1 {
            version: 1,
            predicate: notarium_core::query::Predicate::All(vec![]),
        },
        classes: [DocClass::UserDoc].into(),
        folder: None,
        causal: CausalBasis::Await(Default::default()),
        include_chats: false,
        top_k: PageLimit::new(10).unwrap(),
        model: None,
    };
    let non_recip_zero = search
        .search(
            SpaceContext::new(probe_auth.clone(), space_udoc.history.clone(), budget()).unwrap(),
            make_query("nonexistent-quartz-miss-xyz"),
        )
        .await
        .unwrap();
    assert!(non_recip_zero.hits.is_empty());
    assert!(
        !probe_auth.taint().is_tainted(),
        "direct non-recipient SearchEngine zero-hit query must not flip cross-Space BranchTaint"
    );

    let reject_all = PreflightProbeRecipient { admit_all: false };
    let rejected = search
        .search_for(
            SpaceContext::new(probe_auth.clone(), space_udoc.history.clone(), budget()).unwrap(),
            make_query("quartz-userdoc-allowed-token"),
            Some(&reject_all),
        )
        .await
        .unwrap();
    assert!(rejected.hits.is_empty());
    assert!(
        !probe_auth.taint().is_tainted(),
        "real SearchEngine + ProjectionEngine preflight with rejected hits must not flip BranchTaint"
    );

    let admit_all = PreflightProbeRecipient { admit_all: true };
    let direct_recall_packed = search
        .recall_for(
            SpaceContext::new(probe_auth.clone(), space_udoc.history.clone(), budget()).unwrap(),
            RecallQuery {
                query: make_query("quartz-userdoc-allowed-token"),
                graph_depth: 1,
                token_budget: 200,
                max_per_source: Some(1),
            },
            Some(&admit_all),
        )
        .await
        .unwrap();
    assert!(direct_recall_packed.hits.is_empty());
    assert!(
        !probe_auth.taint().is_tainted(),
        "direct SearchEngine::recall_for packed out by max_per_source must not flip BranchTaint"
    );

    // Positive direct SearchEngine::recall_for control: sufficient max_per_source
    // returns `user_doc_note` AND flips BranchTaint == true!
    let direct_recall_ok = search
        .recall_for(
            SpaceContext::new(probe_auth.clone(), space_udoc.history.clone(), budget()).unwrap(),
            RecallQuery {
                query: make_query("quartz-userdoc-allowed-token"),
                graph_depth: 1,
                token_budget: 2000,
                max_per_source: Some(500),
            },
            Some(&admit_all),
        )
        .await
        .unwrap();
    assert!(
        direct_recall_ok
            .hits
            .iter()
            .any(|hit| hit.card.document.provenance().reference().note_id == *user_doc_note),
        "positive direct recall_for control must return the admitted UserDoc hit"
    );
    assert!(
        probe_auth.taint().is_tainted(),
        "positive direct recall_for delivering cross-Space hit MUST flip BranchTaint"
    );

    // Positive direct SearchEngine::search_for control on a fresh run auth.
    let search_pos_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x3C, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]),
            personal.scope().space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let admitted = search
        .search_for(
            SpaceContext::new(
                search_pos_auth.clone(),
                space_udoc.history.clone(),
                budget(),
            )
            .unwrap(),
            make_query("quartz-userdoc-allowed-token"),
            Some(&admit_all),
        )
        .await
        .unwrap();
    assert!(
        admitted
            .hits
            .iter()
            .any(|hit| hit.card.document.provenance().reference().note_id == *user_doc_note),
        "positive control must return the admitted UserDoc hit"
    );
    assert!(
        search_pos_auth.taint().is_tainted(),
        "positive control admitted cross-space hit MUST flip BranchTaint"
    );

    // 4. Positive MCP control: `search` for the consented `UserDoc` note in
    //    `space_udoc` MUST return it, proving `space_udoc` was genuinely
    //    consented for UserDoc (non-vacuous class-exclusion proof).
    let mcp_udoc_hit = emb_registry
        .call_tool(
            McpInvocationContext {
                account: probe_account,
                target: EgressTarget::InAppProvider {
                    provider: chat_narrow_res.clone(),
                    model: chat_narrow_model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0x3C, 0x2F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "search",
            json!({ "query": "quartz-userdoc-allowed-token" }),
        )
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&mcp_udoc_hit.structured_content)
            .unwrap()
            .contains(user_doc_note.as_str()),
        "positive MCP control must return consented UserDoc hit from space_udoc: {}",
        mcp_udoc_hit.structured_content
    );
}

#[inline(never)]
async fn space_group_role_isolation_and_ability_list_oracle_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0x5A, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0x5A; 32]),
            }
        }
    };
    let s1 = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: acc_id(1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x5A, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Group Role S1".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let s2 = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: acc_id(2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x5A, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    kind: SpaceKind::Shared,
                    name: "Group Role S2".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;

    // Publish identically named Space role "group-reviewer" in BOTH S1 and S2,
    // plus a Personal-only role "personal-only-role".
    for (tag, placement, instructions) in [
        (
            3u8,
            json!({ "home": "space", "space": s1.slug }),
            "S1-GROUP-REVIEWER-MARKER",
        ),
        (
            4u8,
            json!({ "home": "space", "space": s2.slug }),
            "S2-UNCONSENTED-REVIEWER-MARKER",
        ),
        (
            5u8,
            json!({ "home": "personal" }),
            "PERSONAL-ONLY-ROLE-MARKER",
        ),
    ] {
        let name = if tag == 5 {
            "personal-only-role"
        } else {
            "group-reviewer"
        };
        let _ = call_mcp(
            &fixture.registry,
            &owner,
            [0x5A, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
            "create_ability",
            json!({
                "kind": "role",
                "name": name,
                "description": "Group role isolation test",
                "instructions": instructions,
                "placement": placement,
            }),
        )
        .await
        .unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x5B, true).await;
    // Consent ONLY S1 (and Personal) — deliberately keep S2 UNCONSENTED.
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x5D,
        ProviderAttachmentTarget::Space(s1.history.space_id.clone()),
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xD9,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: s1.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xDA,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::Skill].into(),
    )
    .await;

    let s1_scope = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let thread = ChatThreadId::from_bytes([0x5A, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    let cmd = |sub: u8| CommandIdentity {
        scope: s1.history.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([0x5A, 0x10, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
        hash: ContentDigest::from_bytes([0x5A; 32]),
    };
    fixture
        .canonical
        .create_chat(
            s1_scope.clone(),
            Mutation {
                identity: cmd(1),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Group role thread".into(),
                },
            },
        )
        .await
        .unwrap();
    let msg = fixture
        .canonical
        .append_chat(
            s1_scope.clone(),
            Mutation {
                identity: cmd(2),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Start group review".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();

    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let base_opts = |role: Option<&str>| ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        role: role.map(ToOwned::to_owned),
        limits: RunLimits {
            max_steps: 2,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
    };

    // (1) SpaceGroup chat in S1 with options.role = "group-reviewer" must resolve
    //     unambiguously to S1's role even though S2 also defines "group-reviewer".
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: thread.clone(),
                expected_leaf: msg.value.seq,
                options: base_opts(Some("group-reviewer")),
            },
        )
        .await
        .unwrap();
    let (mut wire, prompt_req) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("SpaceGroup run with duplicate-name role across Spaces must reach provider");
    let prompt_text = prompt_req.to_string();
    assert!(
        prompt_text.contains("S1-GROUP-REVIEWER-MARKER")
            && !prompt_text.contains("S2-UNCONSENTED-REVIEWER-MARKER"),
        "SpaceGroup run must inject S1's role without colliding with S2"
    );
    send_ollama(
        &mut wire,
        json!({"role": "assistant", "content": "S1 role active."}),
        "stop",
    )
    .await;
    let leaf1 = idle_leaf(fixture, &s1_scope, &thread).await;

    // (2) Requesting a Personal-only role on a SpaceGroup thread must fail cleanly
    //     WITHOUT poisoning the thread's deterministic episode, so the next turn
    //     with options.role = None still runs cleanly.
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: thread.clone(),
                expected_leaf: leaf1,
                options: base_opts(Some("personal-only-role")),
            },
        )
        .await
        .unwrap();
    let leaf_after_err = idle_leaf(fixture, &s1_scope, &thread).await;
    assert_eq!(
        leaf_after_err, leaf1,
        "unreachable personal-only role on SpaceGroup thread must fail without appending"
    );
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: thread.clone(),
                expected_leaf: leaf1,
                options: base_opts(None),
            },
        )
        .await
        .unwrap();
    let (mut wire2, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("subsequent turn with role=None must not be poisoned by rejected personal role");
    send_ollama(
        &mut wire2,
        json!({"role": "assistant", "content": "Episode unpoisoned."}),
        "stop",
    )
    .await;
    let _ = idle_leaf(fixture, &s1_scope, &thread).await;

    // (3) InAppProvider list_abilities(view="authoring", kind="role", limit=1)
    //     must never return empty pages with nextCursor due to owned roles in
    //     unconsented S2, and mutating S2 must never cause CursorStale on page 2.
    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x5A, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_acc = AccountContext::new(run_auth, budget());
    let mk_ctx = |tag: u8| McpInvocationContext {
        account: run_acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x5A, 0x21, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };
    let page1 = local
        .registry
        .call_tool(
            mk_ctx(1),
            "list_abilities",
            json!({ "view": "authoring", "kind": "role", "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_eq!(
        page1["items"].as_array().unwrap().len(),
        1,
        "InAppProvider list_abilities must skip unconsented S2 roles rather than returning empty pages: {page1}"
    );
    let next_cursor = page1["nextCursor"]
        .as_str()
        .expect("more consented/system roles exist after page 1")
        .to_owned();
    // Mutate unconsented S2 by adding another owned role before requesting page 2.
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0x5A, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "create_ability",
        json!({
            "kind": "role",
            "name": "s2-extra-unconsented-role",
            "description": "Extra unconsented role",
            "instructions": "Unconsented body.",
            "placement": { "home": "space", "space": s2.slug },
        }),
    )
    .await
    .unwrap();
    let page2 = local
        .registry
        .call_tool(
            mk_ctx(2),
            "list_abilities",
            json!({ "view": "authoring", "kind": "role", "limit": 1, "cursor": next_cursor }),
        )
        .await
        .expect("mutating unconsented S2 must not invalidate InAppProvider list_abilities cursor")
        .structured_content;
    assert_eq!(page2["items"].as_array().unwrap().len(), 1);
    assert_ne!(page2["items"][0]["ref"], page1["items"][0]["ref"]);

    // Drain ALL remaining pages of InAppProvider list_abilities(kind="role", limit=1)
    // and verify (a) both system roles `grooming` and `research` appear with zero
    // duplicates and (b) unconsented S2 roles NEVER appear on any page.
    let mut role_names = vec![
        page1["items"][0]["name"].as_str().unwrap().to_owned(),
        page2["items"][0]["name"].as_str().unwrap().to_owned(),
    ];
    let mut role_refs = vec![
        page1["items"][0]["ref"].as_str().unwrap().to_owned(),
        page2["items"][0]["ref"].as_str().unwrap().to_owned(),
    ];
    let mut cursor = page2["nextCursor"].as_str().map(ToOwned::to_owned);
    let mut step_tag = 3u8;
    while let Some(next) = cursor {
        let p = local
            .registry
            .call_tool(
                mk_ctx(step_tag),
                "list_abilities",
                json!({ "view": "authoring", "kind": "role", "limit": 1, "cursor": next }),
            )
            .await
            .unwrap()
            .structured_content;
        step_tag += 1;
        let items = p["items"].as_array().unwrap();
        assert!(
            !items.is_empty(),
            "provider pagination must never emit empty page: {p}"
        );
        for item in items {
            role_names.push(item["name"].as_str().unwrap().to_owned());
            role_refs.push(item["ref"].as_str().unwrap().to_owned());
        }
        cursor = p["nextCursor"].as_str().map(ToOwned::to_owned);
    }
    let unique_refs: std::collections::BTreeSet<&str> =
        role_refs.iter().map(String::as_str).collect();
    assert_eq!(
        unique_refs.len(),
        role_refs.len(),
        "InAppProvider list_abilities pagination must never emit duplicate refs: {role_names:?}"
    );
    assert!(
        role_names.iter().any(|n| n == "grooming") && role_names.iter().any(|n| n == "research"),
        "all built-in system roles must remain reachable across limit=1 pages: {role_names:?}"
    );
    assert!(
        !role_names.iter().any(|n| n == "s2-extra-unconsented-role"),
        "unconsented S2 roles must never leak into InAppProvider list_abilities: {role_names:?}"
    );

    // Also verify source="system", limit=3 pagination returns all 4 built-in system
    // abilities without duplicating research/research-evidence or dropping grooming-evidence.
    let mut sys_names = Vec::new();
    let mut sys_cursor: Option<String> = None;
    loop {
        let mut args = json!({ "view": "runtime", "source": "system", "limit": 3 });
        if let Some(c) = &sys_cursor {
            args["cursor"] = json!(c);
        }
        let p = local
            .registry
            .call_tool(mk_ctx(step_tag), "list_abilities", args)
            .await
            .unwrap()
            .structured_content;
        step_tag += 1;
        for item in p["items"].as_array().unwrap() {
            sys_names.push(item["name"].as_str().unwrap().to_owned());
        }
        sys_cursor = p["nextCursor"].as_str().map(ToOwned::to_owned);
        if sys_cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        sys_names.len(),
        4,
        "must yield all 4 system builtins without duplicates: {sys_names:?}"
    );
    for expected in [
        "grooming",
        "grooming-evidence",
        "research",
        "research-evidence",
    ] {
        assert!(
            sys_names.iter().any(|n| n == expected),
            "missing system builtin {expected} in {sys_names:?}"
        );
    }

    // (4) Unconsented Spaces must NOT shadow consented Personal/Space roles or
    //     create InvalidState ambiguity oracles in InAppProvider use_role, nor
    //     allow bind_chat_role to durably poison a Personal thread's episode.
    let s3 = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: acc_id(0x30).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x5A, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
                    kind: SpaceKind::Shared,
                    name: "Unconsented S3".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let mut s2_shadow_ref = String::new();
    for (tag, name, placement, instructions) in [
        (
            0x31u8,
            "shared-shadow-role",
            json!({ "home": "personal" }),
            "PERSONAL-SHADOW-WINNER-MARKER",
        ),
        (
            0x32u8,
            "shared-shadow-role",
            json!({ "home": "space", "space": s2.slug }),
            "S2-UNCONSENTED-SHADOW-MARKER",
        ),
        (
            0x33u8,
            "dual-unconsented-role",
            json!({ "home": "space", "space": s2.slug }),
            "S2-DUAL-UNCONSENTED",
        ),
        (
            0x34u8,
            "dual-unconsented-role",
            json!({ "home": "space", "space": s3.slug }),
            "S3-DUAL-UNCONSENTED",
        ),
    ] {
        let created = call_mcp(
            &fixture.registry,
            &owner,
            [0x5A, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
            "create_ability",
            json!({
                "kind": "role",
                "name": name,
                "description": "Shadowing and oracle isolation test",
                "instructions": instructions,
                "placement": placement,
            }),
        )
        .await
        .unwrap()
        .structured_content;
        if tag == 0x32 {
            s2_shadow_ref = created["ref"].as_str().unwrap().to_owned();
        }
    }
    let run_auth2 = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0x5A, 0x35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_acc2 = AccountContext::new(run_auth2, budget());
    let mk_ctx2 = |tag: u8| McpInvocationContext {
        account: run_acc2.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x5A, 0x36, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };
    // Personal role wins despite unconsented S2 defining the same name.
    let personal_win = local
        .registry
        .call_tool(
            mk_ctx2(1),
            "use_role",
            json!({ "role": "shared-shadow-role" }),
        )
        .await
        .expect("unconsented S2 role must not shadow consented Personal role")
        .structured_content;
    assert!(
        personal_win["instructions"]
            .as_str()
            .unwrap()
            .contains("PERSONAL-SHADOW-WINNER-MARKER")
    );
    // Consented S1 role wins despite unconsented S2 defining the same name.
    let s1_win = local
        .registry
        .call_tool(mk_ctx2(2), "use_role", json!({ "role": "group-reviewer" }))
        .await
        .expect("unconsented S2 role must not DoS consented S1 role with InvalidState")
        .structured_content;
    assert!(
        s1_win["instructions"]
            .as_str()
            .unwrap()
            .contains("S1-GROUP-REVIEWER-MARKER")
    );
    // Duplicate name across two unconsented Spaces collapses uniformly to ResourceNotFound.
    let oracle_err = local
        .registry
        .call_tool(
            mk_ctx2(3),
            "use_role",
            json!({ "role": "dual-unconsented-role" }),
        )
        .await;
    assert!(
        matches!(
            oracle_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "duplicate name across unconsented S2 & S3 must collapse to ResourceNotFound (not InvalidState), got {:?}",
        oracle_err.as_ref().err()
    );

    // bind_chat_role on a Personal chat must preflight-reject an unconsented S2
    // role (by exact ar1: ref) WITHOUT poisoning the episode for role=None turns.
    let p_thread = ChatThreadId::from_bytes([0x5A, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_cmd = |sub: u8| CommandIdentity {
        scope: pscope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([0x5A, 0x40, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
        hash: ContentDigest::from_bytes([0x5A; 32]),
    };
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: p_cmd(1),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: p_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Personal role egress preflight".into(),
                },
            },
        )
        .await
        .unwrap();
    let p_msg = fixture
        .canonical
        .append_chat(
            personal.clone(),
            Mutation {
                identity: p_cmd(2),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: p_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Try unconsented S2 role".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: pscope.clone(),
                thread: p_thread.clone(),
                expected_leaf: p_msg.value.seq,
                options: base_opts(Some(&s2_shadow_ref)),
            },
        )
        .await
        .unwrap();
    let p_leaf_after_err = idle_leaf(fixture, personal, &p_thread).await;
    assert_eq!(
        p_leaf_after_err, p_msg.value.seq,
        "unconsented S2 role ref must fail before completion without appending"
    );
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: pscope.clone(),
                thread: p_thread.clone(),
                expected_leaf: p_msg.value.seq,
                options: base_opts(None),
            },
        )
        .await
        .unwrap();
    let (mut wire3, _) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("Personal thread episode must not be poisoned after unconsented S2 role rejection");
    send_ollama(
        &mut wire3,
        json!({"role": "assistant", "content": "Personal episode unpoisoned."}),
        "stop",
    )
    .await;
    let _ = idle_leaf(fixture, personal, &p_thread).await;
}

#[inline(never)]
async fn staged_taint_list_notes_cursor_and_proposal_preflight_probes(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0x9A, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0x9A; 32]),
            }
        }
    };
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: acc_id(1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x9A, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Staged Taint Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let p1 = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0x9A, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "consented-p1",
    )
    .await;
    let p2 = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0x9A, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
        "unconsented-p2",
    )
    .await;
    let active_epoch = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    for (idx, (parent, slug)) in [
        (p1.folder_id.clone(), "child-a"),
        (p1.folder_id.clone(), "child-b"),
        (p2.folder_id.clone(), "p2-sub"),
    ]
    .into_iter()
    .enumerate()
    {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: shared.history.clone(),
                active_epoch,
                folder_id: FolderId::from_bytes([
                    0x9A,
                    10 + idx as u8,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    10 + idx as u8,
                ]),
                parent: Some(parent),
                slug: slug.into(),
                display_name: slug.into(),
                is_project: false,
                project_slug: None,
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let n1 = NoteId::from_bytes([0x9A, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20]);
    fixture
        .canonical
        .create_note(
            SpaceContext::new(owner.auth().clone(), shared.history.clone(), budget()).unwrap(),
            Mutation {
                identity: CommandIdentity {
                    scope: shared.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x9A, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20,
                    ]),
                    hash: ContentDigest::from_bytes([0x9A; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: n1.clone(),
                    parent: Some(p1.folder_id.clone()),
                    slug: "p1-note".into(),
                    class: DocClass::UserDoc,
                    carrier: "# P1 Note\n\nKnown body text.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: shared.history.space_id.clone(),
            note_id: n1.clone(),
        },
        notes: vec![n1.clone()],
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x9B, true).await;
    // Consent ONLY Project P1 (NOT P2) in `shared`, plus Personal space.
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x34,
        ProviderAttachmentTarget::Project(p1.clone()),
        [DocClass::UserDoc].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0x35,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: shared.history.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &local,
        0xDB,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;

    let make_run = |tag: u8| {
        let auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0x9A, 0x30, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let acc = AccountContext::new(auth.clone(), budget());
        (auth, acc)
    };
    let make_ctx = |acc: &AccountContext, tag: u8| McpInvocationContext {
        account: acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0x9A, 0x31, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };

    // (1) list_notes stale cursor rejected in engine.list_child_folders must NOT
    //     flip BranchTaint on a fresh untainted AgentRun handle, while the
    //     succeeding cross-Space page 1 call MUST commit staged taint.
    //     With 1 note + 2 child folders and limit=1, page 1 opens `folders_cut`
    //     (leaving `child-b` for page 2).
    let (open_auth, open_acc) = make_run(1);
    let p1_handle = format!("{}/consented-p1", shared.slug);
    let opened = local
        .registry
        .call_tool(
            make_ctx(&open_acc, 1),
            "list_notes",
            json!({ "project": p1_handle, "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        open_auth.taint().is_tainted(),
        "succeeding cross-Space list_notes MUST commit staged BranchTaint"
    );
    let valid_cursor = opened["nextCursor"]
        .as_str()
        .expect("1 note + 2 child folders at limit=1 must produce folder continuation nextCursor")
        .to_owned();
    // Create a 3rd sibling child folder under p1 to invalidate `folders_cut`.
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: shared.history.clone(),
            active_epoch,
            folder_id: FolderId::from_bytes([0x9A, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15]),
            parent: Some(p1.folder_id.clone()),
            slug: "child-c".into(),
            display_name: "child-c".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    // Fresh untainted auth handle for the same AgentRunId so cursor fingerprint
    // matches and execution reaches `folder_metadata` + `list_child_folders`.
    let (stale_auth, stale_acc) = make_run(1);
    let stale_err = local
        .registry
        .call_tool(
            make_ctx(&stale_acc, 2),
            "list_notes",
            json!({ "project": p1_handle, "limit": 1, "cursor": valid_cursor }),
        )
        .await;
    assert!(
        matches!(
            &stale_err,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale
        ),
        "mutated folder cursor must fail with CursorStale, got {:?}",
        stale_err.as_ref().err()
    );
    assert!(
        !stale_auth.taint().is_tainted(),
        "list_notes failing mid-call with CursorStale must not flip BranchTaint"
    );

    // (2) proposals::prepare must reject invalid arguments and unconsented MoveNote
    //     destinations BEFORE flipping BranchTaint, while valid FindReplace probes
    //     that fail NoMatch MUST still flip BranchTaint (positive control).
    let thread = ChatThreadId::from_bytes([0x9A, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x9A, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0x9A; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Proposal preflight thread".into(),
                },
            },
        )
        .await
        .unwrap();
    let (prop_auth, prop_acc) = make_run(3);
    let prop_run_id = match prop_auth.kind() {
        notarium_core::auth::PrincipalKind::AgentRun(id) => id.clone(),
        _ => unreachable!(),
    };
    let prop_scope = SpaceContext::new(prop_auth.clone(), pscope.clone(), budget()).unwrap();
    fixture
        .canonical
        .claim_active_run(
            prop_scope.clone(),
            ClaimChatRun {
                thread: thread.clone(),
                run: prop_run_id,
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    let model_entry = fixture
        .canonical
        .append_chat(
            prop_scope,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0x9A, 0x40, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0x9A; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Propose note change.".into()),
                    tool_calls: vec![],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    let binding = PersonalToolInvocation {
        source: pscope.clone(),
        thread: thread.clone(),
        leaf: model_entry.value.seq,
        owner: owner.clone(),
    };
    for (idx, (tool, args, expect_not_found)) in [
        ("edit_note", json!({ "ref": n1 }), false),
        ("rename_note", json!({ "ref": n1, "title": "   " }), false),
        ("link", json!({ "from": n1, "relation": "relates" }), false),
        (
            "link",
            json!({ "from": n1, "to": n1, "relation": "relates" }),
            false,
        ),
        (
            "remember_about_project",
            json!({ "project": p1_handle, "observation": "   " }),
            false,
        ),
        (
            "remember_about_project",
            json!({ "project": p1_handle, "observation": "valid", "category": "INVALID_CAT" }),
            false,
        ),
        (
            "create_note",
            json!({
                "project": p1_handle,
                "title": "Oversized",
                "body": "x".repeat(notarium_core::ports::AppendChat::MAX_STRUCTURED_BODY_BYTES),
            }),
            false,
        ),
        (
            "create_note",
            json!({
                "project": p1_handle,
                "title": "Reserved Filename",
                "body": "ok",
                "fileName": "index.md",
                "links": [{ "relation": "relates", "to": n1 }],
            }),
            false,
        ),
        (
            "move_note",
            json!({ "ref": n1, "toFolder": "unconsented-p2/p2-sub" }),
            true,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let res = local
            .registry
            .call_personal_tool(
                make_ctx(&prop_acc, 10 + idx as u8),
                binding.clone(),
                tool,
                args,
            )
            .await;
        if expect_not_found {
            assert!(
                matches!(&res, Err(PortError::Domain(DomainError::ResourceNotFound))),
                "unconsented destination proposal {tool} must fail ResourceNotFound, got {:?}",
                res.as_ref().err()
            );
        } else {
            assert!(
                matches!(
                    &res,
                    Err(PortError::Domain(DomainError::ValidationFailed { .. }))
                ),
                "invalid proposal {tool} must fail ValidationFailed, got {:?}",
                res.as_ref().err()
            );
        }
        assert!(
            !prop_auth.taint().is_tainted(),
            "pre-probe rejected proposal {tool} must not flip BranchTaint"
        );
    }
    // Positive control: valid FindReplace probe that fails needle lookup
    // (`ResourceNotFound`) MUST flip BranchTaint even on failure.
    let probe_res = local
        .registry
        .call_personal_tool(
            make_ctx(&prop_acc, 20),
            binding.clone(),
            "edit_note",
            json!({
                "ref": n1,
                "operation": "findReplace",
                "find": "definitely-absent-secret-needle",
                "content": "replacement",
            }),
        )
        .await;
    assert!(
        matches!(
            &probe_res,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "absent FindReplace needle must reach content probing and fail ResourceNotFound, got {:?}",
        probe_res.as_ref().err()
    );
    assert!(
        prop_auth.taint().is_tainted(),
        "post-preflight FindReplace content probe MUST flip BranchTaint even on failure"
    );
    // And a matching FindReplace on the same thread/note succeeds as approvalRequired.
    let matched_prop = local
        .registry
        .call_personal_tool(
            make_ctx(&prop_acc, 21),
            binding,
            "edit_note",
            json!({
                "ref": n1,
                "operation": "findReplace",
                "find": "Known body text.",
                "content": "Updated body text.",
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        matched_prop.structured_content["outcome"],
        "approvalRequired"
    );

    // Paired positive controls on fresh untainted runs: consented MoveNote and
    // link-free CreateNote proposals MUST succeed (approvalRequired) and flip taint.
    for (sub, tool, args) in [
        (
            4u8,
            "move_note",
            json!({ "ref": n1, "toFolder": "consented-p1/child-a" }),
        ),
        (
            5u8,
            "create_note",
            json!({ "project": p1_handle, "title": "Link Free", "body": "Fresh note body." }),
        ),
    ] {
        let th =
            ChatThreadId::from_bytes([0x9A, 0x41, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]);
        fixture
            .canonical
            .create_chat(
                personal.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0x9A, 0x41, sub, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        hash: ContentDigest::from_bytes([0x9A; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: th.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: None,
                        title: format!("Positive proposal {tool}"),
                    },
                },
            )
            .await
            .unwrap();
        let (fresh_auth, fresh_acc) = make_run(sub);
        let run_id = match fresh_auth.kind() {
            notarium_core::auth::PrincipalKind::AgentRun(id) => id.clone(),
            _ => unreachable!(),
        };
        let sc = SpaceContext::new(fresh_auth.clone(), pscope.clone(), budget()).unwrap();
        fixture
            .canonical
            .claim_active_run(
                sc.clone(),
                ClaimChatRun {
                    thread: th.clone(),
                    run: run_id,
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap();
        let entry = fixture
            .canonical
            .append_chat(
                sc,
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0x9A, 0x41, sub, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        hash: ContentDigest::from_bytes([0x9A; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: th.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text("Positive control.".into()),
                        tool_calls: vec![],
                        provenance: Some(ChatProvenance::default()),
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: false,
                    },
                },
            )
            .await
            .unwrap();
        let ok = local
            .registry
            .call_personal_tool(
                make_ctx(&fresh_acc, 30 + sub),
                PersonalToolInvocation {
                    source: pscope.clone(),
                    thread: th,
                    leaf: entry.value.seq,
                    owner: owner.clone(),
                },
                tool,
                args,
            )
            .await
            .unwrap();
        assert_eq!(ok.structured_content["outcome"], "approvalRequired");
        assert!(
            fresh_auth.taint().is_tainted(),
            "accepted external proposal {tool} MUST commit BranchTaint"
        );
    }
}

#[inline(never)]
async fn confirmed_link_many_trashed_target_and_project_move_note_replays(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0x17, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0x17; 32]),
            }
        }
    };
    let shared = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: acc_id(1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Replay Seams Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let proj = create_project_folder(
        fixture,
        &shared.history,
        &actor,
        FolderId::from_bytes([0x17, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "replay-proj",
    )
    .await;
    let proj_handle = format!("{}/replay-proj", shared.slug);

    // Create source S and targets T1, T2 in `shared/replay-proj`.
    let mk_note = |tag: u8, title: &str| {
        let proj_handle = proj_handle.clone();
        let owner = owner.clone();
        let title = title.to_owned();
        async move {
            call_mcp(
                &fixture.registry,
                &owner,
                [0x17, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
                "create_note",
                json!({ "project": proj_handle, "title": title, "body": "Body." }),
            )
            .await
            .unwrap()
            .structured_content["noteId"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    };
    let src_id = mk_note(3, "Link Source").await;
    let t1_id = mk_note(4, "Link Target One").await;
    let t2_id = mk_note(5, "Link Target Two").await;

    // (1) Confirmed LinkMany proposal with 2 links on the same source note S:
    //     after confirming both and trashing T1, replaying apply_proposed_diff
    //     must return exact ok=true receipts for BOTH links (no idempotency_key_reused).
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x0E, true).await;
    for (sub, target) in [
        (
            1u8,
            ProviderAttachmentTarget::Space(shared.history.space_id.clone()),
        ),
        (
            2u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: shared.history.space_id.clone(),
            },
        ),
        (
            3u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: pscope.space_id.clone(),
            },
        ),
    ] {
        let consent = || {
            ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                classes: [DocClass::UserDoc].into(),
            })
        };
        let att = local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(40 + sub).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([
                            0x0E, 0x49, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
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
        if att.state != ProviderAttachmentState::Approved {
            local
                .provider
                .approve_attachment(
                    owner.clone(),
                    AccountMutation {
                        identity: acc_id(50 + sub).await,
                        input: ApproveProviderAttachment {
                            id: att.id,
                            expected: att.revision,
                            resource_consent_epoch: att.resource_consent_epoch,
                            credential_consent_epoch: att.credential_consent_epoch,
                            consent: consent(),
                        },
                    },
                )
                .await
                .unwrap();
        }
    }
    let thread = ChatThreadId::from_bytes([0x17, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10]);
    let p_cmd = |sub: u8| CommandIdentity {
        scope: pscope.clone(),
        actor: actor.clone(),
        key: CommandKey::from_bytes([0x17, 10, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
        hash: ContentDigest::from_bytes([0x17; 32]),
    };
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: p_cmd(1),
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "LinkMany replay thread".into(),
                },
            },
        )
        .await
        .unwrap();
    let run_id = AgentRunId::from_bytes([0x17, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11]);
    let run_auth = owner
        .auth()
        .for_agent_run(
            run_id.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_scope = SpaceContext::new(run_auth.clone(), pscope.clone(), budget()).unwrap();
    fixture
        .canonical
        .claim_active_run(
            run_scope.clone(),
            ClaimChatRun {
                thread: thread.clone(),
                run: run_id,
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    let link_args = json!({
        "links": [
            { "from": src_id, "to": t1_id, "relation": "relates" },
            { "from": src_id, "to": t2_id, "relation": "supports" },
        ]
    });
    let call_key = CommandKey::from_bytes([0x17, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12]);
    let model_entry = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: p_cmd(2),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Link both targets.".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(call_key.as_str().into()).unwrap(),
                        name: "link_many".into(),
                        arguments: link_args.as_object().unwrap().clone().into_iter().collect(),
                    }],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    let prop_res = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: call_key.clone(),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: thread.clone(),
                leaf: model_entry.value.seq,
                owner: owner.clone(),
            },
            "link_many",
            link_args,
        )
        .await
        .unwrap();
    let proposal = prop_res.proposal().expect("link_many proposal");
    let tool_entry = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: p_cmd(3),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: model_entry.value.seq,
                    kind: ChatEntryKind::Tool { call_id: call_key },
                    body: ChatInputBody::Text(prop_res.content[0].text.clone()),
                    tool_calls: vec![],
                    provenance: Some(prop_res.provenance.clone()),
                    interruption: None,
                    proposed_diff: Some(proposal.envelope().to_owned()),
                    proposed_effect: Some(proposal.effect()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    // Prepare a second, unconfirmed link_many proposal targeting T1 before T1 is trashed,
    // to prove as a paired negative control that a FIRST confirm after trash STILL fails.
    let fresh_link_args = json!({
        "links": [{ "from": src_id, "to": t1_id, "relation": "mentions" }]
    });
    let fresh_call_key =
        CommandKey::from_bytes([0x17, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
    let model_entry_2 = fixture
        .canonical
        .append_chat(
            run_scope.clone(),
            Mutation {
                identity: p_cmd(4),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: tool_entry.value.seq,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Link T1 fresh.".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(fresh_call_key.as_str().into()).unwrap(),
                        name: "link_many".into(),
                        arguments: fresh_link_args
                            .as_object()
                            .unwrap()
                            .clone()
                            .into_iter()
                            .collect(),
                    }],
                    provenance: Some(ChatProvenance::default()),
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    let fresh_prop_res = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: fresh_call_key.clone(),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: thread.clone(),
                leaf: model_entry_2.value.seq,
                owner: owner.clone(),
            },
            "link_many",
            fresh_link_args,
        )
        .await
        .unwrap();
    let fresh_proposal = fresh_prop_res.proposal().expect("fresh link_many proposal");
    let fresh_tool_entry = fixture
        .canonical
        .append_chat(
            run_scope,
            Mutation {
                identity: p_cmd(5),
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: thread.clone(),
                    parent: model_entry_2.value.seq,
                    kind: ChatEntryKind::Tool {
                        call_id: fresh_call_key,
                    },
                    body: ChatInputBody::Text(fresh_prop_res.content[0].text.clone()),
                    tool_calls: vec![],
                    provenance: Some(fresh_prop_res.provenance.clone()),
                    interruption: None,
                    proposed_diff: Some(fresh_proposal.envelope().to_owned()),
                    proposed_effect: Some(fresh_proposal.effect()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    let confirm = ConfirmProposedDiff {
        source: pscope.clone(),
        thread: thread.clone(),
        entry: tool_entry.value.seq,
        proposal: proposal.id(),
    };
    let confirm_fresh = ConfirmProposedDiff {
        source: pscope.clone(),
        thread,
        entry: fresh_tool_entry.value.seq,
        proposal: fresh_proposal.id(),
    };
    let applied = local
        .registry
        .apply_proposed_diff(owner.clone(), confirm.clone())
        .await
        .unwrap();
    assert_eq!(applied.result["results"][0]["ok"], true);
    assert_eq!(applied.result["results"][1]["ok"], true);
    assert_ne!(
        applied.result["results"][0]["versionToken"],
        applied.result["results"][1]["versionToken"]
    );
    // Trash target T1, then replay apply_proposed_diff.
    call_mcp(
        &fixture.registry,
        &owner,
        [0x17, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13],
        "delete_note",
        json!({ "ref": t1_id }),
    )
    .await
    .unwrap();
    let replayed = local
        .registry
        .apply_proposed_diff(owner.clone(), confirm)
        .await
        .unwrap();
    assert_eq!(
        replayed.result, applied.result,
        "replaying confirmed LinkMany after trashing T1 must preserve both committed receipts without idempotency_key_reused"
    );
    // Paired negative control: confirming a FRESH (never-applied) proposal targeting
    // trashed T1 must STILL fail via canonical authorize_link_target_tx.
    let fresh_applied = local
        .registry
        .apply_proposed_diff(owner.clone(), confirm_fresh)
        .await
        .unwrap();
    assert_eq!(
        fresh_applied.result["results"][0]["ok"], false,
        "fresh confirm against trashed target T1 must be rejected: {:?}",
        fresh_applied.result
    );
    assert_eq!(
        fresh_applied.result["results"][0]["error"],
        "resource_not_found"
    );

    // (2) Project-scoped move_note replay must survive a subsequent rename_project.
    let proj_auth = owner.auth().restrict_to_project(&proj).unwrap();
    let proj_acc = AccountContext::new(proj_auth, budget());
    let move_args = json!({ "ref": t2_id, "toFolder": "replay-proj/moved-sub" });
    let moved = call_mcp(
        &fixture.registry,
        &proj_acc,
        [0x17, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14],
        "move_note",
        move_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    call_mcp(
        &fixture.registry,
        &owner,
        [0x17, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15],
        "rename_project",
        json!({ "project": proj_handle, "slug": "replay-proj-renamed" }),
    )
    .await
    .unwrap();
    let replayed_move = call_mcp(
        &fixture.registry,
        &proj_acc,
        [0x17, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14],
        "move_note",
        move_args,
    )
    .await
    .expect("project-scoped move_note replay must survive rename_project via journaled destination")
    .structured_content;
    assert_eq!(replayed_move, moved);
}

#[inline(never)]
async fn runtime_skill_omission_project_only_shadowing_and_dedup_hygiene(
    fixture: &mut RuntimeFixture,
    personal: &SpaceContext,
) {
    {
        let fixture: &RuntimeFixture = &*fixture;
        let owner = fresh_owner(fixture).await;
        let actor = owner.auth().principal().clone();
        let pscope = personal.scope().clone();
        let acc_id = |sub: u8| {
            let owner = owner.clone();
            let actor = actor.clone();
            async move {
                let rev = fixture
                    .control
                    .account(owner, actor.clone())
                    .await
                    .unwrap()
                    .revision;
                AccountCommandIdentity {
                    owner: actor.clone(),
                    actor,
                    expected: rev,
                    key: CommandKey::from_bytes([
                        0xC1, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                    ]),
                    hash: ContentDigest::from_bytes([0xC1; 32]),
                }
            }
        };
        let mk_space = |sub: u8, name: &str| {
            let name = name.to_owned();
            async move {
                let owner = fresh_owner(fixture).await;
                fixture
                    .control
                    .create_space(
                        owner,
                        AccountMutation {
                            identity: acc_id(sub).await,
                            input: CreateSpace {
                                id: SpaceId::from_bytes([
                                    0xC1, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                                ]),
                                kind: SpaceKind::Shared,
                                name,
                            },
                        },
                    )
                    .await
                    .unwrap()
                    .value
            }
        };
        let s_uncons = mk_space(1, "Unconsented Skill Space").await;
        let s_po = mk_space(2, "Project Only Promo Space").await;
        let s_a = mk_space(3, "Unrelated Skill Space A").await;
        let s_b = mk_space(4, "UserDoc Only Space B").await;
        let owner = fresh_owner(fixture).await;

        let po_p1 = create_project_folder(
            fixture,
            &s_po.history,
            &actor,
            FolderId::from_bytes([0xC1, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10]),
            "po-p1",
        )
        .await;
        let po_p2 = create_project_folder(
            fixture,
            &s_po.history,
            &actor,
            FolderId::from_bytes([0xC1, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11]),
            "po-p2",
        )
        .await;
        let b_proj = create_project_folder(
            fixture,
            &s_b.history,
            &actor,
            FolderId::from_bytes([0xC1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12]),
            "b-udoc",
        )
        .await;

        // Publish skills for (1): one in unconsented s_uncons, one in consented Personal,
        // then attach BOTH to a Personal role.
        let uncons_skill = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20],
            "create_ability",
            json!({
                "kind": "skill",
                "name": "unconsented-attached-skill",
                "description": "Unconsented attached skill",
                "instructions": "UNCONSENTED-SKILL-MARKER",
                "placement": { "home": "space", "space": s_uncons.slug },
            }),
        )
        .await
        .unwrap()
        .structured_content["ref"]
            .as_str()
            .unwrap()
            .to_owned();
        let cons_skill = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21],
            "create_ability",
            json!({
                "kind": "skill",
                "name": "consented-attached-skill",
                "description": "Consented attached skill",
                "instructions": "CONSENTED-SKILL-MARKER",
                "placement": { "home": "personal" },
            }),
        )
        .await
        .unwrap()
        .structured_content["ref"]
            .as_str()
            .unwrap()
            .to_owned();
        let _ = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22],
            "create_ability",
            json!({
                "kind": "role",
                "name": "mixed-attach-role",
                "description": "Role with mixed consent skills",
                "instructions": "MIXED-ROLE-MARKER",
                "placement": { "home": "personal" },
                "attachments": [
                    { "ref": uncons_skill, "label": "unconsented" },
                    { "ref": cons_skill, "label": "consented" },
                ],
            }),
        )
        .await
        .unwrap();

        // Publish roles for (2): role authored in po_p2 then promoted to OwnedSpace(s_po),
        // alongside a same-named consented Personal role.
        let po_p2_handle = format!("{}/po-p2", s_po.slug);
        let po_p1_handle = format!("{}/po-p1", s_po.slug);
        let promo_created = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23],
            "create_ability",
            json!({
                "kind": "role",
                "name": "promo-shadow-role",
                "description": "Promoted from unconsented po_p2",
                "instructions": "PO-P2-PROMOTED-MARKER",
                "placement": { "home": "project", "project": po_p2_handle },
            }),
        )
        .await
        .unwrap()
        .structured_content;
        let _ = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24],
            "edit_ability",
            json!({
                "ref": promo_created["ref"],
                "versionToken": promo_created["versionToken"],
                "home": { "home": "space" },
            }),
        )
        .await
        .unwrap();
        let personal_promo_ref = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25],
            "create_ability",
            json!({
                "kind": "role",
                "name": "promo-shadow-role",
                "description": "Consented Personal fallback role",
                "instructions": "PERSONAL-PROMO-FALLBACK-MARKER",
                "placement": { "home": "personal" },
            }),
        )
        .await
        .unwrap()
        .structured_content["ref"]
            .as_str()
            .unwrap()
            .to_owned();

        // Publish roles for (3): Space A roles + Personal role, and (4): dedup hygiene role.
        for (tag, name, placement, instructions) in [
            (
                26u8,
                "space-a-exclusive",
                json!({ "home": "space", "space": s_a.slug }),
                "SPACE-A-EXCLUSIVE-MARKER",
            ),
            (
                27u8,
                "personal-not-shadowed",
                json!({ "home": "space", "space": s_a.slug }),
                "SPACE-A-SHADOW-MARKER",
            ),
            (
                28u8,
                "personal-not-shadowed",
                json!({ "home": "personal" }),
                "PERSONAL-NOT-SHADOWED-MARKER",
            ),
            (
                29u8,
                "secret-edit-ability-slug",
                json!({ "home": "project", "project": po_p2_handle }),
                "SECRET-SLUG-HYGIENE-BODY",
            ),
        ] {
            let created = call_mcp(
                &fixture.registry,
                &owner,
                [0xC1, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
                "create_ability",
                json!({
                    "kind": "role",
                    "name": name,
                    "description": "Seam regression role",
                    "instructions": instructions,
                    "placement": placement,
                }),
            )
            .await
            .unwrap()
            .structured_content;
            if tag == 29 {
                // Promote via edit_ability to exercise EditPlan journaling without persisting slug.
                let _ = call_mcp(
                    &fixture.registry,
                    &owner,
                    [0xC1, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30],
                    "edit_ability",
                    json!({
                        "ref": created["ref"],
                        "versionToken": created["versionToken"],
                        "home": { "home": "space" },
                    }),
                )
                .await
                .unwrap();
            }
        }

        // Exercise EpisodeRolePlan journaling via use_role on a named episode, then verify
        // control.mcp_dedup.safe_result contains neither EditPlan.slug nor Episode.name.
        let started_ep = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 31],
            "start_session",
            json!({ "session": { "name": "secret-episode-name" } }),
        )
        .await
        .unwrap()
        .structured_content;
        let ep_id = started_ep["session"]["id"].as_str().unwrap().to_owned();
        let _ = call_mcp(
            &fixture.registry,
            &owner,
            [0xC1, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32],
            "use_role",
            json!({ "role": "personal-not-shadowed", "session": ep_id }),
        )
        .await
        .unwrap();

        // Attach loopback provider with carefully separated consent policies:
        // - Personal: UserDoc + Skill
        // - s_po: ONLY Project(po_p1) with UserDoc + Skill (no Space consent, no po_p2)
        // - s_a: Space(s_a) with UserDoc + Skill
        // - s_b: Project(b_proj) with UserDoc ONLY (no Skill)
        // - s_uncons: NO consent at all
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = loopback_provider(fixture, &owner, &listener, 0xC2, true).await;
        let attach = |sub: u8, target: ProviderAttachmentTarget, classes: [DocClass; 2]| {
            let local = &local;
            let owner = owner.clone();
            async move {
                let consent = || {
                    ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: classes.into_iter().collect(),
                    })
                };
                let att = local
                    .provider
                    .request_attachment(
                        owner.clone(),
                        AccountMutation {
                            identity: acc_id(40 + sub).await,
                            input: RequestProviderAttachment {
                                id: RequestId::from_bytes([
                                    0xC2, 0x51, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                                ]),
                                expected: None,
                                resource: local.resource.id.clone(),
                                resource_consent_epoch: local.resource.consent_epoch,
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
                if att.state != ProviderAttachmentState::Approved {
                    local
                        .provider
                        .approve_attachment(
                            owner,
                            AccountMutation {
                                identity: acc_id(60 + sub).await,
                                input: ApproveProviderAttachment {
                                    id: att.id,
                                    expected: att.revision,
                                    resource_consent_epoch: att.resource_consent_epoch,
                                    credential_consent_epoch: att.credential_consent_epoch,
                                    consent: consent(),
                                },
                            },
                        )
                        .await
                        .unwrap();
                }
            }
        };
        attach(
            1,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: pscope.space_id.clone(),
            },
            [DocClass::UserDoc, DocClass::Skill],
        )
        .await;
        attach(
            2,
            ProviderAttachmentTarget::Project(po_p1.clone()),
            [DocClass::UserDoc, DocClass::Skill],
        )
        .await;
        attach(
            3,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s_po.history.space_id.clone(),
            },
            [DocClass::UserDoc, DocClass::Skill],
        )
        .await;
        attach(
            4,
            ProviderAttachmentTarget::Space(s_a.history.space_id.clone()),
            [DocClass::UserDoc, DocClass::Skill],
        )
        .await;
        attach(
            5,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s_a.history.space_id.clone(),
            },
            [DocClass::UserDoc, DocClass::Skill],
        )
        .await;
        attach(
            6,
            ProviderAttachmentTarget::Project(b_proj.clone()),
            [DocClass::UserDoc, DocClass::UserDoc],
        )
        .await;
        attach(
            7,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s_b.history.space_id.clone(),
            },
            [DocClass::UserDoc, DocClass::UserDoc],
        )
        .await;

        // (1) Interactive chat run with Personal role attaching BOTH consented Personal skill
        //     and unconsented s_uncons skill must omit the unconsented skill and succeed.
        let supervisor = AgentRunSupervisor::new_local(
            local.registry.clone(),
            fixture.revocations.clone(),
            ExclusiveDataRoot::attest_open_writer(),
        );
        let base_opts = |role: Option<&str>| ChatRunOptions {
            provider: Some(local.resource.id.clone()),
            model: Some(local.model.clone()),
            role: role.map(ToOwned::to_owned),
            limits: RunLimits {
                max_steps: 2,
                max_tokens: 16_000,
                timeout_ms: 15_000,
            },
        };
        let p_thread =
            ChatThreadId::from_bytes([0xC1, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let p_cmd = |sub: u8| CommandIdentity {
            scope: pscope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xC1, 80, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
            hash: ContentDigest::from_bytes([0xC1; 32]),
        };
        fixture
            .canonical
            .create_chat(
                personal.clone(),
                Mutation {
                    identity: p_cmd(1),
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: p_thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: None,
                        title: "Attached skill omission thread".into(),
                    },
                },
            )
            .await
            .unwrap();
        let msg1 = fixture
            .canonical
            .append_chat(
                personal.clone(),
                Mutation {
                    identity: p_cmd(2),
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: p_thread.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text("Run mixed skill role".into()),
                        tool_calls: vec![],
                        provenance: None,
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: false,
                    },
                },
            )
            .await
            .unwrap();
        supervisor
            .start(
                owner.clone(),
                StartChatRun {
                    scope: pscope.clone(),
                    thread: p_thread.clone(),
                    expected_leaf: msg1.value.seq,
                    options: base_opts(Some("mixed-attach-role")),
                },
            )
            .await
            .unwrap();
        let (mut wire1, req1) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect(
            "interactive run with unconsented attached skill must omit skill instead of poisoning",
        );
        let req1_text = req1.to_string();
        assert!(req1_text.contains("MIXED-ROLE-MARKER"));
        assert!(req1_text.contains("CONSENTED-SKILL-MARKER"));
        assert!(
            !req1_text.contains("UNCONSENTED-SKILL-MARKER"),
            "unconsented attached skill must never be disclosed to provider"
        );
        send_ollama(
            &mut wire1,
            json!({"role": "assistant", "content": "Mixed skill ok."}),
            "stop",
        )
        .await;
        let leaf1 = idle_leaf(fixture, personal, &p_thread).await;
        // Follow-up turn with role=None reloads bound role cleanly.
        supervisor
            .start(
                owner.clone(),
                StartChatRun {
                    scope: pscope.clone(),
                    thread: p_thread.clone(),
                    expected_leaf: leaf1,
                    options: base_opts(None),
                },
            )
            .await
            .unwrap();
        let (mut wire2, _) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .expect("subsequent turn with role=None must succeed without episode poisoning");
        send_ollama(
            &mut wire2,
            json!({"role": "assistant", "content": "Follow-up ok."}),
            "stop",
        )
        .await;
        let _ = idle_leaf(fixture, personal, &p_thread).await;

        // (2) InAppProvider list_abilities(view="runtime", project="s_po/po-p1") AND
        //     bind_chat_role on a po_p1-scoped Personal chat must resolve Personal's
        //     "promo-shadow-role" rather than being shadowed by s_po's role promoted from po_p2.
        let run_auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xC1, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let run_acc = AccountContext::new(run_auth, budget());
        let mk_ctx = |tag: u8, primary_project: Option<FolderRef>| McpInvocationContext {
            account: run_acc.clone(),
            target: EgressTarget::InAppProvider {
                provider: local.resource.id.clone(),
                model: local.model.clone(),
                primary_project,
            },
            request_key: CommandKey::from_bytes([
                0xC1, 91, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
            ]),
        };
        let listed_po = local
            .registry
            .call_tool(
                mk_ctx(1, None),
                "list_abilities",
                json!({ "view": "runtime", "kind": "role", "project": po_p1_handle, "limit": 50 }),
            )
            .await
            .unwrap()
            .structured_content;
        let po_items = listed_po["items"].as_array().unwrap();
        assert!(
            po_items
                .iter()
                .any(|item| item["ref"] == personal_promo_ref),
            "project_only promoted_from role from po_p2 must not shadow Personal promo-shadow-role in runtime list_abilities: {listed_po}"
        );
        // Start a Personal chat anchored in s_po/po_p1 requesting "promo-shadow-role":
        // bind_chat_role must skip the po_p2-promoted role and bind Personal's fallback role.
        let po_scope =
            SpaceContext::new(owner.auth().clone(), s_po.history.clone(), budget()).unwrap();
        let po_thread =
            ChatThreadId::from_bytes([0xC1, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let po_cmd = |sub: u8| CommandIdentity {
            scope: s_po.history.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xC1, 81, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]),
            hash: ContentDigest::from_bytes([0xC1; 32]),
        };
        fixture
            .canonical
            .create_chat(
                po_scope.clone(),
                Mutation {
                    identity: po_cmd(1),
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: po_thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: Some(po_p1.folder_id.clone()),
                        title: "Project-only promo role binding".into(),
                    },
                },
            )
            .await
            .unwrap();
        let po_msg = fixture
            .canonical
            .append_chat(
                po_scope.clone(),
                Mutation {
                    identity: po_cmd(2),
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: po_thread.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text("Use promo-shadow-role".into()),
                        tool_calls: vec![],
                        provenance: None,
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: false,
                    },
                },
            )
            .await
            .unwrap();
        // Verify `use_role(role: "promo-shadow-role", project: "s_po/po-p1")` from a
        // Personal-Space InAppProvider run bypasses the unconsented po_p2-promoted
        // OwnedSpace(s_po) ability and activates the Personal fallback cleanly.
        let used_fallback = local
            .registry
            .call_tool(
                mk_ctx(15, None),
                "use_role",
                json!({ "role": "promo-shadow-role", "project": po_p1_handle }),
            )
            .await
            .expect("use_role must bypass unconsented po_p2-promoted role and activate Personal fallback")
            .structured_content;
        assert!(
            used_fallback["instructions"]
                .as_str()
                .unwrap()
                .contains("PERSONAL-PROMO-FALLBACK-MARKER"),
            "expected Personal fallback instructions, got {used_fallback}"
        );
        // On a Shared Space chat in `s_po/po-p1`, `bind_chat_role` must reject BOTH the
        // unconsented po_p2-promoted role AND the cross-Space Personal role (which would
        // taint the Shared Space chat and fail `append_chat` with CrossSpaceTainted).
        let po_res = supervisor
            .start(
                owner.clone(),
                StartChatRun {
                    scope: s_po.history.clone(),
                    thread: po_thread.clone(),
                    expected_leaf: po_msg.value.seq,
                    options: base_opts(Some("promo-shadow-role")),
                },
            )
            .await;
        if let Ok(_run) = po_res {
            let leaf = idle_leaf(fixture, &po_scope, &po_thread).await;
            assert_eq!(
                leaf.get(),
                1,
                "shared chat must not bind unconsented promoted role or cross-space personal role"
            );
        }

        // (3) UserDoc-only project s_b/b-udoc must NEVER leak unrelated Shared Space A's
        //     abilities or let Space A shadow Personal abilities in runtime or authoring views.
        let b_handle = format!("{}/b-udoc", s_b.slug);
        for (tag, view) in [(2u8, "runtime"), (3u8, "authoring")] {
            let listed_b = local
                .registry
                .call_tool(
                    mk_ctx(tag, None),
                    "list_abilities",
                    json!({ "view": view, "kind": "role", "project": b_handle, "limit": 50 }),
                )
                .await
                .unwrap()
                .structured_content;
            let items = listed_b["items"].as_array().unwrap();
            assert!(
                !items.iter().any(|item| item["name"] == "space-a-exclusive"),
                "unrelated Shared Space A ability must not leak for UserDoc-only project {b_handle} in view={view}: {listed_b}"
            );
            if view == "runtime" {
                assert!(
                    items.iter().any(|item| {
                        item["name"] == "personal-not-shadowed"
                            && item["scope"].get("OwnedPersonal").is_some()
                    }),
                    "Personal ability must not be shadowed by unrelated Shared Space A for UserDoc-only project: {listed_b}"
                );
            }
        }
        let _ = po_p2;
    }
    let dedup_rows = fixture
        .storage
        .observer
        .count("SELECT COUNT(*) FROM mcp_dedup WHERE operation IN ('edit_ability', 'use_role')")
        .await;
    assert!(
        dedup_rows >= 2,
        "expected mcp_dedup journal rows for edit_ability and use_role before negative leak check, got {dedup_rows}"
    );
    let leaked_dedup = fixture
        .storage
        .observer
        .count(
            "SELECT COUNT(*) FROM mcp_dedup \
             WHERE safe_result LIKE '%secret-edit-ability-slug%' \
                OR safe_result LIKE '%secret-episode-name%'",
        )
        .await;
    assert_eq!(
        leaked_dedup, 0,
        "mcp_dedup.safe_result must not persist EditPlan.slug or EpisodeRolePlan episode name"
    );
}

#[inline(never)]
async fn locate_ability_cap_and_legacy_mixed_case_id_pagination_parity(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0xC3, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0xC3; 32]),
            }
        }
    };
    let mut spaces = Vec::new();
    for idx in 1u8..=3 {
        let sp = fixture
            .control
            .create_space(
                fresh_owner(fixture).await,
                AccountMutation {
                    identity: acc_id(idx).await,
                    input: CreateSpace {
                        id: SpaceId::from_bytes([
                            0xC3, idx, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx,
                        ]),
                        kind: SpaceKind::Shared,
                        name: format!("Locate Cap Space {idx}"),
                    },
                },
            )
            .await
            .unwrap()
            .value;
        spaces.push(sp);
    }
    let owner = fresh_owner(fixture).await;

    // (1) Publish the SAME raw AbilityId across 3 Spaces (L1 < L2 < L3), disable
    //     L1 and L2 bindings, and verify raw-id use_role and get_ability resolve L3.
    let shared_ab_id =
        AbilityId::from_bytes([0xC3, 0xAB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let mut published_refs = Vec::new();
    for (idx, sp) in spaces.iter().enumerate() {
        let tag = 10 + idx as u8;
        let sc = SpaceContext::new(owner.auth().clone(), sp.history.clone(), budget()).unwrap();
        let note_id = NoteId::from_bytes([0xC3, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]);
        let note_rev = fixture
            .canonical
            .create_note(
                sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: sp.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xC3, tag, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
                        ]),
                        hash: ContentDigest::from_bytes([0xC3; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note_id.clone(),
                        parent: None,
                        slug: format!("locate-cap-role-{idx}"),
                        class: DocClass::Skill,
                        carrier: format!(
                            "---\nclass: skill\nkind: role\ntitle: locate-cap-role-{idx}\ndescription: Locate cap {idx}\n---\n\nLOCATE-CAP-MARKER-{idx}\n"
                        ),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap()
            .value
            .revision;
        let pkg = fixture
            .canonical
            .publish_ability_package(
                sc,
                Mutation {
                    identity: CommandIdentity {
                        scope: sp.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xC3, tag, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
                        ]),
                        hash: ContentDigest::from_bytes([0xC3; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: PublishAbilityPackage {
                        ability: shared_ab_id.clone(),
                        kind: AbilityKind::Role,
                        entrypoint: note_id,
                        files: vec![],
                        attached_skills: vec![],
                        expected_package_revision: None,
                        expected_entrypoint_revision: Some(note_rev),
                        requires_explicit_binding: false,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        published_refs.push(AbilityRef {
            id: shared_ab_id.clone(),
            placement: AbilityPlacement::OwnedSpace(sp.history.space_id.clone()),
            revision: pkg.revision,
        });
    }
    // Disable L1 and L2 bindings so only L3 is visible to InAppProvider.
    for (idx, ability) in published_refs.iter().enumerate().take(2) {
        fixture
            .control
            .update_ability_binding(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(20 + idx as u8).await,
                    input: AbilityBindingUpdate {
                        ability: ability.clone(),
                        enabled: false,
                        projects: AbilityProjects::All,
                        expected: AbilityOverlayGuard::Authored(None),
                    },
                },
            )
            .await
            .unwrap();
    }

    // (2) Legacy mixed-case IDs in L3 alongside v1 lowercase IDs for abilities,
    //     folders, and notes (verifying PostgreSQL COLLATE "C" matches Rust Ord).
    let l3 = &spaces[2];
    let l3_sc = SpaceContext::new(owner.auth().clone(), l3.history.clone(), budget()).unwrap();
    let legacy_ab_id = AbilityId::parse("ZZ0000000003").unwrap();
    let legacy_ab_note = NoteId::parse("ZZ0000000004").unwrap();
    let leg_rev = fixture
        .canonical
        .create_note(
            l3_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: l3.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xC3, 30, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    hash: ContentDigest::from_bytes([0xC3; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: legacy_ab_note.clone(),
                    parent: None,
                    slug: "legacy-id-role".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\nkind: role\ntitle: legacy-id-role\ndescription: Legacy ID role\n---\n\nLEGACY-ID-ROLE-BODY\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value
        .revision;
    let _ = fixture
        .canonical
        .publish_ability_package(
            l3_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: l3.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xC3, 30, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xC3; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: legacy_ab_id.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: legacy_ab_note,
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(leg_rev),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap();
    let l3_proj = create_project_folder(
        fixture,
        &l3.history,
        &actor,
        FolderId::from_bytes([0xC3, 31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "collate-proj",
    )
    .await;
    let active_epoch = fixture
        .canonical
        .read_space(&l3.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let legacy_folder_id = FolderId::parse("ZZ0000000001").unwrap();
    let v1_folder_id = FolderId::from_bytes([0xC3, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    for (fid, slug) in [(&legacy_folder_id, "legacy-sub"), (&v1_folder_id, "v1-sub")] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: l3.history.clone(),
                active_epoch,
                folder_id: fid.clone(),
                parent: Some(l3_proj.folder_id.clone()),
                slug: slug.into(),
                display_name: slug.into(),
                is_project: false,
                project_slug: None,
                actor: actor.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let legacy_note_id = NoteId::parse("ZZ0000000002").unwrap();
    let v1_note_id = NoteId::from_bytes([0xC3, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    for (idx, nid) in [&legacy_note_id, &v1_note_id].into_iter().enumerate() {
        fixture
            .canonical
            .create_note(
                l3_sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: l3.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xC3, 33, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx as u8,
                        ]),
                        hash: ContentDigest::from_bytes([0xC3; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: nid.clone(),
                        parent: Some(l3_proj.folder_id.clone()),
                        slug: format!("collate-note-{idx}"),
                        class: DocClass::UserDoc,
                        carrier: format!("# Collate Note {idx}\n\nBody.\n"),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
    }
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: l3.history.space_id.clone(),
            note_id: legacy_note_id.clone(),
        },
        notes: vec![legacy_note_id.clone(), v1_note_id.clone()],
    });

    // Consent Personal + L1 + L2 + L3 for UserDoc + Skill.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x68, true).await;
    let mut targets = vec![ProviderAttachmentTarget::Personal {
        owner: actor.clone(),
        space: pscope.space_id.clone(),
    }];
    for sp in &spaces {
        targets.push(ProviderAttachmentTarget::Space(sp.history.space_id.clone()));
        targets.push(ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: sp.history.space_id.clone(),
        });
    }
    for (sub, target) in targets.into_iter().enumerate() {
        let sub = sub as u8;
        let consent = || {
            ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                classes: [DocClass::UserDoc, DocClass::Skill].into(),
            })
        };
        let att = local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(40 + sub).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([
                            0x68, 0x51, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
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
        if att.state != ProviderAttachmentState::Approved {
            local
                .provider
                .approve_attachment(
                    owner.clone(),
                    AccountMutation {
                        identity: acc_id(60 + sub).await,
                        input: ApproveProviderAttachment {
                            id: att.id,
                            expected: att.revision,
                            resource_consent_epoch: att.resource_consent_epoch,
                            credential_consent_epoch: att.credential_consent_epoch,
                            consent: consent(),
                        },
                    },
                )
                .await
                .unwrap();
        }
    }

    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xC3, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_acc = AccountContext::new(run_auth, budget());
    let mk_ctx = |tag: u8| McpInvocationContext {
        account: run_acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0xC3, 91, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };

    // Raw AbilityId lookup via BOTH use_role and get_ability must find L3 despite L1 & L2.
    let used = local
        .registry
        .call_tool(
            mk_ctx(1),
            "use_role",
            json!({ "role": shared_ab_id.as_str() }),
        )
        .await
        .expect("raw AbilityId use_role must not be starved by 2 disabled Spaces sorting before L3")
        .structured_content;
    assert!(
        used["instructions"]
            .as_str()
            .unwrap()
            .contains("LOCATE-CAP-MARKER-2")
    );
    let got = local
        .registry
        .call_tool(
            mk_ctx(2),
            "get_ability",
            json!({ "ref": shared_ab_id.as_str() }),
        )
        .await
        .expect(
            "raw AbilityId get_ability must not be starved by 2 disabled Spaces sorting before L3",
        )
        .structured_content;
    assert!(
        got["instructions"]
            .as_str()
            .unwrap()
            .contains("LOCATE-CAP-MARKER-2")
    );

    // Drain ALL pages of InAppProvider list_abilities(limit=1) -> must include BOTH
    // legacy mixed-case `ZZ0000000003` ("legacy-id-role") and `ab_...` ("locate-cap-role-2").
    let mut ab_names = Vec::new();
    let mut ab_cursor: Option<String> = None;
    let mut tag = 10u8;
    loop {
        let mut args = json!({ "view": "authoring", "kind": "role", "limit": 1 });
        if let Some(c) = &ab_cursor {
            args["cursor"] = json!(c);
        }
        let page = local
            .registry
            .call_tool(mk_ctx(tag), "list_abilities", args)
            .await
            .unwrap()
            .structured_content;
        tag += 1;
        for item in page["items"].as_array().unwrap() {
            ab_names.push(item["name"].as_str().unwrap().to_owned());
        }
        ab_cursor = page["nextCursor"].as_str().map(ToOwned::to_owned);
        if ab_cursor.is_none() {
            break;
        }
    }
    assert!(
        ab_names.iter().any(|n| n == "legacy-id-role")
            && ab_names.iter().any(|n| n == "locate-cap-role-2"),
        "legacy mixed-case AbilityId pagination must yield both legacy and v1 abilities without drop: {ab_names:?}"
    );

    // Drain ALL pages of list_notes(project="l3/collate-proj", limit=1) -> must yield
    // both `legacy-sub` ("ZZ0000000001") and `v1-sub` without InvalidState.
    let l3_proj_handle = format!("{}/collate-proj", l3.slug);
    let mut folder_raw = Vec::new();
    let mut note_cursor: Option<String> = None;
    loop {
        let mut args = json!({ "project": l3_proj_handle, "limit": 1 });
        if let Some(c) = &note_cursor {
            args["cursor"] = json!(c);
        }
        let page = local
            .registry
            .call_tool(mk_ctx(tag), "list_notes", args)
            .await
            .expect("legacy mixed-case child folder pagination must not fail InvalidState")
            .structured_content;
        tag += 1;
        for f in page["folders"].as_array().unwrap() {
            folder_raw.push(serde_json::to_string(f).unwrap());
        }
        note_cursor = page["nextCursor"].as_str().map(ToOwned::to_owned);
        if note_cursor.is_none() {
            break;
        }
    }
    assert!(
        folder_raw.iter().any(|s| s.contains("legacy-sub"))
            && folder_raw.iter().any(|s| s.contains("v1-sub")),
        "child folder pagination must yield both legacy and v1 folders: {folder_raw:?}"
    );

    // Also create legacy mixed-case + v1 ChatThreads in L3 and drain canonical
    // ChangeRead::Seed(limit=1), asserting strictly monotonic Rust Ord advancement
    // for BOTH NotesAfter and ThreadsAfter cursors (verifying PostgreSQL COLLATE "C").
    let legacy_thread_id = ChatThreadId::parse("ZZ0000000005").unwrap();
    let v1_thread_id =
        ChatThreadId::from_bytes([0xC3, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    let mut cutoff = SpaceSeq::ZERO;
    for (idx, tid) in [&legacy_thread_id, &v1_thread_id].into_iter().enumerate() {
        let committed = fixture
            .canonical
            .create_chat(
                l3_sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: l3.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xC3, 34, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx as u8,
                        ]),
                        hash: ContentDigest::from_bytes([0xC3; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: tid.clone(),
                        kind: ChatThreadKind::SpaceGroup,
                        owner: actor.clone(),
                        project_folder: None,
                        title: format!("Collate Thread {idx}"),
                    },
                },
            )
            .await
            .unwrap();
        cutoff = cutoff.max(committed.receipt.seq());
    }
    let mut seed_cursor: Option<SeedCursor> = None;
    let mut seen_seed_notes = Vec::new();
    let mut seen_seed_threads = Vec::new();
    for _ in 0..32 {
        let req = match &seed_cursor {
            None => ChangeRead::Seed {
                scope: l3.history.clone(),
                cutoff: Some(cutoff),
                limit: PageLimit::new(1).unwrap(),
            },
            Some(cursor) => ChangeRead::ContinueSeed {
                cursor: cursor.clone(),
            },
        };
        let res = fixture
            .canonical
            .read_changes(l3_sc.clone(), req)
            .await
            .unwrap();
        let ChangeReadResult::Seed(page) = res else {
            panic!("expected Seed page");
        };
        for note in &page.notes {
            seen_seed_notes.push(note.document.reference().note_id.clone());
        }
        for thread in &page.threads {
            seen_seed_threads.push(thread.id.clone());
        }
        if let (Some(prev), Some(next)) = (&seed_cursor, &page.next) {
            match (&prev.after, &next.after) {
                (SeedPosition::NotesAfter(old), SeedPosition::NotesAfter(new)) => {
                    assert!(
                        new > old,
                        "NotesAfter must strictly increase in Rust byte order: old={old}, new={new}"
                    );
                }
                (SeedPosition::ThreadsAfter(old), SeedPosition::ThreadsAfter(new)) => {
                    assert!(
                        new > old,
                        "ThreadsAfter must strictly increase in Rust byte order: old={old}, new={new}"
                    );
                }
                _ => (),
            }
        }
        match page.next {
            Some(next) => seed_cursor = Some(next),
            None => break,
        }
    }
    assert!(
        seen_seed_notes.contains(&legacy_note_id) && seen_seed_notes.contains(&v1_note_id),
        "Seed pagination must yield both legacy and v1 NoteIds in byte order: {seen_seed_notes:?}"
    );
    assert!(
        seen_seed_threads.contains(&legacy_thread_id) && seen_seed_threads.contains(&v1_thread_id),
        "Seed pagination must yield both legacy and v1 ChatThreadIds in byte order: {seen_seed_threads:?}"
    );
}

#[inline(never)]
async fn schedule_provider_replay_shared_chat_and_post_trash_seams(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0xD1, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0xD1; 32]),
            }
        }
    };

    // Create two Shared Spaces `s1` (projects p1, p2, plus legacy mixed-case project)
    // and `s2` (projects s2_p1, s2_p2 with project-only attachments, no Space attachment).
    let s1 = fixture
        .control
        .create_space(
            fresh_owner(fixture).await,
            AccountMutation {
                identity: acc_id(1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Seam Hardening Shared One".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let s2 = fixture
        .control
        .create_space(
            fresh_owner(fixture).await,
            AccountMutation {
                identity: acc_id(2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    kind: SpaceKind::Shared,
                    name: "Seam Hardening Shared Two".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let s1_p1 = create_project_folder(
        fixture,
        &s1.history,
        &actor,
        FolderId::from_bytes([0xD1, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "seam-p1",
    )
    .await;
    let s1_p2 = create_project_folder(
        fixture,
        &s1.history,
        &actor,
        FolderId::from_bytes([0xD1, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "seam-p2",
    )
    .await;
    let legacy_proj_id = FolderId::parse("ZZ0000000006").unwrap();
    let _legacy_proj = create_project_folder(
        fixture,
        &s1.history,
        &actor,
        legacy_proj_id.clone(),
        "seam-legacy-proj",
    )
    .await;
    let s2_p1 = create_project_folder(
        fixture,
        &s2.history,
        &actor,
        FolderId::from_bytes([0xD1, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "s2-proj-a",
    )
    .await;
    let s2_p2 = create_project_folder(
        fixture,
        &s2.history,
        &actor,
        FolderId::from_bytes([0xD1, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "s2-proj-b",
    )
    .await;
    let p_proj = create_project_folder(
        fixture,
        &pscope,
        &actor,
        FolderId::from_bytes([0xD1, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "personal-replay-proj",
    )
    .await;

    // (1) Legacy mixed-case project FolderId pagination parity (SQLite vs PG COLLATE "C").
    let s1_sc = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let mut proj_ids = Vec::new();
    let mut proj_cursor: Option<String> = None;
    for _ in 0..8 {
        let page = fixture
            .canonical
            .projects(
                s1_sc.clone(),
                ControlPageRequest::new(1, proj_cursor).unwrap(),
            )
            .await
            .unwrap();
        for p in page.items {
            proj_ids.push(p.folder.folder_id);
        }
        proj_cursor = page.continuation;
        if proj_cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        proj_ids.first(),
        Some(&legacy_proj_id),
        "legacy mixed-case project ID must sort first in bytewise order: {proj_ids:?}"
    );
    assert!(proj_ids.contains(&s1_p1.folder_id) && proj_ids.contains(&s1_p2.folder_id));

    // (2) Schedule mutation security: taint, project_root confinement on delete / pause_only,
    //     and pre-replay authorization checks.
    let s1_p2_handle = format!("{}/seam-p2", s1.slug);
    let sched_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "sched-p2-role",
            "description": "Schedule P2 role",
            "instructions": "Run P2 tasks.",
            "placement": { "home": "project", "project": s1_p2_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let sched_role_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: Some(s1_p2.clone()),
                kind: Some(AbilityKind::Role),
                name: Some("sched-p2-role".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .next()
        .unwrap()
        .descriptor
        .reference;
    let _ = sched_role;
    let schedule_id = ScheduleId::from_bytes([0xD1, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let next_slot = Timestamp::parse("2028-01-02T03:00:00Z").unwrap();
    let sched_def = ScheduleDefinition {
        space: s1.history.space_id.clone(),
        project: Some(s1_p2.clone()),
        title: "P2 Schedule".into(),
        init_prompt: "Check P2.".into(),
        cron: "0 0 3 * * Sun *".into(),
        timezone: "UTC".into(),
        approved_role: sched_role_ref,
        limits: RunLimits {
            max_steps: 3,
            max_tokens: 64_000,
            timeout_ms: 15_000,
        },
    };
    let create_sched_req = AccountMutation {
        identity: acc_id(42).await,
        input: CreateSchedule {
            id: schedule_id.clone(),
            definition: sched_def.clone(),
            approved_skills: vec![],
            next_slot,
            paused: false,
        },
    };
    let created_sched = fixture
        .control
        .create_schedule(owner.clone(), create_sched_req.clone())
        .await
        .unwrap();
    let owner_p1_only =
        AccountContext::new(owner.auth().restrict_to_project(&s1_p1).unwrap(), budget());
    let owner_tainted = fresh_owner(fixture).await;
    owner_tainted.auth().taint().mark_external_read();
    // Narrowed P1 DirectHuman cannot pause-only update or delete P2 schedule, nor replay create.
    assert!(matches!(
        fixture
            .control
            .update_schedule(
                owner_p1_only.clone(),
                AccountMutation {
                    identity: acc_id(43).await,
                    input: UpdateSchedule {
                        schedule: schedule_id.clone(),
                        expected: created_sched.value.revision,
                        definition: sched_def.clone(),
                        approved_skills: None,
                        next_slot: Some(next_slot),
                        paused: true,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .delete_schedule(
                owner_p1_only.clone(),
                AccountMutation {
                    identity: acc_id(44).await,
                    input: DeleteSchedule {
                        schedule: schedule_id.clone(),
                        expected: created_sched.value.revision,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .create_schedule(owner_p1_only.clone(), create_sched_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    // Tainted DirectHuman cannot delete or replay create.
    assert!(matches!(
        fixture
            .control
            .delete_schedule(
                owner_tainted.clone(),
                AccountMutation {
                    identity: acc_id(45).await,
                    input: DeleteSchedule {
                        schedule: schedule_id.clone(),
                        expected: created_sched.value.revision,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    assert!(matches!(
        fixture
            .control
            .create_schedule(owner_tainted.clone(), create_sched_req)
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    // Authorized owner deletes schedule -> authorized replay succeeds, narrowed/tainted replay fails.
    let del_req = AccountMutation {
        identity: acc_id(46).await,
        input: DeleteSchedule {
            schedule: schedule_id.clone(),
            expected: created_sched.value.revision,
        },
    };
    let del_commit = fixture
        .control
        .delete_schedule(owner.clone(), del_req.clone())
        .await
        .unwrap();
    let del_replay = fixture
        .control
        .delete_schedule(owner.clone(), del_req.clone())
        .await
        .unwrap();
    assert_eq!(del_replay.revision, del_commit.revision);
    assert!(matches!(
        fixture
            .control
            .delete_schedule(owner_p1_only, del_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .delete_schedule(owner_tainted, del_req)
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));

    // (3) ProviderService pre-replay authorization for Space-scoped attachments & preferences.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x6B, true).await;
    let consent_us = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: [DocClass::UserDoc, DocClass::Skill].into(),
        })
    };
    let req_att = AccountMutation {
        identity: acc_id(50).await,
        input: RequestProviderAttachment {
            id: RequestId::from_bytes([0x69, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            expected: None,
            resource: local.resource.id.clone(),
            resource_consent_epoch: local.resource.consent_epoch,
            credential_consent_epoch: None,
            target: ProviderAttachmentTarget::Space(s1.history.space_id.clone()),
            consent: consent_us(),
            expires_at_ms: None,
        },
    };
    let att_res = local
        .provider
        .request_attachment(owner.clone(), req_att.clone())
        .await
        .unwrap()
        .value;
    let app_att = AccountMutation {
        identity: acc_id(51).await,
        input: ApproveProviderAttachment {
            id: att_res.id.clone(),
            expected: att_res.revision,
            resource_consent_epoch: att_res.resource_consent_epoch,
            credential_consent_epoch: att_res.credential_consent_epoch,
            consent: consent_us(),
        },
    };
    local
        .provider
        .approve_attachment(owner.clone(), app_att.clone())
        .await
        .unwrap();
    let pref_req = AccountMutation {
        identity: acc_id(52).await,
        input: SetProviderPreference {
            scope: ProviderPreferenceScope::Space(s1.history.space_id.clone()),
            kind: PreferenceModelKind::Completion,
            resource: local.resource.id.clone(),
            model: local.model.clone(),
        },
    };
    local
        .provider
        .set_preference(owner.clone(), pref_req.clone())
        .await
        .unwrap();
    // Narrowed caller excluding s1 MUST fail AccessDenied before command.replay!
    let owner_no_s1 = AccountContext::new(
        owner
            .auth()
            .restrict_to_spaces(&[pscope.space_id.clone()].into()),
        budget(),
    );
    assert!(matches!(
        local
            .provider
            .request_attachment(owner_no_s1.clone(), req_att)
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .approve_attachment(owner_no_s1.clone(), app_att)
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local.provider.set_preference(owner_no_s1, pref_req).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // Attach personal space with ONLY UserDoc+Skill (NO AgentMemory!) for (4) + (5) + (6),
    // personal consent on s1, and project-only attachments on s2_p1 & s2_p2 (NO Space(s2)!).
    for (sub, target) in [
        (
            53u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: pscope.space_id.clone(),
            },
        ),
        (
            54u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s1.history.space_id.clone(),
            },
        ),
        (55u8, ProviderAttachmentTarget::Project(s2_p1.clone())),
        (56u8, ProviderAttachmentTarget::Project(s2_p2.clone())),
        (
            57u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s2.history.space_id.clone(),
            },
        ),
    ] {
        let a = local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(sub).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([
                            0x69, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
                        credential_consent_epoch: None,
                        target,
                        consent: consent_us(),
                        expires_at_ms: None,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        if a.state != ProviderAttachmentState::Approved {
            local
                .provider
                .approve_attachment(
                    owner.clone(),
                    AccountMutation {
                        identity: acc_id(sub + 20).await,
                        input: ApproveProviderAttachment {
                            id: a.id,
                            expected: a.revision,
                            resource_consent_epoch: a.resource_consent_epoch,
                            credential_consent_epoch: a.credential_consent_epoch,
                            consent: consent_us(),
                        },
                    },
                )
                .await
                .unwrap();
        }
    }

    // (4) remember_about_user without AgentMemory consent must return identical static
    //     outcome "recorded" on both first (create) and second (append) call.
    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xD1, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_acc = AccountContext::new(run_auth, budget());
    let mk_in_app = |tag: u8| McpInvocationContext {
        account: run_acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([
            0xD1, 91, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag,
        ]),
    };
    let mem_first = local
        .registry
        .call_tool(
            mk_in_app(1),
            "remember_about_user",
            json!({ "category": "unconsented-cat", "observation": "first entry" }),
        )
        .await
        .unwrap()
        .structured_content;
    let mem_second = local
        .registry
        .call_tool(
            mk_in_app(2),
            "remember_about_user",
            json!({ "category": "unconsented-cat", "observation": "second entry" }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_eq!(mem_first["outcome"], "recorded");
    assert_eq!(mem_second["outcome"], "recorded");
    assert!(mem_first.get("noteId").is_none() && mem_second.get("noteId").is_none());

    // (5) Shared Space Personal chat: cross-space Personal role rejected cleanly (no episode
    //     poisoning); Shared role attaching a Personal skill omits it cleanly and completes turn.
    //     Personal chat with role in s2/proj-a attaching skill in s2/proj-b (separate project_only
    //     consents, no Space(s2) consent) omits s2/proj-b skill cleanly and completes turn.
    let personal_only_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "personal-only-cross-role",
            "description": "Personal role",
            "instructions": "PERSONAL-ONLY-ROLE-BODY",
            "placement": { "home": "personal" },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _ = personal_only_role;
    let personal_skill = call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "personal-attached-skill",
            "description": "Personal skill",
            "instructions": "PERSONAL-CROSS-SKILL-SECRET",
            "placement": { "home": "personal" },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _shared_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 102, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "shared-with-personal-skill",
            "description": "Shared role with cross-space skill",
            "instructions": "SHARED-ROLE-LOCAL-MARKER",
            "placement": { "home": "space", "space": s1.slug },
            "attachments": [{ "ref": personal_skill["ref"] }],
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let s2_sc = SpaceContext::new(owner.auth().clone(), s2.history.clone(), budget()).unwrap();
    let mut s2_skill_refs = Vec::new();
    for (idx, (proj, slug, marker)) in [
        (&s2_p1, "s2-proj-a-skill", "S2-PROJ-A-SKILL-MARKER"),
        (&s2_p2, "s2-proj-b-skill", "S2-PROJ-B-CONFLICT-SECRET"),
    ]
    .into_iter()
    .enumerate()
    {
        let sub = (idx + 1) as u8;
        let note_id = NoteId::from_bytes([0xD1, 103, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]);
        let ab_id =
            AbilityId::from_bytes([0xD1, 103, sub, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub]);
        let note_rev = fixture
            .canonical
            .create_note(
                s2_sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: s2.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD1, 103, sub, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        hash: ContentDigest::from_bytes([0xD1; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note_id.clone(),
                        parent: Some(proj.folder_id.clone()),
                        slug: slug.into(),
                        class: DocClass::Skill,
                        carrier: format!(
                            "---\nname: {slug}\ndescription: {slug}\n---\n\n{marker}\n"
                        ),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap()
            .value
            .revision;
        let pkg = fixture
            .canonical
            .publish_ability_package(
                s2_sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: s2.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD1, 103, sub, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        hash: ContentDigest::from_bytes([0xD1; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: PublishAbilityPackage {
                        ability: ab_id.clone(),
                        kind: AbilityKind::Skill,
                        entrypoint: note_id,
                        files: vec![],
                        attached_skills: vec![],
                        expected_package_revision: None,
                        expected_entrypoint_revision: Some(note_rev),
                        requires_explicit_binding: false,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        s2_skill_refs.push(AbilityRef {
            id: ab_id,
            placement: AbilityPlacement::OwnedProject(proj.clone()),
            revision: pkg.revision,
        });
    }
    let p_two_note = NoteId::from_bytes([0xD1, 104, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_two_ab = AbilityId::from_bytes([0xD1, 104, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let p_two_rev = fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 104, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: p_two_note.clone(),
                    parent: None,
                    slug: "personal-two-sec-role".into(),
                    class: DocClass::Skill,
                    carrier: "---\nname: personal-two-sec-role\ndescription: Two sec role\n---\n\nPERSONAL-TWO-SEC-ROLE-MARKER\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value
        .revision;
    let _ = fixture
        .canonical
        .publish_ability_package(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 104, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: p_two_ab,
                    kind: AbilityKind::Role,
                    entrypoint: p_two_note,
                    files: vec![],
                    attached_skills: s2_skill_refs,
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(p_two_rev),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap();

    let shared_chat =
        ChatThreadId::from_bytes([0xD1, 110, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 110, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: shared_chat.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Shared Personal Chat".into(),
                },
            },
        )
        .await
        .unwrap();
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let base_opts = ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        limits: RunLimits {
            max_steps: 2,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
        ..ChatRunOptions::default()
    };
    // Enqueue a human message first so start has a branch to run on.
    fixture
        .canonical
        .append_chat(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 110, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: shared_chat.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Hi in shared space".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap();
    let mut bad_role_opts = base_opts.clone();
    bad_role_opts.role = Some("personal-only-cross-role".into());
    let started_bad = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: shared_chat.clone(),
                expected_leaf: ThreadEntrySeq::new(1).unwrap(),
                options: bad_role_opts,
            },
        )
        .await;
    // Wait for run to fail fast without binding the cross-space personal role,
    // OR reject synchronously.
    if let Ok(_run) = started_bad {
        let leaf = idle_leaf(fixture, &s1_sc, &shared_chat).await;
        assert_eq!(
            leaf.get(),
            1,
            "cross-space personal role must fail before append"
        );
    }
    // Now start with `shared-with-personal-skill` -> must cleanly omit personal skill & succeed!
    let mut good_shared_opts = base_opts.clone();
    good_shared_opts.role = Some("shared-with-personal-skill".into());
    let _started_good = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: shared_chat.clone(),
                expected_leaf: ThreadEntrySeq::new(1).unwrap(),
                options: good_shared_opts,
            },
        )
        .await
        .unwrap();
    let (mut wire1, prompt1) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("shared chat with local role and cross-space attached skill must reach provider");
    let prompt1_text = prompt1.to_string();
    assert!(
        prompt1_text.contains("SHARED-ROLE-LOCAL-MARKER")
            && !prompt1_text.contains("PERSONAL-CROSS-SKILL-SECRET"),
        "shared chat must include local role and omit cross-space personal skill: {prompt1_text}"
    );
    send_ollama(
        &mut wire1,
        json!({"role": "assistant", "content": "Shared space turn succeeded."}),
        "stop",
    )
    .await;
    let shared_leaf = idle_leaf(fixture, &s1_sc, &shared_chat).await;
    assert_eq!(
        shared_leaf.get(),
        2,
        "shared space personal chat must append assistant reply without CrossSpaceTainted"
    );

    // Personal chat in personal space with a personal role attaching two skills in
    // distinct project_only projects of s2 (s2/proj-a and s2/proj-b, no Space(s2) consent)
    // must omit the conflicting second project_only skill and complete cleanly!
    let p_chat = ChatThreadId::from_bytes([0xD1, 111, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 111, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: p_chat.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Secondary Two Project Only Chat".into(),
                },
            },
        )
        .await
        .unwrap();
    let mut s2_role_opts = base_opts.clone();
    s2_role_opts.role = Some("personal-two-sec-role".into());
    let sub_p = supervisor
        .enqueue_input(
            owner.clone(),
            SubmitUserChatInput {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD1, 111, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD1; 32]),
                },
                id: PendingInputId::from_bytes([
                    0xD1, 111, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                thread: p_chat.clone(),
                expected_leaf: ThreadEntrySeq::ZERO,
                body: "Run with two project-only attachments in secondary space".into(),
                mentions_agent: false,
            },
            s2_role_opts,
        )
        .await
        .unwrap();
    assert!(sub_p.run.is_some());
    let (mut wire2, prompt2) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("personal chat must omit conflicting second project_only skill and reach provider");
    let prompt2_text = prompt2.to_string();
    assert!(
        prompt2_text.contains("PERSONAL-TWO-SEC-ROLE-MARKER")
            && prompt2_text.contains("S2-PROJ-A-SKILL-MARKER")
            && !prompt2_text.contains("S2-PROJ-B-CONFLICT-SECRET"),
        "must include role + s2/proj-a skill and omit conflicting s2/proj-b skill: {prompt2_text}"
    );
    send_ollama(
        &mut wire2,
        json!({"role": "assistant", "content": "Two project-only handled."}),
        "stop",
    )
    .await;
    let p_leaf = idle_leaf(fixture, personal, &p_chat).await;
    assert_eq!(p_leaf.get(), 2);

    // (6) Post-trash idempotent replays:
    //     - link & link_many after trashing source + target
    //     - create_note & create_notes after trashing linked target
    //     - edit_ability (authored + promote) after trashing ability
    //     - InAppProvider edit_note, move_note, rename_note after trashing note
    let s1_p1_handle = format!("{}/seam-p1", s1.slug);
    let mk_note = |tag: u8, title: &str| {
        let registry = fixture.registry.clone();
        let owner = owner.clone();
        let proj = s1_p1_handle.clone();
        let title = title.to_owned();
        async move {
            call_mcp(
                &registry,
                &owner,
                [0xD1, 120, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
                "create_note",
                json!({ "project": proj, "title": title, "body": format!("Body of {title}") }),
            )
            .await
            .unwrap()
            .structured_content
        }
    };
    let n_src = mk_note(1, "Link Replay Src").await;
    let n_tgt = mk_note(2, "Link Replay Tgt").await;
    let n_bsrc = mk_note(3, "Batch Link Replay Src").await;
    let n_btgt = mk_note(4, "Batch Link Replay Tgt").await;
    let n_create_tgt = mk_note(5, "Create Link Replay Tgt").await;
    // Commit link + link_many + create_note(with link) + create_notes(with link)
    let link_key = [0xD1, 121, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let link_args =
        json!({ "from": n_src["noteId"], "to": n_tgt["noteId"], "relation": "related" });
    let link_first = call_mcp(
        &fixture.registry,
        &owner,
        link_key,
        "link",
        link_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let lm_key = [0xD1, 121, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let lm_args = json!({
        "links": [{ "from": n_bsrc["noteId"], "to": n_btgt["noteId"], "relation": "related" }]
    });
    let lm_first = call_mcp(
        &fixture.registry,
        &owner,
        lm_key,
        "link_many",
        lm_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let cn_key = [0xD1, 121, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3];
    let cn_args = json!({
        "project": s1_p1_handle,
        "title": "Created With Link",
        "body": "Links to target.",
        "links": [{ "relation": "related", "to": n_create_tgt["noteId"] }]
    });
    let cn_first = call_mcp(
        &fixture.registry,
        &owner,
        cn_key,
        "create_note",
        cn_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let cns_key = [0xD1, 121, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    let cns_args = json!({
        "project": s1_p1_handle,
        "notes": [{
            "title": "Batch Created With Link",
            "body": "Batch links to target.",
            "links": [{ "relation": "related", "to": n_create_tgt["noteId"] }]
        }]
    });
    let cns_first = call_mcp(
        &fixture.registry,
        &owner,
        cns_key,
        "create_notes",
        cns_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    // Trash source and target notes, then verify exact-key replays ALL succeed!
    for (idx, nid) in [
        &n_src["noteId"],
        &n_tgt["noteId"],
        &n_bsrc["noteId"],
        &n_btgt["noteId"],
        &n_create_tgt["noteId"],
    ]
    .into_iter()
    .enumerate()
    {
        call_mcp(
            &fixture.registry,
            &owner,
            [
                0xD1, 122, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx as u8,
            ],
            "delete_note",
            json!({ "ref": nid }),
        )
        .await
        .unwrap();
    }
    let link_replay = call_mcp(&fixture.registry, &owner, link_key, "link", link_args)
        .await
        .expect("post-trash link replay must succeed")
        .structured_content;
    assert_eq!(link_replay["noteId"], link_first["noteId"]);
    assert_eq!(link_replay["versionToken"], link_first["versionToken"]);
    let lm_replay = call_mcp(&fixture.registry, &owner, lm_key, "link_many", lm_args)
        .await
        .expect("post-trash link_many replay must succeed")
        .structured_content;
    assert_eq!(lm_replay["results"][0]["ok"], true);
    assert_eq!(
        lm_replay["results"][0]["versionToken"],
        lm_first["results"][0]["versionToken"]
    );
    let cn_replay = call_mcp(&fixture.registry, &owner, cn_key, "create_note", cn_args)
        .await
        .expect("post-trash create_note replay with trashed link target must succeed")
        .structured_content;
    assert_eq!(cn_replay["noteId"], cn_first["noteId"]);
    assert_eq!(cn_replay["versionToken"], cn_first["versionToken"]);
    let cns_replay = call_mcp(&fixture.registry, &owner, cns_key, "create_notes", cns_args)
        .await
        .expect("post-trash create_notes replay with trashed link target must succeed")
        .structured_content;
    assert_eq!(cns_replay["results"][0]["ok"], true);
    assert_eq!(
        cns_replay["results"][0]["noteId"],
        cns_first["results"][0]["noteId"]
    );
    assert_eq!(
        cns_replay["results"][0]["versionToken"],
        cns_first["results"][0]["versionToken"]
    );

    // edit_ability (authored + promote) post-trash replay:
    let ab_created = call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 123, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "authored-promote-replay",
            "description": "Initial desc",
            "instructions": "Initial instructions",
            "placement": { "home": "project", "project": s1_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let ab_edit_key = [0xD1, 123, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let ab_edit_args = json!({
        "ref": ab_created["ref"],
        "versionToken": ab_created["versionToken"],
        "description": "Updated desc",
        "instructions": "Updated instructions",
        "home": { "home": "space" },
    });
    let ab_edit_first = call_mcp(
        &fixture.registry,
        &owner,
        ab_edit_key,
        "edit_ability",
        ab_edit_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 123, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "delete_ability",
        json!({ "ref": ab_edit_first["ref"] }),
    )
    .await
    .unwrap();
    let ab_edit_replay = call_mcp(
        &fixture.registry,
        &owner,
        ab_edit_key,
        "edit_ability",
        ab_edit_args,
    )
    .await
    .expect("post-trash authored+promote edit_ability replay must succeed")
    .structured_content;
    assert_eq!(ab_edit_replay["outcome"], "updated");
    assert_eq!(ab_edit_replay["ref"], ab_edit_first["ref"]);
    assert_eq!(
        ab_edit_replay["versionToken"],
        ab_edit_first["versionToken"]
    );

    // InAppProvider edit_note, move_note, rename_note post-trash replays:
    let p_slug = fixture
        .control
        .list_spaces(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.history.space_id == pscope.space_id)
        .unwrap()
        .slug;
    let p_proj_handle = format!("{p_slug}/personal-replay-proj");
    let _ = p_proj;
    let in_app_note = local
        .registry
        .call_tool(
            mk_in_app(10),
            "create_note",
            json!({
                "project": p_proj_handle,
                "title": "InApp Post Trash Note",
                "body": "Original body line.",
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let edit_args = json!({
        "ref": in_app_note["noteId"],
        "versionToken": in_app_note["versionToken"],
        "operation": "append",
        "content": "\nAppended line.",
    });
    let _edit_first = local
        .registry
        .call_tool(mk_in_app(11), "edit_note", edit_args.clone())
        .await
        .unwrap()
        .structured_content;
    let move_args = json!({
        "ref": in_app_note["noteId"],
        "toFolder": "personal-replay-proj/sub-moved",
    });
    let _move_first = local
        .registry
        .call_tool(mk_in_app(12), "move_note", move_args.clone())
        .await
        .unwrap()
        .structured_content;
    let rename_args = json!({
        "ref": in_app_note["noteId"],
        "title": "InApp Renamed Title",
    });
    let _rename_first = local
        .registry
        .call_tool(mk_in_app(13), "rename_note", rename_args.clone())
        .await
        .unwrap()
        .structured_content;
    // Trash note via owner MCP, then replay all 3 InAppProvider calls with exact keys!
    call_mcp(
        &fixture.registry,
        &owner,
        [0xD1, 124, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "delete_note",
        json!({ "ref": in_app_note["noteId"] }),
    )
    .await
    .unwrap();
    let edit_replay = local
        .registry
        .call_tool(mk_in_app(11), "edit_note", edit_args)
        .await
        .expect("InAppProvider post-trash edit_note replay must succeed")
        .structured_content;
    assert_eq!(edit_replay["outcome"], "edited");
    let move_replay = local
        .registry
        .call_tool(mk_in_app(12), "move_note", move_args)
        .await
        .expect("InAppProvider post-trash move_note replay must succeed")
        .structured_content;
    assert_eq!(move_replay["outcome"], "moved");
    let rename_replay = local
        .registry
        .call_tool(mk_in_app(13), "rename_note", rename_args)
        .await
        .expect("InAppProvider post-trash rename_note replay must succeed")
        .structured_content;
    assert_eq!(rename_replay["outcome"], "renamed");
}

async fn authority_narrowing_chat_and_replay_seams(
    fixture: &mut RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = fresh_owner(fixture).await;
    let actor = owner.auth().principal().clone();
    let pscope = personal.scope().clone();
    let control_for_id = fixture.control.clone();
    let acc_id = |sub: u8| {
        let control = control_for_id.clone();
        let owner = owner.clone();
        let actor = actor.clone();
        async move {
            let rev = control
                .account(owner, actor.clone())
                .await
                .unwrap()
                .revision;
            AccountCommandIdentity {
                owner: actor.clone(),
                actor,
                expected: rev,
                key: CommandKey::from_bytes([
                    0xD2, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                ]),
                hash: ContentDigest::from_bytes([0xD2; 32]),
            }
        }
    };

    let sa = fixture
        .control
        .create_space(
            fresh_owner(fixture).await,
            AccountMutation {
                identity: acc_id(1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Authority Seam Alpha".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let sb = fixture
        .control
        .create_space(
            fresh_owner(fixture).await,
            AccountMutation {
                identity: acc_id(2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    kind: SpaceKind::Shared,
                    name: "Authority Seam Beta".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let sc = fixture
        .control
        .create_space(
            fresh_owner(fixture).await,
            AccountMutation {
                identity: acc_id(3).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xD2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
                    kind: SpaceKind::Shared,
                    name: "Authority Seam Gamma".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(fixture).await;
    let sa_p1 = create_project_folder(
        fixture,
        &sa.history,
        &actor,
        FolderId::from_bytes([0xD2, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "alpha-p1",
    )
    .await;
    let sa_p2 = create_project_folder(
        fixture,
        &sa.history,
        &actor,
        FolderId::from_bytes([0xD2, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "alpha-p2",
    )
    .await;
    let sb_p1 = create_project_folder(
        fixture,
        &sb.history,
        &actor,
        FolderId::from_bytes([0xD2, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "beta-p1",
    )
    .await;
    let sc_p1 = create_project_folder(
        fixture,
        &sc.history,
        &actor,
        FolderId::from_bytes([0xD2, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "gamma-p1",
    )
    .await;
    let pp = create_project_folder(
        fixture,
        &pscope,
        &actor,
        FolderId::from_bytes([0xD2, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "personal-seam-proj",
    )
    .await;
    let sa_scope = SpaceContext::new(owner.auth().clone(), sa.history.clone(), budget()).unwrap();
    let sa_sub = fixture
        .canonical
        .ensure_folder_path(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(sa_p1.folder_id.clone()),
                    path: "regular-sub".into(),
                },
            },
        )
        .await
        .unwrap();

    // (1) admit_space_management + change_membership + provider management respect taint,
    //     space exclusions, read_classes narrowing, and project_root pins.
    let tainted_owner = fresh_owner(fixture).await;
    tainted_owner.auth().taint().mark_external_read();
    assert!(matches!(
        fixture
            .control
            .admit_space_management(tainted_owner.clone(), sa.history.clone())
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    let sa_rev = fixture
        .control
        .context_scope(
            owner.clone(),
            ContextScope::Space(sa.history.space_id.clone()),
        )
        .await
        .unwrap()
        .revision;
    let bob = fixture
        .control
        .create_account(
            owner.clone(),
            AccountMutation {
                identity: acc_id(20).await,
                input: NewAccount {
                    username: "authority-seam-bob".into(),
                    email: None,
                    display_name: "Authority Seam Bob".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let bob_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &bob.id,
            &AuthSessionId::from_bytes([0xD2; 16]),
            &bob_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let bob_ctx = AccountContext::new(
        fixture
            .control
            .resolve(support::evidence(
                AuthEvidenceKind::Session,
                bob_token.secret.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    let mem_change = MembershipChange {
        command: CommandKey::from_bytes([0xD2, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        member: bob.id.clone(),
        role: Some(SpaceRole::Viewer),
        expected: sa_rev,
    };
    assert!(matches!(
        fixture
            .control
            .change_membership(
                SpaceContext::new(tainted_owner.auth().clone(), sa.history.clone(), budget())
                    .unwrap(),
                mem_change.clone(),
            )
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    let owner_proj_pinned =
        AccountContext::new(owner.auth().restrict_to_project(&sa_p1).unwrap(), budget());
    assert!(matches!(
        fixture
            .control
            .admit_space_management(owner_proj_pinned.clone(), sa.history.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .change_membership(
                SpaceContext::new(
                    owner_proj_pinned.auth().clone(),
                    sa.history.clone(),
                    budget()
                )
                .unwrap(),
                mem_change,
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let owner_only_personal = AccountContext::new(
        owner
            .auth()
            .restrict_to_spaces(&[pscope.space_id.clone()].into()),
        budget(),
    );
    assert!(matches!(
        fixture
            .control
            .admit_space_management(owner_only_personal, sa.history.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let owner_userdoc_only = AccountContext::new(
        owner
            .auth()
            .restrict_read_classes(&sa.history.space_id, &[DocClass::UserDoc].into())
            .unwrap(),
        budget(),
    );
    let admitted_narrow = fixture
        .control
        .admit_space_management(owner_userdoc_only, sa.history.clone())
        .await
        .expect("read-class narrowed owner still owns active Space");
    assert!(
        !admitted_narrow
            .auth()
            .spaces()
            .get(&sa.history.space_id)
            .unwrap()
            .read_classes
            .contains(&DocClass::Skill),
        "admit_space_management must preserve narrowed read_classes"
    );

    // Loopback provider setup for provider management, inspect_attachment, schedules, and InAppProvider.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &owner, &listener, 0x7A, true).await;
    let consent_us = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: [DocClass::UserDoc, DocClass::Skill].into(),
        })
    };
    let sa_att_req = AccountMutation {
        identity: acc_id(30).await,
        input: RequestProviderAttachment {
            id: RequestId::from_bytes([0xD2, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            expected: None,
            resource: local.resource.id.clone(),
            resource_consent_epoch: local.resource.consent_epoch,
            credential_consent_epoch: None,
            target: ProviderAttachmentTarget::Space(sa.history.space_id.clone()),
            consent: consent_us(),
            expires_at_ms: None,
        },
    };
    assert!(matches!(
        local
            .provider
            .request_attachment(owner_proj_pinned.clone(), sa_att_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let sa_att = local
        .provider
        .request_attachment(owner.clone(), sa_att_req)
        .await
        .unwrap()
        .value;
    let sa_app_req = AccountMutation {
        identity: acc_id(31).await,
        input: ApproveProviderAttachment {
            id: sa_att.id.clone(),
            expected: sa_att.revision,
            resource_consent_epoch: sa_att.resource_consent_epoch,
            credential_consent_epoch: sa_att.credential_consent_epoch,
            consent: consent_us(),
        },
    };
    assert!(matches!(
        local
            .provider
            .approve_attachment(owner_proj_pinned.clone(), sa_app_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let sa_att_approved = local
        .provider
        .approve_attachment(owner.clone(), sa_app_req)
        .await
        .unwrap()
        .value;
    assert!(matches!(
        local
            .provider
            .revoke_attachment(
                owner_proj_pinned.clone(),
                AccountMutation {
                    identity: acc_id(32).await,
                    input: RevokeProviderAttachment {
                        id: sa_att_approved.id.clone(),
                        expected: sa_att_approved.revision,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .set_preference(
                owner_proj_pinned.clone(),
                AccountMutation {
                    identity: acc_id(33).await,
                    input: SetProviderPreference {
                        scope: ProviderPreferenceScope::Personal,
                        kind: PreferenceModelKind::Completion,
                        resource: local.resource.id.clone(),
                        model: local.model.clone(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .set_preference(
                owner_proj_pinned.clone(),
                AccountMutation {
                    identity: acc_id(34).await,
                    input: SetProviderPreference {
                        scope: ProviderPreferenceScope::Space(sa.history.space_id.clone()),
                        kind: PreferenceModelKind::Completion,
                        resource: local.resource.id.clone(),
                        model: local.model.clone(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // (2) inspect_attachment pre-auth and foreign existence hiding.
    let missing_att_id =
        RequestId::from_bytes([0xD2, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    let bob_existing = local
        .provider
        .inspect_attachment(bob_ctx.clone(), sa_att_approved.id.clone())
        .await;
    let bob_missing = local
        .provider
        .inspect_attachment(bob_ctx, missing_att_id.clone())
        .await;
    assert!(matches!(
        bob_existing,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        bob_missing,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let write_pat = fixture.pat(BearerScope::Write, false).await;
    let read_pat = fixture.pat(BearerScope::Read, false).await;
    assert!(matches!(
        local
            .provider
            .inspect_attachment(write_pat.clone(), sa_att_approved.id.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .inspect_attachment(write_pat.clone(), missing_att_id)
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // (3) mcp_dedup actor isolation and BearerScope::Read write-effect rejection.
    let owner_dedup_key = McpDedupKey {
        actor: owner.auth().grant().to_string(),
        request_key: CommandKey::from_bytes([0xD2, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        request_hash: ContentDigest::from_bytes([0xD2; 32]),
        operation: "create_note".into(),
    };
    fixture
        .control
        .record_mcp_dedup(
            owner.clone(),
            McpDedupRecord {
                key: owner_dedup_key.clone(),
                safe_result: "{\"ok\":true}".into(),
                effect: AgentEffect::Write,
                ttl_ms: 60_000,
            },
        )
        .await
        .unwrap();
    let shared_run_ctx = AccountContext::new(
        owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xD2, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                sa.history.space_id.clone(),
                ChatAudience::Shared,
                owner.auth().spaces().clone(),
            )
            .unwrap(),
        budget(),
    );
    for foreign_caller in [&write_pat, &read_pat, &shared_run_ctx] {
        assert!(matches!(
            fixture
                .control
                .lookup_mcp_dedup(foreign_caller.clone(), owner_dedup_key.clone())
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert!(matches!(
            fixture
                .control
                .record_mcp_dedup(
                    foreign_caller.clone(),
                    McpDedupRecord {
                        key: owner_dedup_key.clone(),
                        safe_result: "{\"forged\":true}".into(),
                        effect: AgentEffect::None,
                        ttl_ms: 60_000,
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
    }
    assert!(matches!(
        fixture
            .control
            .record_mcp_dedup(
                read_pat.clone(),
                McpDedupRecord {
                    key: McpDedupKey {
                        actor: read_pat.auth().grant().to_string(),
                        request_key: CommandKey::from_bytes([
                            0xD2, 42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        request_hash: ContentDigest::from_bytes([0xD2; 32]),
                        operation: "create_note".into(),
                    },
                    safe_result: "{\"ok\":true}".into(),
                    effect: AgentEffect::Write,
                    ttl_ms: 60_000,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));

    // Attach personal & project consents for remaining checks.
    for (sub, target) in [
        (
            35u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: pscope.space_id.clone(),
            },
        ),
        (
            36u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: sa.history.space_id.clone(),
            },
        ),
        (
            37u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: sb.history.space_id.clone(),
            },
        ),
        (38u8, ProviderAttachmentTarget::Project(sb_p1.clone())),
    ] {
        let a = local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(sub).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([
                            0xD2, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                        ]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
                        credential_consent_epoch: None,
                        target: target.clone(),
                        consent: consent_us(),
                        expires_at_ms: None,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        if !matches!(target, ProviderAttachmentTarget::Personal { .. }) {
            local
                .provider
                .approve_attachment(
                    owner.clone(),
                    AccountMutation {
                        identity: acc_id(sub + 50).await,
                        input: ApproveProviderAttachment {
                            id: a.id,
                            expected: a.revision,
                            resource_consent_epoch: a.resource_consent_epoch,
                            credential_consent_epoch: a.credential_consent_epoch,
                            consent: consent_us(),
                        },
                    },
                )
                .await
                .unwrap();
        }
    }

    let sa_p1_handle = format!("{}/alpha-p1", sa.slug);
    let sb_p1_handle = format!("{}/beta-p1", sb.slug);
    let sc_p1_handle = format!("{}/gamma-p1", sc.slug);
    let sched_role_desc = match fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                kind: AbilityKind::Role,
                name: "research".into(),
                project: None,
            },
        )
        .await
        .unwrap()
    {
        AbilityResolution::Resolved(d) => *d,
        other => panic!("expected research role, got {other:?}"),
    };
    let sched_role = sched_role_desc.reference;
    let sched_role_skills = sched_role_desc.attached_skills;

    // (4) Schedule query authority: Keeper sees only its own schedule; AgentRun sees none.
    // (5) create_chat rejects non-project folders and Space root folders.
    box_step(|| async {
        let sched_a_id =
            ScheduleId::from_bytes([0xD2, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let sched_b_id =
            ScheduleId::from_bytes([0xD2, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        let due_slot = Timestamp::parse("2029-01-07T03:00:00Z").unwrap();
        let next_slot = Timestamp::parse("2029-01-14T03:00:00Z").unwrap();
        let mk_sched_def = |title: &str| ScheduleDefinition {
            space: sa.history.space_id.clone(),
            project: Some(sa_p1.clone()),
            title: title.into(),
            init_prompt: "Audit notes.".into(),
            cron: "0 0 3 * * Sun *".into(),
            timezone: "UTC".into(),
            approved_role: sched_role.clone(),
            limits: RunLimits {
                max_steps: 2,
                max_tokens: 16_000,
                timeout_ms: 15_000,
            },
        };
        let mut sched_a_rev = ControlRevision::ZERO;
        for (sub, sid, sname) in [
            (45u8, &sched_a_id, "Sched A"),
            (46u8, &sched_b_id, "Sched B"),
        ] {
            let created = fixture
                .control
                .create_schedule(
                    owner.clone(),
                    AccountMutation {
                        identity: acc_id(sub).await,
                        input: CreateSchedule {
                            id: sid.clone(),
                            definition: mk_sched_def(sname),
                            approved_skills: sched_role_skills.clone(),
                            next_slot: due_slot,
                            paused: false,
                        },
                    },
                )
                .await
                .unwrap();
            if sid == &sched_a_id {
                sched_a_rev = created.value.revision;
            }
        }
        fixture
            .storage
            .clock
            .0
            .store(due_slot.unix_seconds() * 1000, Ordering::SeqCst);
        let (claimed_run_a, keeper_a_space) = match fixture
            .control
            .claim_schedule(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Scheduler),
                    budget: budget(),
                },
                ClaimSchedule {
                    schedule: sched_a_id.clone(),
                    slot: due_slot,
                    next_slot: Some(next_slot),
                    current_role: sched_role.clone(),
                    expected: sched_a_rev,
                },
            )
            .await
            .unwrap()
        {
            ScheduleClaim::Claimed { run, context, .. } => (run, *context),
            other => panic!("expected Claimed, got {other:?}"),
        };
        let keeper_a_acc = AccountContext::new(keeper_a_space.auth().clone(), budget());
        let own_sched = fixture
            .control
            .get_schedule(keeper_a_space.clone(), sched_a_id.clone())
            .await
            .expect("keeper must read its own schedule");
        assert_eq!(own_sched.id, sched_a_id);
        assert_eq!(
            fixture
                .control
                .get_schedule_run(
                    ScheduleRunContext::Owner(Box::new(keeper_a_acc.clone())),
                    sched_a_id.clone(),
                    claimed_run_a.clone(),
                )
                .await
                .expect("keeper must read its own run")
                .run,
            claimed_run_a
        );
        assert!(matches!(
            fixture
                .control
                .get_schedule(keeper_a_space.clone(), sched_b_id.clone())
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        assert!(matches!(
            fixture
                .control
                .list_schedule_runs(
                    ScheduleRunContext::Owner(Box::new(keeper_a_acc)),
                    sched_b_id.clone(),
                    ControlPageRequest::new(10, None).unwrap(),
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        let keeper_listed = fixture
            .control
            .list_schedules(keeper_a_space, ControlPageRequest::new(10, None).unwrap())
            .await
            .unwrap();
        assert_eq!(keeper_listed.items.len(), 1);
        assert_eq!(keeper_listed.items[0].id, sched_a_id);
        let agent_sa_space =
            SpaceContext::new(shared_run_ctx.auth().clone(), sa.history.clone(), budget()).unwrap();
        assert!(matches!(
            fixture
                .control
                .get_schedule(agent_sa_space.clone(), sched_a_id.clone())
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        assert!(
            fixture
                .control
                .list_schedules(agent_sa_space, ControlPageRequest::new(10, None).unwrap())
                .await
                .unwrap()
                .items
                .is_empty(),
            "AgentRun list_schedules must not expose owner schedules"
        );
        assert!(matches!(
            fixture
                .control
                .get_schedule_run(
                    ScheduleRunContext::Owner(Box::new(shared_run_ctx.clone())),
                    sched_a_id.clone(),
                    claimed_run_a,
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        assert!(matches!(
            fixture
                .control
                .list_schedule_runs(
                    ScheduleRunContext::Owner(Box::new(shared_run_ctx.clone())),
                    sched_a_id,
                    ControlPageRequest::new(10, None).unwrap(),
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));

        // (5) create_chat rejects non-project folders and Space root folders.
        let root_folder = fixture
            .canonical
            .resolve_folder_path(sa_scope.clone(), None, String::new())
            .await
            .unwrap()
            .unwrap()
            .reference
            .folder_id;
        for (idx, bad_folder) in [sa_sub.folder_id.clone(), root_folder]
            .into_iter()
            .enumerate()
        {
            assert!(matches!(
                fixture
                    .canonical
                    .create_chat(
                        sa_scope.clone(),
                        Mutation {
                            identity: CommandIdentity {
                                scope: sa.history.clone(),
                                actor: actor.clone(),
                                key: CommandKey::from_bytes([
                                    0xD2,
                                    50 + idx as u8,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    1,
                                ]),
                                hash: ContentDigest::from_bytes([0xD2; 32]),
                            },
                            preconditions: Preconditions::default(),
                            input: CreateChat {
                                thread: ChatThreadId::from_bytes([
                                    0xD2,
                                    50 + idx as u8,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    1,
                                ]),
                                kind: ChatThreadKind::SpaceGroup,
                                owner: actor.clone(),
                                project_folder: Some(bad_folder),
                                title: "Invalid project folder chat".into(),
                            },
                        },
                    )
                    .await,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ));
        }
        fixture
            .canonical
            .create_chat(
                sa_scope.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: sa.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD2, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        hash: ContentDigest::from_bytes([0xD2; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: ChatThreadId::from_bytes([
                            0xD2, 52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        kind: ChatThreadKind::SpaceGroup,
                        owner: actor.clone(),
                        project_folder: Some(sa_p1.folder_id.clone()),
                        title: "Valid project chat".into(),
                    },
                },
            )
            .await
            .expect("create_chat with an active project folder must succeed");
    })
    .await;

    // (6) bind_chat_role follows ability_placement_trail for promoted ar1: tokens,
    //     and collapses Disabled/Stale promoted destinations under project_only to ResourceNotFound.
    box_step(|| async {
    let promo_alpha = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "promoted-ar1-alpha",
            "description": "Promoted ar1 trail test",
            "instructions": "Follow promoted trail.",
            "placement": { "home": "project", "project": sa_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let old_alpha_ar1 = promo_alpha["ref"].as_str().unwrap().to_owned();
    let promoted_alpha = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": old_alpha_ar1,
            "versionToken": promo_alpha["versionToken"],
            "home": { "home": "space" },
            "availability": { "mode": "all-projects" },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let promoted_alpha_ref_str = promoted_alpha["ref"].as_str().unwrap().to_owned();
    let promo_beta = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "promoted-ar1-beta",
            "description": "Promoted disabled project_only test",
            "instructions": "Must collapse when disabled.",
            "placement": { "home": "project", "project": sb_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let old_beta_ar1 = promo_beta["ref"].as_str().unwrap().to_owned();
    call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": old_beta_ar1,
            "versionToken": promo_beta["versionToken"],
            "home": { "home": "space" },
            "enabled": false,
        }),
    )
    .await
    .unwrap();
    // Run a chat with old_alpha_ar1 in sa/sa_p1 via supervisor -> must bind promoted Space role!
    let ep_trail = EpisodeId::from_bytes([0xD2, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: acc_id(62).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_trail.clone(),
                        name: Some("trail-bind-ep".into()),
                    },
                    project_hint: Some(sa_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let alpha_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xD2, 62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            sa.history.space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let alpha_primary = SpaceContext::new(alpha_run_auth, sa.history.clone(), budget()).unwrap();
    let alpha_sel = local
        .provider
        .select_provider(
            alpha_primary.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: Some(sa_p1.clone()),
            },
        )
        .await
        .unwrap();
    let supervisor = AgentRunSupervisor::new_local(
        local.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let run_opts = |role: Option<&str>| ChatRunOptions {
        provider: Some(local.resource.id.clone()),
        model: Some(local.model.clone()),
        role: role.map(ToOwned::to_owned),
        limits: RunLimits {
            max_steps: 2,
            max_tokens: 16_000,
            timeout_ms: 15_000,
        },
    };
    let alpha_thread =
        ChatThreadId::from_bytes([0xD2, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: alpha_thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Promoted ar1 bind thread".into(),
                },
            },
        )
        .await
        .unwrap();
    let alpha_user_msg = fixture
        .canonical
        .append_chat(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 63, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: alpha_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Bind promoted ar1.".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap()
        .value
        .seq;
    let _ = (alpha_sel, ep_trail, promoted_alpha_ref_str);
    supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: sa.history.clone(),
                thread: alpha_thread.clone(),
                expected_leaf: alpha_user_msg,
                options: run_opts(Some(&old_alpha_ar1)),
            },
        )
        .await
        .expect("start with promoted pre-trail ar1: token must follow trail and succeed");
    let (mut wire1, req1) = timeout(Duration::from_secs(15), read_request(&listener))
        .await
        .expect("promoted ar1: must follow ability_placement_trail and reach provider");
    assert!(
        req1.to_string().contains("Follow promoted trail."),
        "provider request must include promoted role instructions: {req1}"
    );
    send_ollama(
        &mut wire1,
        json!({"role": "assistant", "content": "Bound promoted role."}),
        "stop",
    )
    .await;
    let _ = idle_leaf(fixture, &sa_scope, &alpha_thread).await;
    // Disabled promoted ar1: under project_only (sb/sb_p1) must collapse to ResourceNotFound!
    let sb_scope = SpaceContext::new(owner.auth().clone(), sb.history.clone(), budget()).unwrap();
    let beta_thread =
        ChatThreadId::from_bytes([0xD2, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            sb_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sb.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: beta_thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: actor.clone(),
                    project_folder: Some(sb_p1.folder_id.clone()),
                    title: "Disabled promoted project_only thread".into(),
                },
            },
        )
        .await
        .unwrap();
    let beta_msg = fixture
        .canonical
        .append_chat(
            sb_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sb.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 64, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: beta_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Try disabled promoted role.".into()),
                    tool_calls: vec![],
                    provenance: None,
                    interruption: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: vec![],
                    tainted: false,
                },
            },
        )
        .await
        .unwrap()
        .value
        .seq;
    let beta_start = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: sb.history.clone(),
                thread: beta_thread.clone(),
                expected_leaf: beta_msg,
                options: run_opts(Some(&old_beta_ar1)),
            },
        )
        .await;
    match beta_start {
        Err(err) => assert!(
            matches!(err, PortError::Domain(DomainError::ResourceNotFound)),
            "disabled promoted ar1: outside project_only must collapse to ResourceNotFound, got {err:?}"
        ),
        Ok(_) => {
            let beta_leaf = idle_leaf(fixture, &sb_scope, &beta_thread).await;
            let beta_branch = fixture
                .canonical
                .read_chat(
                    sb_scope.clone(),
                    ChatRead {
                        thread: beta_thread,
                        leaf: beta_leaf,
                        before: None,
                        max_entries: PageLimit::new(20).unwrap(),
                    },
                )
                .await
                .unwrap();
            let debug = format!("{beta_branch:?}");
            assert!(
                debug.contains(DomainError::ResourceNotFound.code()) || beta_leaf == beta_msg,
                "disabled promoted ar1: outside project_only must collapse to ResourceNotFound without leaking InvalidState: {debug}"
            );
            assert!(
                !debug.contains("invalid_state"),
                "disabled promoted ar1: must never leak InvalidState: {debug}"
            );
        }
    }
    })
    .await;

    // (7) Direct AgentRun BindRole rejected; InAppProvider Personal chat use_role(System, foreign project)
    //     leaves episode untouched AND flips BranchTaint.
    // (8) proposals::prepare SpaceReadOnly on consented foreign target flips BranchTaint;
    //     confirmed edit_note proposal replays after trash.
    box_step(|| async {
        let ep_personal =
            EpisodeId::from_bytes([0xD2, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let ep_p_created = fixture
            .control
            .start_or_resume_episode(
                owner.clone(),
                AccountMutation {
                    identity: acc_id(70).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: ep_personal.clone(),
                            name: Some("personal-bind-guard".into()),
                        },
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await
            .unwrap();
        let ep_p_rev = match ep_p_created.value {
            EpisodeStartResult::New(ep) => ep.revision,
            other => panic!("expected New episode, got {other:?}"),
        };
        let personal_run_auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xD2, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let personal_run_acc = AccountContext::new(personal_run_auth.clone(), budget());
        assert!(matches!(
            fixture
                .control
                .update_episode(
                    personal_run_acc.clone(),
                    AccountMutation {
                        identity: acc_id(71).await,
                        input: EpisodeMutation::BindRole(BindEpisodeRole {
                            episode: ep_personal.clone(),
                            expected: ep_p_rev,
                            active_role: sched_role.clone(),
                            project_hint: Some(sa_p1.clone()),
                        }),
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
        assert!(!personal_run_auth.taint().is_tainted());
        local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: personal_run_acc,
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xD2, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                },
                "use_role",
                json!({
                    "role": "research",
                    "project": sa_p1_handle,
                    "session": ep_personal,
                }),
            )
            .await
            .expect(
                "InAppProvider use_role with System role and foreign project must render inline",
            );
        assert!(
            personal_run_auth.taint().is_tainted(),
            "use_role resolving a foreign project with a System role MUST flip BranchTaint"
        );
        let ep_p_after = fixture
            .control
            .get_episode(owner.clone(), ep_personal)
            .await
            .unwrap();
        assert_eq!(ep_p_after.active_role, None);
        assert_eq!(ep_p_after.project_hint, None);

        // (8) proposals::prepare SpaceReadOnly / AbilityWriteForbidden on consented foreign target
        //     MUST flip BranchTaint; AND confirmed edit_note proposal replays after trash!
        let locked_note = call_mcp(
            &fixture.registry,
            &owner,
            [0xD2, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            "create_note",
            json!({
                "project": sa_p1_handle,
                "path": "regular-sub",
                "title": "Locked Target Note",
                "body": "Initial locked body.",
            }),
        )
        .await
        .unwrap()
        .structured_content;
        fixture
            .canonical
            .set_folder_write_lock(sa_scope.clone(), sa_sub.folder_id.clone(), true)
            .await
            .unwrap();
        let prop_thread =
            ChatThreadId::from_bytes([0xD2, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        fixture
            .canonical
            .create_chat(
                personal.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD2, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        hash: ContentDigest::from_bytes([0xD2; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: prop_thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: None,
                        title: "Proposal taint & replay thread".into(),
                    },
                },
            )
            .await
            .unwrap();
        let prop_run_id =
            AgentRunId::from_bytes([0xD2, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        let prop_auth = owner
            .auth()
            .for_agent_run(
                prop_run_id.clone(),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let prop_scope = SpaceContext::new(prop_auth.clone(), pscope.clone(), budget()).unwrap();
        fixture
            .canonical
            .claim_active_run(
                prop_scope.clone(),
                ClaimChatRun {
                    thread: prop_thread.clone(),
                    run: prop_run_id,
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap();
        let prop_call_key_init =
            CommandKey::from_bytes([0xD2, 82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        let prop_edit_args_init = json!({
            "ref": locked_note["noteId"],
            "operation": "append",
            "content": "\nConfirmed edit line.",
        });
        let model_entry = fixture
            .canonical
            .append_chat(
                prop_scope,
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD2, 81, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        hash: ContentDigest::from_bytes([0xD2; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: prop_thread.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text("Propose edit.".into()),
                        tool_calls: vec![ProviderToolCall {
                            id: ProviderToolCallId::new(prop_call_key_init.as_str().into())
                                .unwrap(),
                            name: "edit_note".into(),
                            arguments: prop_edit_args_init
                                .as_object()
                                .unwrap()
                                .clone()
                                .into_iter()
                                .collect(),
                        }],
                        provenance: Some(ChatProvenance::default()),
                        interruption: None,
                        proposed_diff: None,
                        proposed_effect: None,
                        referenced_notes: vec![],
                        tainted: false,
                    },
                },
            )
            .await
            .unwrap()
            .value
            .seq;
        let binding = PersonalToolInvocation {
            source: pscope.clone(),
            thread: prop_thread.clone(),
            leaf: model_entry,
            owner: owner.clone(),
        };
        let locked_err = local
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(prop_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xD2, 82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                },
                binding.clone(),
                "edit_note",
                json!({
                    "ref": locked_note["noteId"],
                    "operation": "append",
                    "content": "\nBlocked edit",
                }),
            )
            .await;
        assert!(
            matches!(
                locked_err,
                Err(PortError::Domain(DomainError::SpaceReadOnly))
            ),
            "write-locked foreign proposal must fail SpaceReadOnly, got {:?}",
            locked_err.as_ref().err()
        );
        assert!(
            prop_auth.taint().is_tainted(),
            "SpaceReadOnly on existing consented foreign target MUST flip BranchTaint"
        );
        // Unlock folder, prepare an edit_note proposal, confirm it, trash the note, replay confirm!
        fixture
            .canonical
            .set_folder_write_lock(sa_scope.clone(), sa_sub.folder_id.clone(), false)
            .await
            .unwrap();
        let prop_call_key =
            CommandKey::from_bytes([0xD2, 82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        let prop_res = local
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(prop_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: prop_call_key.clone(),
                },
                binding,
                "edit_note",
                json!({
                    "ref": locked_note["noteId"],
                    "operation": "append",
                    "content": "\nConfirmed edit line.",
                }),
            )
            .await
            .unwrap();
        let proposal = prop_res.proposal().expect("edit_note proposal");
        let prop_entry_seq = fixture
            .canonical
            .append_chat(
                SpaceContext::new(prop_auth, pscope.clone(), budget()).unwrap(),
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD2, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        hash: ContentDigest::from_bytes([0xD2; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: prop_thread.clone(),
                        parent: model_entry,
                        kind: ChatEntryKind::Tool {
                            call_id: prop_call_key,
                        },
                        body: ChatInputBody::Text(prop_res.content[0].text.clone()),
                        tool_calls: vec![],
                        provenance: Some(prop_res.provenance.clone()),
                        interruption: None,
                        proposed_diff: Some(proposal.envelope().to_owned()),
                        proposed_effect: Some(proposal.effect()),
                        referenced_notes: vec![],
                        tainted: true,
                    },
                },
            )
            .await
            .unwrap()
            .value
            .seq;
        let confirm_req = ConfirmProposedDiff {
            source: pscope.clone(),
            thread: prop_thread,
            entry: prop_entry_seq,
            proposal: proposal.id(),
        };
        let confirmed_first = local
            .registry
            .apply_proposed_diff(owner.clone(), confirm_req.clone())
            .await
            .unwrap();
        call_mcp(
            &fixture.registry,
            &owner,
            [0xD2, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            "delete_note",
            json!({ "ref": locked_note["noteId"] }),
        )
        .await
        .unwrap();
        let confirmed_replay = local
            .registry
            .apply_proposed_diff(owner.clone(), confirm_req)
            .await
            .expect("confirmed edit_note proposal replay after note trash must succeed");
        assert_eq!(
            confirmed_replay.result["versionToken"],
            confirmed_first.result["versionToken"]
        );
    })
    .await;

    // (9) Uncommitted create_note retry after link target trashed MUST fail ResourceNotFound;
    //     uncommitted edit_ability(promote) on trashed ability MUST fail NotCommitted without creating `.abilities`.
    // (10) Post-trash replay of rename_folder, move_folder, rename_project (External MCP + InAppProvider).
    box_step(|| async {
    let link_target = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 85, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_note",
        json!({
            "project": sa_p1_handle,
            "title": "Link Target To Trash",
            "body": "Target body.",
        }),
    )
    .await
    .unwrap()
    .structured_content;
    fixture
        .canonical
        .set_folder_write_lock(sa_scope.clone(), sa_p1.folder_id.clone(), true)
        .await
        .unwrap();
    let uncomm_create_key = [0xD2, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let uncomm_create_args = json!({
        "project": sa_p1_handle,
        "title": "Uncommitted Linked Note",
        "body": "Should never commit after target trash.",
        "links": [{ "relation": "relates", "to": link_target["noteId"] }],
    });
    assert!(matches!(
        call_mcp(
            &fixture.registry,
            &owner,
            uncomm_create_key,
            "create_note",
            uncomm_create_args.clone(),
        )
        .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    fixture
        .canonical
        .set_folder_write_lock(sa_scope.clone(), sa_p1.folder_id.clone(), false)
        .await
        .unwrap();
    call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 86, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "delete_note",
        json!({ "ref": link_target["noteId"] }),
    )
    .await
    .unwrap();
    assert!(matches!(
        call_mcp(
            &fixture.registry,
            &owner,
            uncomm_create_key,
            "create_note",
            uncomm_create_args,
        )
        .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    let sc_scope = SpaceContext::new(owner.auth().clone(), sc.history.clone(), budget()).unwrap();
    let uncomm_ab = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "uncommitted-promote-ab",
            "description": "Before lock",
            "instructions": "Original instructions.",
            "placement": { "home": "project", "project": sc_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    assert!(
        fixture
            .canonical
            .resolve_folder_path(sc_scope.clone(), None, ".abilities".into())
            .await
            .unwrap()
            .is_none(),
        "fresh Space sc must not yet have root .abilities folder"
    );
    fixture
        .canonical
        .set_folder_write_lock(sc_scope.clone(), sc_p1.folder_id.clone(), true)
        .await
        .unwrap();
    let uncomm_promo_key = [0xD2, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let uncomm_promo_args = json!({
        "ref": uncomm_ab["ref"],
        "versionToken": uncomm_ab["versionToken"],
        "description": "Blocked edit",
        "home": { "home": "space" },
    });
    assert!(matches!(
        call_mcp(
            &fixture.registry,
            &owner,
            uncomm_promo_key,
            "edit_ability",
            uncomm_promo_args.clone(),
        )
        .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    fixture
        .canonical
        .set_folder_write_lock(sc_scope.clone(), sc_p1.folder_id.clone(), false)
        .await
        .unwrap();
    call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "delete_ability",
        json!({ "ref": uncomm_ab["ref"] }),
    )
    .await
    .unwrap();
    let retry_uncomm_promo = call_mcp(
        &fixture.registry,
        &owner,
        uncomm_promo_key,
        "edit_ability",
        uncomm_promo_args,
    )
    .await;
    assert!(
        matches!(
            retry_uncomm_promo,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "uncommitted edit_ability(promote) retry after trash must fail ResourceNotFound, got {:?}",
        retry_uncomm_promo.as_ref().err()
    );
    assert!(
        fixture
            .canonical
            .resolve_folder_path(sc_scope, None, ".abilities".into())
            .await
            .unwrap()
            .is_none(),
        "uncommitted trashed edit_ability(promote) retry must NOT create Space root .abilities"
    );

    // (10) Post-trash replay of rename_folder, move_folder, rename_project (External MCP + InAppProvider).
    let f_ren = fixture
        .canonical
        .ensure_folder_path(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(sa_p1.folder_id.clone()),
                    path: "folder-ren-src".into(),
                },
            },
        )
        .await
        .unwrap();
    let f_mov = fixture
        .canonical
        .ensure_folder_path(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(sa_p1.folder_id.clone()),
                    path: "folder-mov-src".into(),
                },
            },
        )
        .await
        .unwrap();
    let f_dest = fixture
        .canonical
        .ensure_folder_path(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(sa_p1.folder_id.clone()),
                    path: "folder-mov-dest".into(),
                },
            },
        )
        .await
        .unwrap();
    let ren_key = [0xD2, 91, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let ren_args = json!({
        "project": sa_p1_handle,
        "folder": "folder-ren-src",
        "name": "folder-ren-done",
    });
    let ren_first = call_mcp(
        &fixture.registry,
        &owner,
        ren_key,
        "rename_folder",
        ren_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let mov_key = [0xD2, 91, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let mov_args = json!({
        "project": sa_p1_handle,
        "folder": "folder-mov-src",
        "toFolder": "folder-mov-dest",
    });
    let mov_first = call_mcp(
        &fixture.registry,
        &owner,
        mov_key,
        "move_folder",
        mov_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let sa_p2_handle = format!("{}/alpha-p2", sa.slug);
    let rproj_key = [0xD2, 91, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3];
    let rproj_args = json!({
        "project": sa_p2_handle,
        "slug": "alpha-p2-renamed",
        "displayName": "Alpha P2 Renamed",
    });
    let rproj_first = call_mcp(
        &fixture.registry,
        &owner,
        rproj_key,
        "rename_project",
        rproj_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    // Also commit an InAppProvider rename_folder in Personal Space before trashing!
    let p_sub = fixture
        .canonical
        .ensure_folder_path(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(pp.folder_id.clone()),
                    path: "inapp-folder-src".into(),
                },
            },
        )
        .await
        .unwrap();
    let p_slug = fixture
        .control
        .list_spaces(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.history.space_id == pscope.space_id)
        .unwrap()
        .slug;
    let pp_handle = format!("{p_slug}/personal-seam-proj");
    let in_app_folder_run = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xD2, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let in_app_ren_ctx = || McpInvocationContext {
        account: AccountContext::new(in_app_folder_run.clone(), budget()),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([0xD2, 92, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
    };
    let in_app_ren_args = json!({
        "project": pp_handle,
        "folder": "inapp-folder-src",
        "name": "inapp-folder-done",
    });
    local
        .registry
        .call_tool(in_app_ren_ctx(), "rename_folder", in_app_ren_args.clone())
        .await
        .unwrap();
    // Trash all target folders and verify post-trash replays succeed on both SQLite & PG!
    for (sp, fid) in [
        (&sa.history.space_id, &f_ren.folder_id),
        (&sa.history.space_id, &f_mov.folder_id),
        (&sa.history.space_id, &f_dest.folder_id),
        (&sa.history.space_id, &sa_p2.folder_id),
        (&pscope.space_id, &p_sub.folder_id),
    ] {
        let updated = fixture
            .canonical
            .execute_diagnostic_write_sql_for_test(&format!(
                "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
                sp.as_str(),
                fid.as_str(),
            ))
            .await
            .unwrap();
        assert_eq!(updated, 1);
    }
    let ren_replay = call_mcp(
        &fixture.registry,
        &owner,
        ren_key,
        "rename_folder",
        ren_args,
    )
    .await
    .expect("post-trash rename_folder replay must succeed")
    .structured_content;
    assert_eq!(ren_replay["versionToken"], ren_first["versionToken"]);
    let mov_replay = call_mcp(&fixture.registry, &owner, mov_key, "move_folder", mov_args)
        .await
        .expect("post-trash move_folder replay must succeed")
        .structured_content;
    assert_eq!(mov_replay["versionToken"], mov_first["versionToken"]);
    let rproj_replay = call_mcp(
        &fixture.registry,
        &owner,
        rproj_key,
        "rename_project",
        rproj_args,
    )
    .await
    .expect("post-trash rename_project replay must succeed")
    .structured_content;
    assert_eq!(rproj_replay["versionToken"], rproj_first["versionToken"]);
    let in_app_ren_replay = local
        .registry
        .call_tool(in_app_ren_ctx(), "rename_folder", in_app_ren_args)
        .await
        .expect("InAppProvider post-trash rename_folder replay must succeed")
        .structured_content;
    assert_eq!(in_app_ren_replay["outcome"], "applied");
    })
    .await;

    // (11) Post-trash overlay-only edit_ability replay on an ability with auxiliary files.
    // (12) InAppProvider list_abilities(view: "runtime", source: "system") shadowing.
    box_step(|| async {
    let aux_ab_folder = fixture
        .canonical
        .ensure_folder_path(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: None,
                    path: ".abilities".into(),
                },
            },
        )
        .await
        .unwrap();
    let aux_entry_id = NoteId::from_bytes([0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let aux_entry = fixture
        .canonical
        .create_note(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: aux_entry_id.clone(),
                    parent: Some(aux_ab_folder.folder_id.clone()),
                    slug: "aux-overlay-replay.md".into(),
                    class: DocClass::Skill,
                    carrier: "---\nname: aux-overlay-replay\ndescription: Aux overlay\nmetadata:\n  notarium:\n    kind: role\n---\nInstructions.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let aux_ab_id = AbilityId::from_bytes([0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    let aux_pub = fixture
        .canonical
        .publish_ability_package(
            sa_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: aux_ab_id.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: aux_entry_id.clone(),
                    files: vec![AbilityFile {
                        path: "reference.md".into(),
                        content: "Reference material.\n".into(),
                        digest: ContentDigest::from_bytes(
                            *blake3::hash(b"Reference material.\n").as_bytes(),
                        ),
                    }],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(aux_entry.revision.clone()),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let aux_got = call_mcp(
        &fixture.registry,
        &owner,
        [0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
        "get_ability",
        json!({ "ref": aux_ab_id }),
    )
    .await
    .unwrap()
    .structured_content;
    let aux_ref = aux_got["ref"].as_str().unwrap().to_owned();
    let aux_overlay_key = [0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6];
    let aux_overlay_args = json!({
        "ref": aux_ref,
        "versionToken": aux_got["versionToken"],
        "description": "Aux overlay",
        "enabled": false,
    });
    let aux_edit_first = call_mcp(
        &fixture.registry,
        &owner,
        aux_overlay_key,
        "edit_ability",
        aux_overlay_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(aux_edit_first["enabled"], false);
    fixture
        .canonical
        .delete_note(
            sa_scope,
            Mutation {
                identity: CommandIdentity {
                    scope: sa.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(aux_entry.revision),
                    ..Preconditions::default()
                },
                input: DeleteNote {
                    note: aux_entry_id,
                    disposition: DeleteDisposition::Trash,
                },
            },
        )
        .await
        .unwrap();
    let _ = aux_pub;
    let aux_edit_replay = call_mcp(
        &fixture.registry,
        &owner,
        aux_overlay_key,
        "edit_ability",
        aux_overlay_args,
    )
    .await
    .expect("post-trash overlay-only edit_ability replay on aux-file ability must succeed")
    .structured_content;
    assert_eq!(aux_edit_replay["outcome"], "updated");
    assert_eq!(aux_edit_replay["enabled"], false);

    // (12) InAppProvider list_abilities(view: "runtime", source: "system") must still honor
    //      runtime shadowing by owned abilities with built-in names.
    let p_ab_folder = fixture
        .canonical
        .ensure_folder_path(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: None,
                    path: ".abilities".into(),
                },
            },
        )
        .await
        .unwrap();
    let shadow_entry_id = NoteId::from_bytes([0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let shadow_entry = fixture
        .canonical
        .create_note(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: shadow_entry_id.clone(),
                    parent: Some(p_ab_folder.folder_id),
                    slug: "research".into(),
                    class: DocClass::Skill,
                    carrier: "---\nname: research\ndescription: Custom research shadow\nmetadata:\n  notarium:\n    kind: role\n---\nOwned research instructions.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let shadow_ab_id = AbilityId::from_bytes([0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let shadow_pub = fixture
        .canonical
        .publish_ability_package(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: shadow_ab_id.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: shadow_entry_id.clone(),
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(shadow_entry.revision.clone()),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let list_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let runtime_sys = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(list_run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                ]),
            },
            "list_abilities",
            json!({ "view": "runtime", "source": "system", "kind": "role", "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        !runtime_sys["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "research"),
        "InAppProvider runtime source=system must hide built-in 'research' when shadowed by owned role: {runtime_sys}"
    );
    let authoring_sys = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(list_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "source": "system", "kind": "role", "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        authoring_sys["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "research"),
        "InAppProvider authoring source=system must still list built-in 'research': {authoring_sys}"
    );
    // Clean up personal shadow role so no state leaks if future steps are added after.
    fixture
        .canonical
        .trash_ability_package(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD2, 98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7,
                    ]),
                    hash: ContentDigest::from_bytes([0xD2; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(shadow_entry.revision),
                    ..Preconditions::default()
                },
                input: TrashAbilityPackage {
                    ability: shadow_ab_id,
                    entrypoint: shadow_entry_id,
                    package_revision: shadow_pub.revision,
                },
            },
        )
        .await
        .unwrap();
    })
    .await;
}

async fn centralized_control_narrowing_assertions(
    fixture: &RuntimeFixture,
    provider: &ProviderService,
    pscope: &HistoryScope,
    sa_history: &HistoryScope,
    sa_p1: &FolderRef,
    actor: &PrincipalId,
) {
    let fresh_owner = AccountContext::new(
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
    let tainted_owner = AccountContext::new(fresh_owner.auth().with_staged_taint(), budget());
    tainted_owner.auth().taint().mark_external_read();

    let pinned_owner = AccountContext::new(
        fresh_owner.auth().restrict_to_project(sa_p1).unwrap(),
        budget(),
    );
    let agent_run_ctx = AccountContext::new(
        fresh_owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xD3; 16]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                fresh_owner.auth().spaces().clone(),
            )
            .unwrap(),
        budget(),
    );
    let keeper_ctx = AccountContext::new(
        fresh_owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([0xD4; 16]),
                pscope.space_id.clone(),
                None,
                BTreeSet::new(),
            )
            .unwrap(),
        budget(),
    );

    assert!(matches!(
        fixture
            .control
            .list_pats(
                pinned_owner.clone(),
                actor.clone(),
                ControlPageRequest::new(10, None).unwrap()
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        provider
            .list_credentials(
                pinned_owner.clone(),
                ControlPageRequest::new(10, None).unwrap()
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .telemetry_settings(pinned_owner.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let sa_tainted =
        SpaceContext::new(tainted_owner.auth().clone(), sa_history.clone(), budget()).unwrap();
    let sa_pinned =
        SpaceContext::new(pinned_owner.auth().clone(), sa_history.clone(), budget()).unwrap();
    assert!(matches!(
        fixture
            .control
            .change_space_lifecycle(
                sa_tainted,
                SpaceLifecycleChange {
                    command: CommandKey::from_bytes([
                        0xD3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
                    ]),
                    expected: ControlRevision::ZERO,
                    lifecycle: notarium_core::auth::SpaceLifecycle::Archived,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    assert!(matches!(
        fixture
            .control
            .change_space_lifecycle(
                sa_pinned.clone(),
                SpaceLifecycleChange {
                    command: CommandKey::from_bytes([
                        0xD3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2
                    ]),
                    expected: ControlRevision::ZERO,
                    lifecycle: notarium_core::auth::SpaceLifecycle::Archived,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        provider
            .list_offers(
                sa_pinned,
                notarium_core::ports::ProviderOfferQuery {
                    project: None,
                    page: ControlPageRequest::new(10, None).unwrap(),
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    for (label, caller) in [
        ("pinned", pinned_owner.clone()),
        ("agent_run", agent_run_ctx),
        ("keeper", keeper_ctx),
    ] {
        assert!(
            matches!(
                fixture
                    .control
                    .list_agent_calls(caller.clone(), ControlPageRequest::new(10, None).unwrap())
                    .await,
                Err(PortError::Domain(DomainError::AccessDenied))
            ),
            "{label} must not list account-wide agent calls"
        );
        assert!(
            matches!(
                provider
                    .inspect_call(caller, RequestId::from_bytes([0xD3; 16]))
                    .await,
                Err(PortError::Domain(DomainError::AccessDenied))
            ),
            "{label} must not inspect account-wide provider calls"
        );
    }
    for (label, caller, expected_taint) in [
        ("tainted", tainted_owner, true),
        ("pinned", pinned_owner, false),
    ] {
        let fav_err = fixture
            .control
            .set_favorite(
                caller,
                AccountMutation {
                    identity: AccountCommandIdentity {
                        owner: actor.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xD3,
                            if expected_taint { 10 } else { 11 },
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            1,
                        ]),
                        hash: ContentDigest::from_bytes(
                            [if expected_taint { 0xD3 } else { 0xD4 }; 32],
                        ),
                        expected: ControlRevision::ZERO,
                    },
                    input: notarium_core::ports::SetFavorite {
                        reference: notarium_core::ports::FavoriteRef::Folder(sa_p1.clone()),
                        saved: false,
                        rank: 0,
                    },
                },
            )
            .await;
        if expected_taint {
            assert!(
                matches!(
                    fav_err,
                    Err(PortError::Domain(DomainError::CrossSpaceTainted))
                ),
                "{label} set_favorite must fail with CrossSpaceTainted: {fav_err:?}"
            );
        } else {
            assert!(
                matches!(fav_err, Err(PortError::Domain(DomainError::AccessDenied))),
                "{label} set_favorite must fail with AccessDenied: {fav_err:?}"
            );
        }
    }
}

async fn delta_log_and_seed_with_tainted_chat_assertions(
    fixture: &RuntimeFixture,
    pscope: &HistoryScope,
    actor: &PrincipalId,
) {
    let setup_owner = fresh_owner(fixture).await;
    let setup_personal =
        SpaceContext::new(setup_owner.auth().clone(), pscope.clone(), budget()).unwrap();

    // First: a Space with a tainted chat thread (no purge yet -> ChangeRead::Log)
    // must NOT taint a clean human caller calling start_session (delta discards threads).
    let tainted_thread = ChatThreadId::from_bytes([0xD5; 16]);
    fixture
        .canonical
        .create_chat(
            setup_personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xD5; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: tainted_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Tainted delta thread".into(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .append_chat(
            setup_personal,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xD6; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: tainted_thread,
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("tainted note in personal chat".into()),
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    proposed_effect: None,
                    referenced_notes: Vec::new(),
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();

    let clean_log_caller = fresh_owner(fixture).await;
    let mut log_resp = fixture
        .registry
        .call_tool(
            McpInvocationContext {
                account: clean_log_caller.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xD5, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "start_session",
            json!({ "task": "clean-log-with-tainted-chat" }),
        )
        .await
        .unwrap()
        .structured_content;
    let mut log_step = 2u8;
    while let Some(cont) = log_resp["delta"]["continuation"].as_str() {
        log_resp = fixture
            .registry
            .call_tool(
                McpInvocationContext {
                    account: clean_log_caller.clone(),
                    target: EgressTarget::ExternalMcp,
                    request_key: CommandKey::from_bytes([
                        0xD5, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, log_step,
                    ]),
                },
                "start_session",
                json!({ "continuation": cont }),
            )
            .await
            .unwrap()
            .structured_content;
        log_step = log_step.checked_add(1).unwrap();
        assert!(log_step < 32, "delta log continuation loop exceeded bound");
    }
    assert!(
        !clean_log_caller.auth().taint().is_tainted(),
        "start_session ChangeRead::Log must not taint a clean human caller via discarded chat threads"
    );

    // Second: after a note purge (triggering PurgeResync -> ChangeRead::Seed),
    // start_session must likewise leave a clean human caller untainted.
    let purge_owner = fresh_owner(fixture).await;
    let purge_personal =
        SpaceContext::new(purge_owner.auth().clone(), pscope.clone(), budget()).unwrap();
    let purge_note_id = NoteId::from_bytes([0xD5; 16]);
    let purge_created = fixture
        .canonical
        .create_note(
            purge_personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xD7; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: purge_note_id.clone(),
                    parent: None,
                    slug: "purge-resync-trigger".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Purge Resync Trigger\n\ntrigger seed fallback\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let purge_trashed = fixture
        .canonical
        .delete_note(
            purge_personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xD8; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(purge_created.value.revision),
                    ..Preconditions::default()
                },
                input: DeleteNote {
                    note: purge_note_id.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .delete_note(
            purge_personal,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xD5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                    ]),
                    hash: ContentDigest::from_bytes([0xD9; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(purge_trashed.value.revision),
                    ..Preconditions::default()
                },
                input: DeleteNote {
                    note: purge_note_id,
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();

    let clean_caller = fresh_owner(fixture).await;
    let mut resp = fixture
        .registry
        .call_tool(
            McpInvocationContext {
                account: clean_caller.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xD5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "start_session",
            json!({ "task": "clean-seed-after-purge" }),
        )
        .await
        .unwrap()
        .structured_content;
    let mut step_idx = 2u8;
    while let Some(cont) = resp["delta"]["continuation"].as_str() {
        resp = fixture
            .registry
            .call_tool(
                McpInvocationContext {
                    account: clean_caller.clone(),
                    target: EgressTarget::ExternalMcp,
                    request_key: CommandKey::from_bytes([
                        0xD5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, step_idx,
                    ]),
                },
                "start_session",
                json!({ "continuation": cont }),
            )
            .await
            .unwrap()
            .structured_content;
        step_idx = step_idx.checked_add(1).unwrap();
        assert!(step_idx < 32, "delta continuation loop exceeded bound");
    }
    assert!(
        !clean_caller.auth().taint().is_tainted(),
        "start_session Seed after PurgeResync must not taint a clean human caller via discarded chat threads"
    );
}

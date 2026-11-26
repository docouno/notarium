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

fn deterministic_episode_id(
    actor: &PrincipalId,
    space_id: &SpaceId,
    thread: &ChatThreadId,
) -> EpisodeId {
    let mut hash = blake3::Hasher::new_derive_key("notarium.chats.episode.v1");
    for part in [
        space_id.as_str().as_bytes(),
        thread.as_str().as_bytes(),
        actor.as_str().as_bytes(),
    ] {
        hash.update(&(part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    let digest = hash.finalize();
    EpisodeId::from_bytes(digest.as_bytes()[..16].try_into().expect("sixteen bytes"))
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_control_replay_and_taint_hardening() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(run_control_replay_and_taint_hardening(false)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_control_replay_and_taint_hardening() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(run_control_replay_and_taint_hardening(true)).await;
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

    // (1) list_notes on AgentMemory-only Space: missing path returns empty AND
    //     commits BranchTaint (closing the 1-bit cross-Space folder-existence oracle),
    //     invalid cursor fails CursorStale without taint, and listing root hides
    //     UserDoc items, nextCursor, and incomplete!
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
        missing_auth.taint().is_tainted(),
        "list_notes probing a missing path inside a consented cross-Space project MUST commit BranchTaint"
    );

    // Invalid cursor on a consented cross-Space folder must reject before
    // probing canonical folders or flipping BranchTaint.
    let (bad_cursor_auth, bad_cursor_acc) = make_run(99);
    let stale_cursor_err = local
        .registry
        .call_tool(
            make_ctx(&bad_cursor_acc, 3),
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
        !bad_cursor_auth.taint().is_tainted(),
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

    // (2) Direct cross-space write tools from a pinned run (without proposal routing)
    //     MUST resolve strictly within the pinned write Space and return uniform
    //     ResourceNotFound without flipping BranchTaint (zero cross-Space existence oracle).
    let (write_auth, write_acc) = make_run(3);
    for (idx, (tool, args)) in [
        ("delete_note", json!({ "ref": write_note })),
        (
            "delete_note",
            json!({ "ref": NoteId::from_bytes([0x89, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) }),
        ),
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
            "rename_project",
            json!({
                "project": format!("{}/missing-proj", space_write.slug),
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
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "cross-space direct {tool} must fail uniformly with ResourceNotFound, got {:?}",
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

    // (4) list_abilities(source: "system", q: ...) reads no foreign Space ability
    //     bodies and stays untainted, while an unscoped cross-Space `q` miss that
    //     evaluates consented foreign Space ability bodies MUST commit BranchTaint
    //     so repeated misses cannot brute-force foreign ability names/descriptions.
    let (ab_sys_auth, ab_sys_acc) = make_run(5);
    let ab_sys_res = local
        .registry
        .call_tool(
            make_ctx(&ab_sys_acc, 20),
            "list_abilities",
            json!({ "view": "runtime", "source": "system", "limit": 50, "q": "nonexistent-needle-xyz" }),
        )
        .await
        .unwrap();
    assert_eq!(ab_sys_res.structured_content["items"], json!([]));
    assert!(
        !ab_sys_auth.taint().is_tainted(),
        "list_abilities(source: system) with no foreign reads must not flip BranchTaint"
    );
    let (ab_auth, ab_acc) = make_run(6);
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
        ab_auth.taint().is_tainted(),
        "cross-Space list_abilities q miss over consented foreign ability body MUST commit BranchTaint"
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

    // (5) Budget-exceeded cross-Space use_role reads the foreign ability body to
    //     compare its byte length against budgetTokens and MUST commit BranchTaint
    //     even on BudgetExceeded (closing the untainted byte-length/existence oracle).
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
        budget_auth.taint().is_tainted(),
        "budget-rejected cross-Space use_role MUST commit BranchTaint (no byte-length oracle)"
    );
    // Positive control on a fresh run: raising budgetTokens delivers the role
    // and flips cross-Space BranchTaint.
    let (budget_ok_auth, budget_ok_acc) = make_run(7);
    let budget_ok = local
        .registry
        .call_tool(
            make_ctx(&budget_ok_acc, 25),
            "use_role",
            json!({ "role": write_role_ref, "budgetTokens": 500 }),
        )
        .await
        .unwrap();
    assert_eq!(budget_ok.structured_content["name"], "write-space-role");
    assert!(
        budget_ok_auth.taint().is_tainted(),
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
        // Create a Personal chat anchored in Shared Space `s_po/po_p1` and verify
        // both `use_role` (from Personal Space, activating the Personal fallback)
        // and `bind_chat_role` (on the Shared-Space thread, rejecting both the
        // unconsented `po_p2`-promoted role and the cross-Space Personal role).
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
        let _po_run = supervisor
            .start(
                owner.clone(),
                StartChatRun {
                    scope: s_po.history.clone(),
                    thread: po_thread.clone(),
                    expected_leaf: po_msg.value.seq,
                    options: base_opts(Some("promo-shadow-role")),
                },
            )
            .await
            .expect("supervisor.start should claim turn before async bind_chat_role rejects");
        let leaf = idle_leaf(fixture, &po_scope, &po_thread).await;
        assert_eq!(
            leaf.get(),
            1,
            "shared chat must not bind unconsented promoted role or cross-space personal role"
        );
        let po_ep_id = deterministic_episode_id(&actor, &s_po.history.space_id, &po_thread);
        match fixture.control.get_episode(owner.clone(), po_ep_id).await {
            Ok(po_ep) => assert!(
                po_ep.active_role.is_none(),
                "rejected role binding must leave episode active_role unset: {po_ep:?}"
            ),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
            Err(other) => {
                panic!("unexpected get_episode error on rejected role binding: {other:?}")
            }
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
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    Box::pin(verify_out_of_project_schedule_update_not_found(
        fixture,
        &owner,
        &owner_p1_only,
        &schedule_id,
        created_sched.value.revision,
        &sched_def,
        &s1_p1,
        next_slot,
    ))
    .await;
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
        Err(PortError::Domain(DomainError::ResourceNotFound))
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

    let _ = p_proj;
    box_step(|| {
        shared_chat_and_post_trash_seams(
            fixture,
            personal,
            owner,
            actor,
            &pscope,
            &listener,
            &local,
            &run_acc,
            &s1,
            s1_sc,
            &s2,
            s2_p1.clone(),
            s2_p2.clone(),
        )
    })
    .await;
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn shared_chat_and_post_trash_seams(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
    owner: AccountContext,
    actor: PrincipalId,
    pscope: &HistoryScope,
    listener: &TcpListener,
    local: &LoopbackProvider,
    run_acc: &AccountContext,
    s1: &AccessibleSpace,
    s1_sc: SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: FolderRef,
    s2_p2: FolderRef,
) {
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
    let _started_bad = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: s1.history.clone(),
                thread: shared_chat.clone(),
                expected_leaf: ThreadEntrySeq::new(1).unwrap(),
                options: bad_role_opts,
            },
        )
        .await
        .expect("supervisor.start should claim turn before async bind_chat_role rejects");
    let leaf = idle_leaf(fixture, &s1_sc, &shared_chat).await;
    assert_eq!(
        leaf.get(),
        1,
        "cross-space personal role must fail before append"
    );
    let shared_ep_id = deterministic_episode_id(&actor, &s1.history.space_id, &shared_chat);
    match fixture
        .control
        .get_episode(owner.clone(), shared_ep_id)
        .await
    {
        Ok(shared_ep) => assert!(
            shared_ep.active_role.is_none(),
            "rejected cross-space personal role must leave episode active_role unset: {shared_ep:?}"
        ),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
        Err(other) => {
            panic!("unexpected get_episode error on rejected cross-space personal role: {other:?}")
        }
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
    let (mut wire1, prompt1) = timeout(Duration::from_secs(15), read_request(listener))
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
    // must admit BOTH explicitly consented project_only skills per-project and complete cleanly!
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
    let (mut wire2, prompt2) = timeout(Duration::from_secs(15), read_request(listener))
        .await
        .expect("personal chat must admit both consented project_only skills and reach provider");
    let prompt2_text = prompt2.to_string();
    assert!(
        prompt2_text.contains("PERSONAL-TWO-SEC-ROLE-MARKER")
            && prompt2_text.contains("S2-PROJ-A-SKILL-MARKER")
            && prompt2_text.contains("S2-PROJ-B-CONFLICT-SECRET"),
        "must include role + both consented s2/proj-a and s2/proj-b skills: {prompt2_text}"
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
    let sb_sel = local
        .provider
        .select_provider(
            sb_scope.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: Some(sb_p1.clone()),
            },
        )
        .await
        .unwrap();
    let beta_ep_id = deterministic_episode_id(&actor, &sb.history.space_id, &beta_thread);
    let beta_run_id = AgentRunId::from_bytes([0xD2, 64, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let beta_run_auth = owner
        .auth()
        .for_agent_run(
            beta_run_id.clone(),
            sb.history.space_id.clone(),
            ChatAudience::Shared,
            owner.auth().spaces().clone(),
        )
        .unwrap()
        .restrict_to_project(&sb_p1)
        .unwrap();
    let beta_run_scope = SpaceContext::new(beta_run_auth, sb.history.clone(), budget()).unwrap();
    let direct_beta_err = notarium_agents::mcp::bind_chat_role_for_test(
        &local.registry,
        owner.clone(),
        beta_run_scope,
        &sb_sel,
        &beta_ep_id,
        &old_beta_ar1,
        Some(&sb_p1),
        &beta_run_id,
    )
    .await;
    assert!(
        matches!(
            direct_beta_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "disabled promoted ar1: outside project_only must collapse to ResourceNotFound (never InvalidState), got {direct_beta_err:?}"
    );
    let _started_beta = supervisor
        .start(
            owner.clone(),
            StartChatRun {
                scope: sb.history.clone(),
                thread: beta_thread.clone(),
                expected_leaf: beta_msg,
                options: run_opts(Some(&old_beta_ar1)),
            },
        )
        .await
        .expect("supervisor.start claims turn before async bind_chat_role rejects");
    let beta_leaf = idle_leaf(fixture, &sb_scope, &beta_thread).await;
    assert_eq!(
        beta_leaf, beta_msg,
        "rejected disabled promoted ar1: must not append assistant output"
    );
    match fixture.control.get_episode(owner.clone(), beta_ep_id).await {
        Ok(ep) => assert!(
            ep.active_role.is_none(),
            "rejected disabled promoted ar1: must leave episode active_role unset: {ep:?}"
        ),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
        Err(other) => panic!("unexpected get_episode error on rejected promoted ar1:: {other:?}"),
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

async fn run_control_replay_and_taint_hardening(pg: bool) {
    let mut fixture = RuntimeFixture::open_named(pg, "control_replay_taint_hardening").await;
    let personal = fixture.personal_scope().await;
    let owner = fresh_owner(&fixture).await;
    let actor = owner.auth().principal().clone();

    let s1 = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(&fixture, &owner, 0xE1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xE1; 16]),
                    kind: SpaceKind::Shared,
                    name: "Hardening Shared One".into(),
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
                identity: identity(&fixture, &owner, 0xE2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xE2; 16]),
                    kind: SpaceKind::Shared,
                    name: "Hardening Shared Two".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner = fresh_owner(&fixture).await;

    let s1_p1 = create_project_folder(
        &fixture,
        &s1.history,
        &actor,
        FolderId::from_bytes([0xE1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "h-s1-p1",
    )
    .await;
    let s1_p2 = create_project_folder(
        &fixture,
        &s1.history,
        &actor,
        FolderId::from_bytes([0xE1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "h-s1-p2",
    )
    .await;
    let s2_p1 = create_project_folder(
        &fixture,
        &s2.history,
        &actor,
        FolderId::from_bytes([0xE2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        "h-s2-p1",
    )
    .await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(&fixture, &owner, &listener, 0xE3, false).await;

    box_step(|| {
        provider_visibility_pat_space_and_check_connection_hardening(
            &mut fixture,
            &local,
            personal.scope(),
            &s1.history,
            &s2.history,
            &s1_p1,
            &actor,
        )
    })
    .await;

    box_step(|| {
        episodes_context_and_ability_overlay_replay_hardening(
            &fixture,
            personal.scope(),
            &s1.history,
            &s2.history,
            &s1_p1,
            &s1_p2,
            &s2_p1,
            &actor,
        )
    })
    .await;

    box_step(|| {
        mcp_taint_folder_replay_and_ability_edit_hardening(
            &mut fixture,
            &local,
            &personal,
            &s1,
            &s2,
            &s1_p1,
            &s1_p2,
            &s2_p1,
            &actor,
        )
    })
    .await;

    box_step(|| {
        authority_cursors_oracles_and_trashed_ancestry_hardening(
            &mut fixture,
            &local,
            &personal,
            &s1,
            &s2,
            &s1_p1,
            &s1_p2,
            &s2_p1,
            &actor,
        )
    })
    .await;

    fixture.close().await;
}

#[allow(clippy::too_many_arguments)]
async fn provider_visibility_pat_space_and_check_connection_hardening(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    pscope: &HistoryScope,
    s1_history: &HistoryScope,
    s2_history: &HistoryScope,
    s1_p1: &FolderRef,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    // Create a second member Carol (Editor in s1) who attaches her own private
    // provider resource via Personal consent inside s1 without offering it to s1.
    let carol_info = fixture
        .control
        .create_account(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x70).await,
                input: NewAccount {
                    username: "carol_provider_iso".into(),
                    email: None,
                    display_name: "Carol".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let carol_id = carol_info.id.clone();
    let membership_cmd =
        CommandKey::from_bytes([0xE4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s1_owner_ctx =
        SpaceContext::new(owner.auth().clone(), s1_history.clone(), budget()).unwrap();
    let membership_req = MembershipChange {
        command: membership_cmd,
        expected: ControlRevision::ZERO,
        member: carol_id.clone(),
        role: Some(SpaceRole::Editor),
    };
    let added = fixture
        .control
        .change_membership(s1_owner_ctx, membership_req.clone())
        .await
        .unwrap();
    let carol_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &carol_id,
            &AuthSessionId::from_bytes([0xE4; 16]),
            &carol_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let carol_auth = fixture
        .control
        .resolve(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(
                AuthEvidenceKind::Session,
                carol_token.secret.expose().to_owned(),
            )
            .with_human_management()
            .with_ability_write(),
        })
        .await
        .unwrap();
    let carol_ctx = AccountContext::new(carol_auth, budget());

    let carol_res_id =
        ProviderResourceId::from_bytes([0xE4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let carol_res = local
        .provider
        .create_resource(
            carol_ctx.clone(),
            AccountMutation {
                identity: identity(fixture, &carol_ctx, 1).await,
                input: ProviderResourceSpec {
                    id: carol_res_id.clone(),
                    name: "Carol Private Provider".into(),
                    wire: ProviderWireKind::OpenaiCompatible,
                    base_url: "https://api.example.com/v1".into(),
                    credential: None,
                    headers: Vec::new(),
                    limits: ProviderLimits::default(),
                    timeout_ms: 1_000,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let carol_model_id =
        ModelProfileId::from_bytes([0xE4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    local
        .provider
        .put_model(
            carol_ctx.clone(),
            AccountMutation {
                identity: identity(fixture, &carol_ctx, 2).await,
                input: PutProviderModel {
                    resource: carol_res_id.clone(),
                    expected: carol_res.revision,
                    model: ProviderModelSpec {
                        id: carol_model_id.clone(),
                        wire_name: "carol-private-model".into(),
                        kind: ProviderModelKind::Completion,
                        accounting: TokenAccountingProfile::ConservativeModelCapV1,
                        max_input_tokens: 4096,
                        max_output_tokens: 1024,
                        tools: true,
                    },
                    default: true,
                },
            },
        )
        .await
        .unwrap();
    let carol_att_id = RequestId::from_bytes([0xE4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let carol_att = local
        .provider
        .request_attachment(
            carol_ctx.clone(),
            AccountMutation {
                identity: identity(fixture, &carol_ctx, 3).await,
                input: RequestProviderAttachment {
                    id: carol_att_id.clone(),
                    expected: None,
                    resource: carol_res_id.clone(),
                    resource_consent_epoch: carol_res.consent_epoch + 1,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: carol_id.clone(),
                        space: s1_history.space_id.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: BTreeSet::from([DocClass::UserDoc]),
                    }),
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;

    // Space owner Bob MUST NOT see Carol's private Personal attachment, resource, or models.
    assert!(matches!(
        local
            .provider
            .inspect_attachment(owner.clone(), carol_att_id.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        local
            .provider
            .list_attachments(
                owner.clone(),
                carol_res_id.clone(),
                ControlPageRequest::new(10, None).unwrap()
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        local
            .provider
            .list_models(
                owner.clone(),
                carol_res_id.clone(),
                ControlPageRequest::new(10, None).unwrap()
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        local
            .provider
            .set_preference(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x71).await,
                    input: SetProviderPreference {
                        scope: ProviderPreferenceScope::Personal,
                        kind: PreferenceModelKind::Completion,
                        resource: carol_res_id.clone(),
                        model: carol_model_id.clone(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    // Space-narrowed DirectHuman (only personal space) must NOT see s1 shared attachments
    // on a resource owned by Carol, nor approve/revoke foreign or missing attachments
    // with distinguishing errors.
    let missing_att_id = RequestId::from_bytes([0xE4, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    let missing_space_id = SpaceId::from_bytes([0xE4, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]);
    assert!(matches!(
        local
            .provider
            .approve_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x72).await,
                    input: ApproveProviderAttachment {
                        id: carol_att.id.clone(),
                        expected: carol_att.revision,
                        resource_consent_epoch: carol_att.resource_consent_epoch,
                        credential_consent_epoch: carol_att.credential_consent_epoch,
                        consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                            classes: BTreeSet::from([DocClass::UserDoc]),
                        }),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .approve_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x73).await,
                    input: ApproveProviderAttachment {
                        id: missing_att_id.clone(),
                        expected: ControlRevision::ZERO,
                        resource_consent_epoch: 1,
                        credential_consent_epoch: None,
                        consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                            classes: BTreeSet::from([DocClass::UserDoc]),
                        }),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .revoke_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x74).await,
                    input: RevokeProviderAttachment {
                        id: carol_att.id.clone(),
                        expected: carol_att.revision,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .revoke_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x75).await,
                    input: RevokeProviderAttachment {
                        id: missing_att_id,
                        expected: ControlRevision::ZERO,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x76).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([0xEA; 16]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
                        credential_consent_epoch: None,
                        target: ProviderAttachmentTarget::Space(missing_space_id),
                        consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                            classes: BTreeSet::from([DocClass::UserDoc]),
                        }),
                        expires_at_ms: None,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // check_connection rejects project-pinned humans before existing_read and collapses
    // missing vs foreign ProviderResourceId to ResourceNotFound.
    let pinned_owner =
        AccountContext::new(owner.auth().restrict_to_project(s1_p1).unwrap(), budget());
    assert!(matches!(
        local
            .provider
            .check_connection(
                pinned_owner.clone(),
                CheckProviderConnection {
                    resource: local.resource.id.clone(),
                    intent: CommandKey::from_bytes([0xEB; 16]),
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let missing_res_id = ProviderResourceId::from_bytes([0xEB; 16]);
    for probe_res in [&carol_res_id, &missing_res_id] {
        assert!(matches!(
            local
                .provider
                .check_connection(
                    owner.clone(),
                    CheckProviderConnection {
                        resource: probe_res.clone(),
                        intent: CommandKey::from_bytes([0xEC; 16]),
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }

    // Space-narrowed DirectHuman cannot mint PATs covering excluded Spaces or all spaces,
    // and revoke_pat collapses missing vs foreign token_id to ResourceNotFound.
    let only_personal = AccountContext::new(
        owner
            .auth()
            .restrict_to_spaces(&BTreeSet::from([pscope.space_id.clone()])),
        budget(),
    );
    let owner_rev = fixture
        .control
        .account(owner.clone(), actor.clone())
        .await
        .unwrap()
        .revision;
    assert!(matches!(
        fixture
            .control
            .create_pat(
                only_personal.clone(),
                CreatePat {
                    name: "narrowed-pat-all".into(),
                    scope: BearerScope::Write,
                    ability_write: false,
                    selected_spaces: None,
                    expires_at_ms: None,
                    expected: owner_rev,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .create_pat(
                only_personal.clone(),
                CreatePat {
                    name: "narrowed-pat-excluded".into(),
                    scope: BearerScope::Write,
                    ability_write: false,
                    selected_spaces: Some(vec![s1_history.space_id.clone()]),
                    expires_at_ms: None,
                    expected: owner_rev,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let carol_rev = fixture
        .control
        .account(carol_ctx.clone(), carol_id.clone())
        .await
        .unwrap()
        .revision;
    let carol_pat = fixture
        .control
        .create_pat(
            carol_ctx.clone(),
            CreatePat {
                name: "carol-pat".into(),
                scope: BearerScope::Read,
                ability_write: false,
                selected_spaces: None,
                expires_at_ms: None,
                expected: carol_rev,
            },
        )
        .await
        .unwrap()
        .value;
    let missing_pat = CredentialTokenId::parse("deadbeef0001").unwrap();
    for (idx, probe_pat) in [carol_pat.metadata.id, missing_pat].into_iter().enumerate() {
        assert!(matches!(
            fixture
                .control
                .revoke_pat(
                    owner.clone(),
                    AccountMutation {
                        identity: identity(fixture, &owner, 0x77 + idx as u8).await,
                        input: RevokePat {
                            account: actor.clone(),
                            token: probe_pat,
                        },
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }

    // resume_membership_change rejects tainted & project-pinned DirectHuman.
    let tainted_owner = AccountContext::new(owner.auth().with_staged_taint(), budget());
    tainted_owner.auth().taint().mark_external_read();
    assert!(matches!(
        fixture
            .control
            .resume_membership_change(tainted_owner, s1_history.clone(), membership_req.clone(),)
            .await,
        Err(PortError::Domain(DomainError::CrossSpaceTainted))
    ));
    assert!(matches!(
        fixture
            .control
            .resume_membership_change(pinned_owner, s1_history.clone(), membership_req)
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    // Non-member Carol calling admit_space_management on s2 (where she is not a member)
    // gets ResourceNotFound matching a nonexistent Space.
    let carol_s2_err = fixture
        .control
        .admit_space_management(carol_ctx.clone(), s2_history.clone())
        .await;
    assert!(matches!(
        carol_s2_err,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let _ = added;
    let _ = actor;
}

#[allow(clippy::too_many_arguments)]
async fn episodes_context_and_ability_overlay_replay_hardening(
    fixture: &RuntimeFixture,
    pscope: &HistoryScope,
    s1_history: &HistoryScope,
    _s2_history: &HistoryScope,
    s1_p1: &FolderRef,
    s1_p2: &FolderRef,
    s2_p1: &FolderRef,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    let ep_s1_p2 = EpisodeId::from_bytes([0xE5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let ep_s2 = EpisodeId::from_bytes([0xE5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let created_p2 = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xF0).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_s1_p2.clone(),
                        name: Some("ep-p2".into()),
                    },
                    project_hint: Some(s1_p2.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let EpisodeStartResult::New(ep_p2_info) = created_p2.value else {
        panic!("expected new episode");
    };
    fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xF1).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: ep_s2.clone(),
                        name: Some("ep-s2".into()),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();

    // Narrowed caller pinned to s1_p1 must not start/resume/fork/update/touch/ack ep_s1_p2
    // or ep_s2, nor create an unscoped (project_hint: None) episode, nor ack delta with
    // project_root or partial read_classes.
    let pinned_p1 = AccountContext::new(owner.auth().restrict_to_project(s1_p1).unwrap(), budget());
    let only_s1 = AccountContext::new(
        owner
            .auth()
            .restrict_to_spaces(&BTreeSet::from([s1_history.space_id.clone()])),
        budget(),
    );
    assert!(matches!(
        fixture
            .control
            .start_or_resume_episode(
                pinned_p1.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xF2).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::Resume(ep_s1_p2.clone()),
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Target,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let s1_named_new = fixture
        .control
        .start_or_resume_episode(
            only_s1.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xF3).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Name("ep-s2".into()),
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .expect("narrowed caller starting episode with hidden excluded-Space name must create New instead of leaking existence");
    match s1_named_new.value {
        EpisodeStartResult::New(ep) => {
            assert_ne!(
                ep.id, ep_s2,
                "must not resume hidden excluded-Space episode"
            );
            assert!(ep.project_hint.is_none());
        }
        other => panic!("expected EpisodeStartResult::New, got {other:?}"),
    }
    assert!(matches!(
        fixture
            .control
            .start_or_resume_episode(
                pinned_p1.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xF4).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: EpisodeId::from_bytes([0xE5; 16]),
                            name: None,
                        },
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .update_episode(
                pinned_p1.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xF5).await,
                    input: EpisodeMutation::Full(EpisodeUpdate {
                        episode: ep_s1_p2.clone(),
                        expected: ep_p2_info.revision,
                        name: Some("hijacked".into()),
                        active_role: None,
                        project_hint: Some(s1_p1.clone()),
                        lifecycle: EpisodeLifecycle::Closed,
                    }),
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .touch_episode(pinned_p1.clone(), ep_s1_p2.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let real_pat = fixture.pat(BearerScope::Write, false).await;
    let mut partial_grants = real_pat.auth().spaces().clone();
    partial_grants
        .get_mut(&s1_history.space_id)
        .unwrap()
        .read_classes
        .remove(&DocClass::Skill);
    let partial_read =
        AccountContext::new(real_pat.auth().for_pat(partial_grants).unwrap(), budget());
    for restricted in [pinned_p1.clone(), partial_read] {
        assert!(matches!(
            fixture
                .control
                .acknowledge_delta(
                    restricted,
                    AccountMutation {
                        identity: identity(fixture, &owner, 0xF6).await,
                        input: AcknowledgeDelta {
                            owner: AckOwner::Account,
                            delivered: notarium_core::receipt::ChangeCursor {
                                scope: s1_history.clone(),
                                after: SpaceSeq::ZERO,
                            },
                        },
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }

    // context_state: project-pinned caller cannot read Space/Personal scope or see hidden
    // ContextSetIds in list_context_sets continuation cursors, nor mutate via delete/attach.
    let set_hidden = ContextSetId::from_bytes([0xE6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let set_visible = ContextSetId::from_bytes([0xE6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let set_visible_2 =
        ContextSetId::from_bytes([0xE6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let mut created_sets = Vec::new();
    for (idx, sid) in [&set_hidden, &set_visible, &set_visible_2]
        .into_iter()
        .enumerate()
    {
        let res = fixture
            .control
            .put_context_set(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xA0 + idx as u8).await,
                    input: PutContextSet {
                        id: sid.clone(),
                        home: s1_history.space_id.clone(),
                        expected: None,
                        name: format!("Set {idx}"),
                        notes: vec![],
                    },
                },
            )
            .await
            .unwrap()
            .value;
        created_sets.push(res);
    }
    // Attach only set_visible and set_visible_2 to s1_p1; leave set_hidden unattached to s1_p1.
    let mut p1_scope_rev = fixture
        .control
        .context_scope(owner.clone(), ContextScope::Project(s1_p1.clone()))
        .await
        .unwrap()
        .revision;
    for (idx, set_info) in [&created_sets[1], &created_sets[2]].into_iter().enumerate() {
        let attached = fixture
            .control
            .set_context_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xA4 + idx as u8).await,
                    input: SetContextAttachment {
                        scope: ContextScope::Project(s1_p1.clone()),
                        expected: p1_scope_rev,
                        set: set_info.id.clone(),
                        set_revision: set_info.revision,
                        attached: true,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        p1_scope_rev = attached.revision;
    }
    assert!(matches!(
        fixture
            .control
            .context_scope(
                pinned_p1.clone(),
                ContextScope::Space(s1_history.space_id.clone())
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .list_context_entries(
                pinned_p1.clone(),
                ContextScope::Space(s1_history.space_id.clone()),
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let page1 = fixture
        .control
        .list_context_sets(
            pinned_p1.clone(),
            s1_history.space_id.clone(),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(page1.items.len(), 1);
    assert_eq!(page1.items[0].id, set_visible);
    let cont = page1
        .continuation
        .expect("second visible set yields continuation");
    assert!(
        !cont.contains(set_hidden.as_str()),
        "hidden set id must never leak in list_context_sets continuation cursor: {cont}"
    );
    assert!(matches!(
        fixture
            .control
            .delete_context_set(
                pinned_p1.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0xA8).await,
                    input: DeleteContextSet {
                        id: set_hidden.clone(),
                        expected: created_sets[0].revision,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    // Control update_ability_binding(Account) and set_ability_trail(Set) MUST replay
    // cleanly even after the target ability advances or is trashed.
    let s1_sc = SpaceContext::new(owner.auth().clone(), s1_history.clone(), budget()).unwrap();
    let ab_folder = FolderId::from_bytes([0xE7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s1_epoch = fixture
        .canonical
        .read_space(&s1_history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let (ab_ref_folder, _, _) = fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s1_history.clone(),
            active_epoch: s1_epoch,
            folder_id: ab_folder.clone(),
            parent: Some(s1_p1.folder_id.clone()),
            slug: "abilities".into(),
            display_name: "Abilities".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let ab_parent = ab_ref_folder.folder_id;
    let ab_note_a = NoteId::from_bytes([0xE7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let ab_id_a = AbilityId::from_bytes([0xE7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let created_n_a = fixture
        .canonical
        .create_note(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE7; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: ab_note_a.clone(),
                    parent: Some(ab_parent.clone()),
                    slug: "replay-bind-role".into(),
                    class: DocClass::Skill,
                    carrier: "---\nability_kind: role\ndescription: v1\n---\n# v1\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let pub_a = fixture
        .canonical
        .publish_ability_package(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE7; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: ab_id_a.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: ab_note_a.clone(),
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(created_n_a.revision.clone()),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let ab_ref_a = AbilityRef {
        id: ab_id_a.clone(),
        placement: AbilityPlacement::OwnedProject(s1_p1.clone()),
        revision: pub_a.revision.clone(),
    };
    let ab_note_b = NoteId::from_bytes([0xE7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let ab_id_b = AbilityId::from_bytes([0xE7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let created_n_b = fixture
        .canonical
        .create_note(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: ab_note_b.clone(),
                    parent: Some(ab_parent),
                    slug: "replay-trail-dest".into(),
                    class: DocClass::Skill,
                    carrier: "---\nability_kind: role\ndescription: dest\n---\n# dest\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let pub_b = fixture
        .canonical
        .publish_ability_package(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: ab_id_b.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: ab_note_b.clone(),
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(created_n_b.revision),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let ab_ref_b = AbilityRef {
        id: ab_id_b.clone(),
        placement: AbilityPlacement::OwnedProject(s1_p1.clone()),
        revision: pub_b.revision.clone(),
    };

    let bind_req = AccountMutation {
        identity: identity(fixture, &owner, 0xB0).await,
        input: AbilityBindingUpdate {
            ability: ab_ref_a.clone(),
            expected: AbilityOverlayGuard::Account(ControlRevision::ZERO),
            projects: AbilityProjects::All,
            enabled: false,
        },
    };
    let first_bind = fixture
        .control
        .update_ability_binding(owner.clone(), bind_req.clone())
        .await
        .unwrap();
    let trail_req = AccountMutation {
        identity: identity(fixture, &owner, 0xB1).await,
        input: AbilityTrailMutation::Set(AbilityTrailUpdate {
            source: ab_ref_a.clone(),
            expected_destination: None,
            destination: Some(ab_ref_b),
        }),
    };
    let first_trail = fixture
        .control
        .set_ability_trail(owner.clone(), trail_req.clone())
        .await
        .unwrap();

    // Trash ability A; exact retries of BOTH Account-guarded binding and Set trail must replay!
    fixture
        .canonical
        .trash_ability_package(
            s1_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: s1_history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(created_n_a.revision),
                    ..Preconditions::default()
                },
                input: TrashAbilityPackage {
                    ability: ab_id_a,
                    entrypoint: ab_note_a,
                    package_revision: pub_a.revision,
                },
            },
        )
        .await
        .unwrap();
    let replayed_bind = fixture
        .control
        .update_ability_binding(owner.clone(), bind_req)
        .await
        .expect("Account-guarded update_ability_binding must replay after ability is trashed");
    assert_eq!(replayed_bind.revision, first_bind.revision);
    assert!(replayed_bind.value.descriptor.is_none());
    let replayed_trail = fixture
        .control
        .set_ability_trail(owner, trail_req)
        .await
        .expect("Set set_ability_trail must replay after source ability is trashed");
    assert_eq!(replayed_trail.revision, first_trail.revision);
    let _ = pscope;
}

#[allow(clippy::too_many_arguments)]
async fn mcp_taint_folder_replay_and_ability_edit_hardening(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    personal: &SpaceContext,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
    s1_p2: &FolderRef,
    s2_p1: &FolderRef,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    let pscope = personal.scope().clone();
    let s1_sc = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let s2_sc = SpaceContext::new(owner.auth().clone(), s2.history.clone(), budget()).unwrap();
    let consent_all = || {
        ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
            classes: BTreeSet::from([DocClass::UserDoc, DocClass::Skill, DocClass::AgentMemory]),
        })
    };

    // Attach personal space (full), s1_p1 (project-only on s1!), and s2 (full) to local.resource.
    for (sub, target) in [
        (
            0xC0u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: pscope.space_id.clone(),
            },
        ),
        (
            0xC1u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s1.history.space_id.clone(),
            },
        ),
        (0xC2u8, ProviderAttachmentTarget::Project(s1_p1.clone())),
        (
            0xC3u8,
            ProviderAttachmentTarget::Personal {
                owner: actor.clone(),
                space: s2.history.space_id.clone(),
            },
        ),
        (
            0xC4u8,
            ProviderAttachmentTarget::Space(s2.history.space_id.clone()),
        ),
    ] {
        let att = local
            .provider
            .request_attachment(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, sub).await,
                    input: RequestProviderAttachment {
                        id: RequestId::from_bytes([
                            0xE8, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sub,
                        ]),
                        expected: None,
                        resource: local.resource.id.clone(),
                        resource_consent_epoch: local.resource.consent_epoch,
                        credential_consent_epoch: None,
                        target,
                        consent: consent_all(),
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
                        identity: identity(fixture, &owner, sub + 8).await,
                        input: ApproveProviderAttachment {
                            id: att.id,
                            expected: att.revision,
                            resource_consent_epoch: att.resource_consent_epoch,
                            credential_consent_epoch: att.credential_consent_epoch,
                            consent: consent_all(),
                        },
                    },
                )
                .await
                .unwrap();
        }
    }

    // (1) Link-free create_note / create_notes proposal targeting a write-locked subfolder
    //     in consented foreign Space s2 MUST commit external-read taint even on failure.
    let locked_sub = FolderId::from_bytes([0xE8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s2_epoch = fixture
        .canonical
        .read_space(&s2.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: locked_sub.clone(),
            parent: Some(s2_p1.folder_id.clone()),
            slug: "secret-locked".into(),
            display_name: "Secret Locked".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), locked_sub, true)
        .await
        .unwrap();
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);
    for (idx, (tool, args, expect_space_ro)) in [
        (
            "create_note",
            json!({
                "project": s2_p1_handle,
                "path": "secret-locked",
                "title": "Probe",
                "body": "link-free body",
            }),
            true,
        ),
        (
            "create_notes",
            json!({
                "project": s2_p1_handle,
                "notes": [{
                    "path": "secret-locked",
                    "title": "Batch Probe",
                    "body": "link-free batch",
                }],
            }),
            false,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let p_thread =
            ChatThreadId::from_bytes([0xE8, 2, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        fixture
            .canonical
            .create_chat(
                personal.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xE8, 2, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                        hash: ContentDigest::from_bytes([0xE8; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateChat {
                        thread: p_thread.clone(),
                        kind: ChatThreadKind::Personal,
                        owner: actor.clone(),
                        project_folder: None,
                        title: format!("Proposal probe thread {idx}"),
                    },
                },
            )
            .await
            .unwrap();
        let run_id =
            AgentRunId::from_bytes([0xE8, 3, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let run_auth = owner
            .auth()
            .for_agent_run(
                run_id.clone(),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let run_personal = SpaceContext::new(run_auth.clone(), pscope.clone(), budget()).unwrap();
        fixture
            .canonical
            .claim_active_run(
                run_personal.clone(),
                ClaimChatRun {
                    thread: p_thread.clone(),
                    expected_leaf: ThreadEntrySeq::ZERO,
                    run: run_id.clone(),
                    previous_run: None,
                },
            )
            .await
            .unwrap();
        let p_leaf = fixture
            .canonical
            .append_chat(
                run_personal,
                Mutation {
                    identity: CommandIdentity {
                        scope: pscope.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xE8, 2, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                        ]),
                        hash: ContentDigest::from_bytes([0xE8; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: AppendChat {
                        thread: p_thread.clone(),
                        parent: ThreadEntrySeq::ZERO,
                        kind: ChatEntryKind::Model,
                        body: ChatInputBody::Text("creating".into()),
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
            .unwrap()
            .value
            .seq;
        let err = local
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xE8, 3, idx as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                },
                PersonalToolInvocation {
                    source: pscope.clone(),
                    thread: p_thread.clone(),
                    leaf: p_leaf,
                    owner: owner.clone(),
                },
                tool,
                args,
            )
            .await;
        if expect_space_ro {
            assert!(
                matches!(err, Err(PortError::Domain(DomainError::SpaceReadOnly))),
                "{tool} against write-locked foreign subfolder must fail SpaceReadOnly, got {:?}",
                err.err()
            );
        } else {
            assert!(
                matches!(
                    err,
                    Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                        if diagnostic.reason == ValidationReason::InvalidQuery
                ),
                "{tool} against write-locked foreign subfolder must fail InvalidQuery, got {:?}",
                err.err()
            );
        }
        assert!(
            run_auth.taint().is_tainted(),
            "failed link-free {tool} proposal against foreign write-locked folder MUST commit BranchTaint"
        );
    }

    // (2) list_abilities in InAppProvider mode MUST commit BranchTaint both on `q` miss
    //     over a foreign Space ability AND on `limit: 1` lookahead `nextCursor`.
    local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "create_ability",
            json!({
                "kind": "role",
                "name": "aaa-personal-ability",
                "description": "Local personal role",
                "instructions": "Local instructions",
                "placement": { "home": "personal" },
            }),
        )
        .await
        .unwrap();
    let created_s2_role = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "create_ability",
            json!({
                "kind": "role",
                "name": "zzz-foreign-secret-ability",
                "description": "Secret foreign description token",
                "instructions": "Foreign instructions",
                "placement": { "home": "project", "project": s2_p1_handle },
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let s2_role_ref = created_s2_role["ref"].as_str().unwrap().to_owned();
    let s2_role_ver = created_s2_role["versionToken"].as_str().unwrap().to_owned();

    let miss_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xE8, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let miss_res = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(miss_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE8, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "kind": "role", "q": "no-such-needle-999", "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(miss_res["items"].as_array().unwrap().is_empty());
    assert!(
        miss_auth.taint().is_tainted(),
        "list_abilities q miss after reading foreign Space ability body MUST commit BranchTaint"
    );

    let lookahead_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xE8, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let lookahead_res = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(lookahead_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE8, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "kind": "role", "source": "owned", "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_eq!(lookahead_res["items"].as_array().unwrap().len(), 1);
    assert!(lookahead_res["nextCursor"].is_string());
    assert!(
        lookahead_auth.taint().is_tainted(),
        "list_abilities nextCursor lookahead triggered by foreign Space ability MUST commit BranchTaint"
    );

    // (3) Non-promoting edit_ability replays cleanly after subsequent promotion (OwnedProject -> OwnedSpace).
    let non_promo_key = CommandKey::from_bytes([0xE8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let edited_v2 = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: non_promo_key.clone(),
            },
            "edit_ability",
            json!({
                "ref": s2_role_ref,
                "versionToken": s2_role_ver,
                "description": "Updated before promotion",
                "instructions": "Instructions v2",
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let promoted_v3 = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "edit_ability",
            json!({
                "ref": edited_v2["ref"].as_str().unwrap(),
                "versionToken": edited_v2["versionToken"].as_str().unwrap(),
                "home": { "home": "space" },
                "availability": { "mode": "all-projects" },
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let replayed_non_promo = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: non_promo_key,
            },
            "edit_ability",
            json!({
                "ref": s2_role_ref,
                "versionToken": s2_role_ver,
                "description": "Updated before promotion",
                "instructions": "Instructions v2",
            }),
        )
        .await
        .expect("non-promoting edit_ability must replay cleanly after subsequent promotion")
        .structured_content;
    assert_eq!(replayed_non_promo["ref"], edited_v2["ref"]);

    // (4) bind_chat_role with pre-promotion ar1: token on a promoted Space-wide role in s2
    //     (while unrelated Space s1 has project_only) returns InvalidState (not ResourceNotFound!)
    //     when disabled, and SourceMismatch when stale; disabled built-in System Skill returns
    //     ResourceNotFound (wrong kind never leaks InvalidState).
    let disabled_v3 = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "edit_ability",
            json!({
                "ref": promoted_v3["ref"].as_str().unwrap(),
                "versionToken": promoted_v3["versionToken"].as_str().unwrap(),
                "enabled": false,
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let s2_sel = local
        .provider
        .select_provider(
            s2_sc.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let s2_bind_ep = EpisodeId::from_bytes([0xE8, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    let s2_bind_run = AgentRunId::from_bytes([0xE8, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]);
    let s2_run_auth = owner
        .auth()
        .for_agent_run(
            s2_bind_run.clone(),
            s2.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let s2_run_scope =
        SpaceContext::new(s2_run_auth.clone(), s2.history.clone(), budget()).unwrap();
    let disabled_bind_err = notarium_agents::mcp::bind_chat_role_for_test(
        &local.registry,
        owner.clone(),
        s2_run_scope.clone(),
        &s2_sel,
        &s2_bind_ep,
        edited_v2["ref"].as_str().unwrap(),
        None,
        &s2_bind_run,
    )
    .await;
    assert!(
        matches!(
            disabled_bind_err,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "disabled promoted Space-wide role via pre-promotion ar1: must return InvalidState (not ResourceNotFound), got {disabled_bind_err:?}"
    );
    // Re-enable and publish a newer revision v4 on the promoted role; binding the
    // stale pre-promotion ar1: token MUST return SourceMismatch (not ResourceNotFound).
    let reenabled_v4 = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "edit_ability",
            json!({
                "ref": disabled_v3["ref"].as_str().unwrap(),
                "versionToken": disabled_v3["versionToken"].as_str().unwrap(),
                "enabled": true,
                "instructions": "Promoted v4 instructions.",
            }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_ne!(reenabled_v4["ref"], promoted_v3["ref"]);
    let stale_bind_err = notarium_agents::mcp::bind_chat_role_for_test(
        &local.registry,
        owner.clone(),
        s2_run_scope.clone(),
        &s2_sel,
        &s2_bind_ep,
        edited_v2["ref"].as_str().unwrap(),
        None,
        &s2_bind_run,
    )
    .await;
    assert!(
        matches!(
            stale_bind_err,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::SourceMismatch
        ),
        "stale promoted Space-wide role via pre-promotion ar1: must return SourceMismatch, got {stale_bind_err:?}"
    );
    // Disabled built-in System Skill ar1: passed to bind_chat_role MUST return
    // ResourceNotFound (never InvalidState wrong-kind oracle).
    let sys_skills = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 6, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "source": "system", "kind": "skill", "limit": 10 }),
        )
        .await
        .unwrap()
        .structured_content;
    let sys_skill_item = sys_skills["items"]
        .as_array()
        .unwrap()
        .first()
        .expect("built-in system skill must exist");
    let sys_skill_ref = sys_skill_item["ref"].as_str().unwrap().to_owned();
    let sys_skill_name = sys_skill_item["name"].as_str().unwrap().to_owned();
    let sys_skill_ability_ref = match fixture
        .control
        .resolve_ability(
            owner.clone(),
            AbilitySelection::Name {
                name: sys_skill_name,
                kind: AbilityKind::Skill,
                project: None,
            },
        )
        .await
        .unwrap()
    {
        AbilityResolution::Resolved(desc) => desc.reference,
        other => panic!("expected built-in system skill, got {other:?}"),
    };
    fixture
        .control
        .set_ability_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xCE).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: sys_skill_ability_ref.clone(),
                        enabled: false,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let sys_skill_bind_err = notarium_agents::mcp::bind_chat_role_for_test(
        &local.registry,
        owner.clone(),
        s2_run_scope,
        &s2_sel,
        &s2_bind_ep,
        &sys_skill_ref,
        None,
        &s2_bind_run,
    )
    .await;
    assert!(
        matches!(
            sys_skill_bind_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "disabled System Skill ar1: in bind_chat_role must return ResourceNotFound (not InvalidState), got {sys_skill_bind_err:?}"
    );
    // Re-enable the built-in System Skill so later steps see clean default state.
    fixture
        .control
        .set_ability_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xCF).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: sys_skill_ability_ref,
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();

    // (5) rename_folder trashed replay MUST use live ancestry (trashed_folder_ancestry):
    //     moving a folder from consented s1_p1 into unconsented s1_p2 and trashing it
    //     must reject InAppProvider replay with ResourceNotFound.
    let movable_folder = FolderId::from_bytes([0xE8, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s1_epoch = fixture
        .canonical
        .read_space(&s1.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s1.history.clone(),
            active_epoch: s1_epoch,
            folder_id: movable_folder.clone(),
            parent: Some(s1_p1.folder_id.clone()),
            slug: "move-target".into(),
            display_name: "Move Target".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let s1_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xE8, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            s1.history.space_id.clone(),
            ChatAudience::Personal,
            std::collections::BTreeMap::from([(
                s1.history.space_id.clone(),
                owner.auth().spaces()[&s1.history.space_id].clone(),
            )]),
        )
        .unwrap();
    let rename_key = CommandKey::from_bytes([0xE8, 7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s1_p1_handle = format!("{}/h-s1-p1", s1.slug);
    local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(s1_run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: rename_key.clone(),
            },
            "rename_folder",
            json!({
                "project": s1_p1_handle,
                "folder": "move-target",
                "name": "renamed-in-p1",
            }),
        )
        .await
        .unwrap();
    // Move folder out of consented s1_p1 into unconsented s1_p2 and trash it.
    let _moved_out = fixture
        .canonical
        .move_folder(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE8, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: movable_folder.clone(),
                    new_parent: Some(s1_p2.folder_id.clone()),
                },
            },
        )
        .await
        .unwrap();
    let trashed_rows = fixture
        .canonical
        .execute_diagnostic_write_sql_for_test(&format!(
            "UPDATE folder_heads SET lifecycle_state='trashed' WHERE space_id='{}' AND folder_id='{}'",
            s1.history.space_id.as_str(),
            movable_folder.as_str(),
        ))
        .await
        .unwrap();
    assert_eq!(trashed_rows, 1);
    let replay_denied = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(s1_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: rename_key,
            },
            "rename_folder",
            json!({
                "project": s1_p1_handle,
                "folder": "move-target",
                "name": "renamed-in-p1",
            }),
        )
        .await;
    assert!(
        matches!(
            replay_denied,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "trashed folder moved to unconsented project must fail replay via live ancestry, got {:?}",
        replay_denied.err()
    );

    // (6) edit_ability with auxiliary files: if package-outcome journal entry is absent
    //     and ability is trashed before retry, replay must return CommitEffect::Unknown
    //     (Unavailable) instead of fabricating outcome="partial" + stale ref.
    let aux_folder = FolderId::from_bytes([0xE8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s1_epoch2 = fixture
        .canonical
        .read_space(&s1.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let (aux_ref_folder, _, _) = fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s1.history.clone(),
            active_epoch: s1_epoch2,
            folder_id: aux_folder,
            parent: Some(s1_p2.folder_id.clone()),
            slug: "abilities".into(),
            display_name: "Abilities".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let aux_parent = aux_ref_folder.folder_id;
    let aux_note = NoteId::from_bytes([0xE8, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let aux_ab = AbilityId::from_bytes([0xE8, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let aux_entry = fixture
        .canonical
        .create_note(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE8, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: aux_note.clone(),
                    parent: Some(aux_parent),
                    slug: "aux-replay-role".into(),
                    class: DocClass::Skill,
                    carrier: "---\nability_kind: role\ndescription: aux v1\n---\n# aux v1\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let aux_file_content = "auxiliary helper text\n".to_owned();
    let _aux_pub = fixture
        .canonical
        .publish_ability_package(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE8, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: aux_ab.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: aux_note.clone(),
                    files: vec![AbilityFile {
                        path: "helper.txt".into(),
                        digest: ContentDigest::from_bytes(
                            *blake3::hash(aux_file_content.as_bytes()).as_bytes(),
                        ),
                        content: aux_file_content,
                    }],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(aux_entry.revision),
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let s1_p2_handle = format!("{}/h-s1-p2", s1.slug);
    let listed_aux = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE8, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "project": s1_p2_handle, "q": "aux-replay-role" }),
        )
        .await
        .unwrap()
        .structured_content;
    let aux_item = listed_aux["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "aux-replay-role")
        .unwrap();
    let aux_ref = aux_item["ref"].as_str().unwrap().to_owned();
    let aux_ver = aux_item["versionToken"].as_str().unwrap().to_owned();
    let aux_edit_key = CommandKey::from_bytes([0xE8, 8, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let aux_edited = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: aux_edit_key.clone(),
            },
            "edit_ability",
            json!({
                "ref": aux_ref,
                "versionToken": aux_ver,
                "description": "aux v2",
                "instructions": "aux v2 body",
            }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_eq!(aux_edited["outcome"], "updated");
    // Simulate a crash right before recording `edit-ability-package-outcome` by deleting
    // only that mcp_dedup row (keeping `edit-ability-plan` and the canonical commit),
    // then trashing the ability and retrying with the exact same request key.
    fixture
        .storage
        .observer
        .execute(
            "DELETE FROM mcp_dedup WHERE operation='edit_ability' AND safe_result NOT LIKE '%has_auxiliary_files%'",
        )
        .await;
    fixture
        .canonical
        .delete_note(
            s1_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE8, 8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE8; 32]),
                },
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: aux_note,
                    disposition: DeleteDisposition::Trash,
                },
            },
        )
        .await
        .unwrap();
    let aux_retry = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner,
                target: EgressTarget::ExternalMcp,
                request_key: aux_edit_key,
            },
            "edit_ability",
            json!({
                "ref": aux_ref,
                "versionToken": aux_ver,
                "description": "aux v2",
                "instructions": "aux v2 body",
            }),
        )
        .await;
    assert!(
        matches!(
            aux_retry,
            Err(PortError::Unavailable(ref f))
                if f.effect() == CommitEffect::Unknown && f.retry() == RetryAdvice::RetrySameCommand
        ),
        "trashed replay of edit_ability with auxiliary files without outcome journal must return CommitEffect::Unknown (not fabricated partial), got {:?}",
        aux_retry.err()
    );
}

#[allow(clippy::too_many_arguments)]
async fn authority_cursors_oracles_and_trashed_ancestry_hardening(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    personal: &SpaceContext,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
    s1_p2: &FolderRef,
    s2_p1: &FolderRef,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    let pscope = personal.scope().clone();
    let s1_sc = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let s2_sc = SpaceContext::new(owner.auth().clone(), s2.history.clone(), budget()).unwrap();

    // (1) admit_space_management, restrict_to_project, and for_proposal_human must preserve
    //     spaces_narrowed so narrowed contexts can never be laundered into account-wide PATs
    //     or account-wide telemetry/provider-call inspection.
    let narrow_s1 = owner
        .auth()
        .restrict_to_space(&s1.history.space_id)
        .unwrap();
    assert!(narrow_s1.is_space_narrowed());
    let mgmt_s1 = fixture
        .control
        .admit_space_management(
            AccountContext::new(narrow_s1.clone(), budget()),
            s1.history.clone(),
        )
        .await
        .unwrap();
    assert!(
        mgmt_s1.auth().is_space_narrowed(),
        "admit_space_management must preserve/mark spaces_narrowed"
    );
    let owner_rev = fixture
        .control
        .account(owner.clone(), actor.clone())
        .await
        .unwrap()
        .revision;
    let laundered_pat = fixture
        .control
        .create_pat(
            AccountContext::new(mgmt_s1.auth().clone(), budget()),
            CreatePat {
                name: "laundered-all-spaces".into(),
                scope: BearerScope::Write,
                ability_write: true,
                selected_spaces: None,
                expires_at_ms: None,
                expected: owner_rev,
            },
        )
        .await;
    assert!(
        matches!(
            laundered_pat,
            Err(PortError::Domain(DomainError::AccessDenied))
        ),
        "admit_space_management auth must never mint unrestricted all-spaces PAT, got {laundered_pat:?}"
    );
    let proj_narrow = owner.auth().restrict_to_project(s1_p1).unwrap();
    assert!(
        proj_narrow.is_space_narrowed(),
        "restrict_to_project from multi-space auth must mark spaces_narrowed"
    );
    let control_plane = notarium_control::service::ControlPlane::new(local.provider.clone());
    let revalidated_proposal = ControlPort::revalidate_proposal_human(
        &control_plane,
        AccountContext::new(narrow_s1.clone(), budget()),
        notarium_core::auth::ProposalHumanAccess::Write,
    )
    .await
    .unwrap();
    assert!(
        revalidated_proposal.is_space_narrowed(),
        "for_proposal_human must preserve spaces_narrowed"
    );

    // (2) Space-narrowed PAT cannot inspect account-wide agent calls or provider calls,
    //     and cannot read episodes or named_episode_project_hint for excluded Spaces.
    let owner_rev = fixture
        .control
        .account(owner.clone(), actor.clone())
        .await
        .unwrap()
        .revision;
    let pat_s1_created = fixture
        .control
        .create_pat(
            owner.clone(),
            CreatePat {
                name: "s1-only-pat-hardening".into(),
                scope: BearerScope::Write,
                ability_write: false,
                selected_spaces: Some(vec![s1.history.space_id.clone()]),
                expires_at_ms: None,
                expected: owner_rev,
            },
        )
        .await
        .unwrap();
    let pat_s1_auth = fixture
        .control
        .resolve(PreAuthContext {
            budget: budget(),
            evidence: AuthEvidence::new(
                AuthEvidenceKind::Pat,
                pat_s1_created.value.token.expose().to_owned(),
            ),
        })
        .await
        .unwrap();
    let pat_s1 = AccountContext::new(pat_s1_auth.clone(), budget());
    assert!(pat_s1_auth.is_space_narrowed());

    let list_calls_err = fixture
        .control
        .list_agent_calls(pat_s1.clone(), ControlPageRequest::new(10, None).unwrap())
        .await;
    assert!(
        matches!(
            list_calls_err,
            Err(PortError::Domain(DomainError::AccessDenied))
        ),
        "space-narrowed PAT must be denied list_agent_calls, got {list_calls_err:?}"
    );
    let get_call_err = fixture
        .control
        .get_agent_call(pat_s1.clone(), RequestId::from_bytes([0xA2; 16]))
        .await;
    assert!(
        matches!(
            get_call_err,
            Err(PortError::Domain(DomainError::AccessDenied))
        ),
        "space-narrowed PAT must be denied get_agent_call, got {get_call_err:?}"
    );
    let inspect_prov_err = local
        .provider
        .inspect_call(pat_s1.clone(), RequestId::from_bytes([0xA2; 16]))
        .await;
    assert!(
        matches!(
            inspect_prov_err,
            Err(PortError::Domain(DomainError::AccessDenied))
        ),
        "space-narrowed PAT must be denied inspect_call, got {inspect_prov_err:?}"
    );

    // Create an episode bound to s2_p1; s1-only PAT must get ResourceNotFound on get_episode
    // and bootstrap_context, and NoMatch on named_episode_project_hint.
    let s2_ep = fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x43).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        name: Some("hidden-s2-ep".into()),
                        requested: EpisodeId::from_bytes([
                            0xE9, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                        ]),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let s2_ep_id = match s2_ep {
        EpisodeStartResult::New(ep) | EpisodeStartResult::Resumed(ep) => ep.id,
        other => panic!("expected started episode, got {other:?}"),
    };
    assert!(matches!(
        fixture
            .control
            .get_episode(pat_s1.clone(), s2_ep_id.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .bootstrap_context(
                pat_s1.clone(),
                s2_ep_id.clone(),
                None,
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let hint_preview = fixture
        .control
        .named_episode_project_hint(pat_s1.clone(), "hidden-s2-ep".into())
        .await
        .unwrap();
    assert_eq!(
        hint_preview,
        NamedEpisodePreview::NoMatch,
        "named_episode_project_hint must filter unadmitted episodes for narrowed callers"
    );

    // (3) Cleartext pagination cursors in list_favorites, list_context_entries (notes),
    //     list_context_sets, and list_schedules must never leak hidden cross-Space/out-of-project IDs,
    //     and must emit non-empty continuations cleanly across visible1 -> hidden -> visible2.
    let s1_vis_note_1 = NoteId::from_bytes([0xE9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s2_hidden_note = NoteId::from_bytes([0xE9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let s1_vis_note_2 = NoteId::from_bytes([0xE9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    for (idx, (sc_ctx, hist, proj, nid, slug)) in [
        (
            &s1_sc,
            &s1.history,
            s1_p1,
            &s1_vis_note_1,
            "visible-cursor-note-1",
        ),
        (
            &s2_sc,
            &s2.history,
            s2_p1,
            &s2_hidden_note,
            "hidden-cursor-note",
        ),
        (
            &s1_sc,
            &s1.history,
            s1_p1,
            &s1_vis_note_2,
            "visible-cursor-note-2",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        fixture
            .canonical
            .create_note(
                sc_ctx.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: hist.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xE9,
                            1,
                            1,
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
                            (idx + 1) as u8,
                        ]),
                        hash: ContentDigest::from_bytes([0xE9; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: nid.clone(),
                        parent: Some(proj.folder_id.clone()),
                        slug: slug.into(),
                        class: DocClass::UserDoc,
                        carrier: format!("# {slug}\n"),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
    }
    let s1_note_ref_1 = NoteRef {
        space_id: s1.history.space_id.clone(),
        note_id: s1_vis_note_1.clone(),
    };
    let s2_note_ref = NoteRef {
        space_id: s2.history.space_id.clone(),
        note_id: s2_hidden_note.clone(),
    };
    let s1_note_ref_2 = NoteRef {
        space_id: s1.history.space_id.clone(),
        note_id: s1_vis_note_2.clone(),
    };
    for (k, nref, rank) in [
        (0x44_u8, &s1_note_ref_1, 1_i64),
        (0x45_u8, &s2_note_ref, 2_i64),
        (0x4A_u8, &s1_note_ref_2, 3_i64),
    ] {
        fixture
            .control
            .set_favorite(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, k).await,
                    input: SetFavorite {
                        reference: FavoriteRef::Note(nref.clone()),
                        saved: true,
                        rank,
                    },
                },
            )
            .await
            .unwrap();
    }
    let fav_page1 = fixture
        .control
        .list_favorites(pat_s1.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(fav_page1.items.len(), 1);
    assert_eq!(
        fav_page1.items[0].reference,
        FavoriteRef::Note(s1_note_ref_1.clone())
    );
    let fav_cont = fav_page1.continuation.expect(
        "list_favorites must emit non-None continuation for visible1 -> hidden -> visible2",
    );
    assert!(
        !fav_cont.contains(s2.history.space_id.as_str())
            && !fav_cont.contains(s2_hidden_note.as_str()),
        "list_favorites continuation must never leak hidden Space/Note ID: {fav_cont}"
    );
    let fav_page2 = fixture
        .control
        .list_favorites(
            pat_s1.clone(),
            ControlPageRequest::new(1, Some(fav_cont)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fav_page2.items.len(), 1);
    assert_eq!(
        fav_page2.items[0].reference,
        FavoriteRef::Note(s1_note_ref_2.clone())
    );
    assert!(fav_page2.continuation.is_none());

    // Pin visible1, hidden s2 note, and visible2 inside s1 scope, then paginate
    // list_context_entries(limit=1) with s1-only PAT asserting non-vacuous
    // continuation without leaking hidden Space/Note IDs and exact visible coverage.
    let mut s1_ctx_rev = fixture
        .control
        .context_scope(
            owner.clone(),
            ContextScope::Space(s1.history.space_id.clone()),
        )
        .await
        .unwrap()
        .revision;
    for (k, nref) in [
        (0x46_u8, &s1_note_ref_1),
        (0x47_u8, &s2_note_ref),
        (0x4B_u8, &s1_note_ref_2),
    ] {
        let pin = fixture
            .control
            .set_context_pin(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, k).await,
                    input: SetContextPin {
                        scope: ContextScope::Space(s1.history.space_id.clone()),
                        expected: s1_ctx_rev,
                        note: nref.clone(),
                        pinned: true,
                    },
                },
            )
            .await
            .unwrap();
        s1_ctx_rev = pin.value.revision;
    }
    let ctx_page1 = fixture
        .control
        .list_context_entries(
            pat_s1.clone(),
            ContextScope::Space(s1.history.space_id.clone()),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ctx_page1.items.len(), 1);
    let ctx_cont = ctx_page1.continuation.expect(
        "list_context_entries must emit non-None continuation for visible1 -> hidden -> visible2",
    );
    assert!(
        !ctx_cont.contains(s2.history.space_id.as_str())
            && !ctx_cont.contains(s2_hidden_note.as_str()),
        "list_context_entries continuation must never leak hidden note/space ID: {ctx_cont}"
    );
    let mut ctx_seen = vec![ctx_page1.items[0].entry.clone()];
    let mut next_ctx_cont = Some(ctx_cont);
    for _ in 0..16 {
        let Some(cont) = next_ctx_cont.take() else {
            break;
        };
        let page = fixture
            .control
            .list_context_entries(
                pat_s1.clone(),
                ContextScope::Space(s1.history.space_id.clone()),
                ControlPageRequest::new(1, Some(cont)).unwrap(),
            )
            .await
            .unwrap();
        for item in page.items {
            ctx_seen.push(item.entry);
        }
        if let Some(c) = page.continuation {
            assert!(
                !c.contains(s2.history.space_id.as_str()) && !c.contains(s2_hidden_note.as_str()),
                "subsequent list_context_entries continuation leaked hidden ID: {c}"
            );
            next_ctx_cont = Some(c);
        }
    }
    assert!(ctx_seen.contains(&ContextEntry::Note(s1_note_ref_1.clone())));
    assert!(ctx_seen.contains(&ContextEntry::Note(s1_note_ref_2.clone())));
    assert!(!ctx_seen.contains(&ContextEntry::Note(s2_note_ref.clone())));
    assert_eq!(ctx_seen.len(), 2);

    // Filtered list_schedules(limit=1) over visible1 (s1_p1) -> hidden (s1_p2) -> visible2 (s1_p1).
    let sched_vis_1 = ScheduleId::from_bytes([0xE9, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let sched_hidden = ScheduleId::from_bytes([0xE9, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let sched_vis_2 = ScheduleId::from_bytes([0xE9, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    call_mcp(
        &fixture.registry,
        &owner,
        [0xE9, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9],
        "create_ability",
        json!({
            "kind": "role",
            "name": "sched-page-role",
            "description": "Standalone schedule pagination role",
            "instructions": "Run scheduled checks.",
            "placement": { "home": "space", "space": s1.slug },
        }),
    )
    .await
    .unwrap();
    let sched_role_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: Some(s1_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: Some("sched-page-role".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| {
            item.descriptor.reference.placement
                == AbilityPlacement::OwnedSpace(s1.history.space_id.clone())
        })
        .expect("s1 sched-page-role")
        .descriptor
        .reference;
    let next_slot = Timestamp::parse("2028-01-02T09:00:00Z").unwrap();
    for (idx, (sid, proj, title)) in [
        (&sched_vis_1, s1_p1, "sched-vis-1"),
        (&sched_hidden, s1_p2, "sched-hidden"),
        (&sched_vis_2, s1_p1, "sched-vis-2"),
    ]
    .into_iter()
    .enumerate()
    {
        fixture
            .control
            .create_schedule(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, &owner, 0x4C + idx as u8).await,
                    input: CreateSchedule {
                        id: sid.clone(),
                        definition: ScheduleDefinition {
                            space: s1.history.space_id.clone(),
                            project: Some(proj.clone()),
                            title: title.into(),
                            init_prompt: "Check tasks.".into(),
                            cron: "0 0 9 * * * *".into(),
                            timezone: "UTC".into(),
                            approved_role: sched_role_ref.clone(),
                            limits: RunLimits {
                                max_steps: 3,
                                max_tokens: 64_000,
                                timeout_ms: 15_000,
                            },
                        },
                        approved_skills: vec![],
                        next_slot,
                        paused: false,
                    },
                },
            )
            .await
            .unwrap();
    }
    let s1_p1_pinned = SpaceContext::new(
        owner.auth().restrict_to_project(s1_p1).unwrap(),
        s1.history.clone(),
        budget(),
    )
    .unwrap();
    let sch_page1 = fixture
        .control
        .list_schedules(
            s1_p1_pinned.clone(),
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sch_page1.items.len(), 1);
    assert_eq!(sch_page1.items[0].id, sched_vis_1);
    let sch_cont = sch_page1.continuation.expect(
        "list_schedules must emit non-None continuation across visible1 -> hidden -> visible2",
    );
    assert!(
        !sch_cont.contains(sched_hidden.as_str()),
        "list_schedules continuation must never leak hidden ScheduleId: {sch_cont}"
    );
    let sch_page2 = fixture
        .control
        .list_schedules(
            s1_p1_pinned,
            ControlPageRequest::new(1, Some(sch_cont)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sch_page2.items.len(), 1);
    assert_eq!(sch_page2.items[0].id, sched_vis_2);
    assert!(sch_page2.continuation.is_none());

    // (4) Foreign provider resource/attachment/preference/select_provider oracle hardening.
    let unknown_res = ProviderResourceId::from_bytes([0xE9; 16]);
    let select_unknown = local
        .provider
        .select_provider(
            s1_sc.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(unknown_res),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await;
    assert!(
        matches!(
            select_unknown,
            Err(PortError::Domain(DomainError::Provider {
                error: ProviderErrorCode::Unavailable,
                ..
            }))
        ),
        "select_provider on nonexistent resource must return Provider(Unavailable), got {select_unknown:?}"
    );
    // Carol's private resource (created in earlier step with ID [0xE4, 2, .., 1]) is NOT
    // offered to s1; owner probing request_attachment with wrong consent_epoch or
    // set_preference with bogus model must uniformly see ResourceNotFound.
    let carol_private_res =
        ProviderResourceId::from_bytes([0xE4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let req_foreign = local
        .provider
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x48).await,
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([0xE9, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    resource: carol_private_res.clone(),
                    target: ProviderAttachmentTarget::Personal {
                        space: s1.history.space_id.clone(),
                        owner: actor.clone(),
                    },
                    consent: ProviderDisclosureConsent::attest_checked(ProviderDisclosure {
                        classes: BTreeSet::from([DocClass::UserDoc]),
                    }),
                    resource_consent_epoch: 0,
                    credential_consent_epoch: Some(999),
                    expires_at_ms: None,
                    expected: None,
                },
            },
        )
        .await;
    assert!(
        matches!(
            req_foreign,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "request_attachment on unoffered foreign resource with wrong epochs must collapse to ResourceNotFound, got {req_foreign:?}"
    );
    let pref_foreign = local
        .provider
        .set_preference(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0x49).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Personal,
                    kind: PreferenceModelKind::Completion,
                    resource: carol_private_res,
                    model: ModelProfileId::from_bytes([
                        0xE9, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                },
            },
        )
        .await;
    assert!(
        matches!(
            pref_foreign,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "set_preference on unvisible foreign resource must collapse to ResourceNotFound, got {pref_foreign:?}"
    );

    // (5) Ability BudgetExceeded taint commits to caller_taint (not dropped on Err),
    //     proposal pure semantic validation runs before target lookup (zero existence oracle),
    //     and list_notes schema/path probes commit BranchTaint.
    let s2_skill_ab = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "create_ability",
            json!({
                "kind": "skill",
                "name": "budget-taint-skill",
                "description": "Triggers budget exceeded taint commit",
                "instructions": "X".repeat(300),
                "placement": { "home": "space", "space": s2.slug },
            }),
        )
        .await
        .unwrap()
        .structured_content;
    let run_budget = AgentRunId::from_bytes([0xE9, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let run_budget_auth = owner
        .auth()
        .for_agent_run(
            run_budget,
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let use_budget_err = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_budget_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "use_skill",
            json!({
                "skill": s2_skill_ab["ref"].as_str().unwrap(),
                "project": format!("{}/h-s2-p1", s2.slug),
                "budgetTokens": 100,
            }),
        )
        .await;
    assert!(
        matches!(
            use_budget_err,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::BudgetExceeded
        ),
        "use_skill over budget must fail BudgetExceeded, got {:?}",
        use_budget_err.err()
    );
    assert!(
        run_budget_auth.taint().is_tainted(),
        "use_skill failing BudgetExceeded on foreign consented skill MUST commit caller BranchTaint"
    );

    // list_notes frontmatter schema probe on consented foreign Space commits BranchTaint even on ValidationFailed.
    let run_schema = AgentRunId::from_bytes([0xE9, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let run_schema_auth = owner
        .auth()
        .for_agent_run(
            run_schema,
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let schema_probe = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_schema_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "list_notes",
            json!({
                "project": format!("{}/h-s2-p1", s2.slug),
                "fieldDay": ["note.nonexistent_schema_key:not-a-date"],
            }),
        )
        .await;
    assert!(
        matches!(
            schema_probe,
            Err(PortError::Domain(DomainError::ValidationFailed { .. }))
        ),
        "invalid fieldDay predicate must fail ValidationFailed, got {:?}",
        schema_probe.err()
    );
    assert!(
        run_schema_auth.taint().is_tainted(),
        "list_notes schema probe on consented foreign project MUST commit caller BranchTaint even on ValidationFailed"
    );

    // Proposal pure semantic validation runs before target resolution: nonexistent foreign
    // note/project with invalid semantic args returns ValidationFailed (never ResourceNotFound).
    let oracle_thread =
        ChatThreadId::from_bytes([0xE9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            personal.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: oracle_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Proposal semantic precheck".into(),
                },
            },
        )
        .await
        .unwrap();
    let run_prop = AgentRunId::from_bytes([0xE9, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let run_prop_auth = owner
        .auth()
        .for_agent_run(
            run_prop.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let run_prop_sc = SpaceContext::new(run_prop_auth.clone(), pscope.clone(), budget()).unwrap();
    fixture
        .canonical
        .claim_active_run(
            run_prop_sc.clone(),
            ClaimChatRun {
                thread: oracle_thread.clone(),
                run: run_prop,
                expected_leaf: ThreadEntrySeq::ZERO,
                previous_run: None,
            },
        )
        .await
        .unwrap();
    let prop_leaf = fixture
        .canonical
        .append_chat(
            run_prop_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE9, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: oracle_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Check invalid args.".into()),
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
        .unwrap()
        .value
        .seq;
    let fake_note = NoteId::from_bytes([0xFE; 16]).to_string();
    let fake_proj = format!("{}/does-not-exist-proj", s2.slug);
    let prop_binding = PersonalToolInvocation {
        source: pscope.clone(),
        thread: oracle_thread.clone(),
        leaf: prop_leaf,
        owner: owner.clone(),
    };
    for (idx, (tool, args)) in [
        ("rename_note", json!({ "ref": fake_note, "title": "   " })),
        ("move_note", json!({ "ref": fake_note, "toFolder": ".." })),
        (
            "create_note",
            json!({ "project": fake_proj, "body": "x", "fileName": "index" }),
        ),
        (
            "remember_about_project",
            json!({ "project": fake_proj, "observation": "   " }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let err = local
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_prop_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xE9,
                        5,
                        2,
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
                        idx as u8 + 1,
                    ]),
                },
                prop_binding.clone(),
                tool,
                args,
            )
            .await;
        assert!(
            matches!(
                err,
                Err(PortError::Domain(DomainError::ValidationFailed { .. }))
            ),
            "invalid {tool} against nonexistent target must return ValidationFailed (not ResourceNotFound oracle), got {:?}",
            err.err()
        );
        assert!(
            !run_prop_auth.taint().is_tainted(),
            "pure semantic rejection of {tool} must not flip taint"
        );
    }

    // (6) Trashing an ancestor folder causes get_note / get_note_metadata to report effective
    //     Lifecycle::Trashed so recent_activity hides descendant notes under ExternalMcp AND
    //     does not poison provenance under InAppProvider.
    let trash_dir = FolderId::from_bytes([0xE9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let s2_epoch = fixture
        .canonical
        .read_space(&s2.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let (_, trash_dir_rev, _) = fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: trash_dir.clone(),
            parent: Some(s2_p1.folder_id.clone()),
            slug: "trashed-ancestor-dir".into(),
            display_name: "Trashed Ancestor Dir".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let child_note = NoteId::from_bytes([0xE9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: child_note.clone(),
                    parent: Some(trash_dir.clone()),
                    slug: "secret-inside-trashed-folder".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Secret Inside Trashed Folder\n\nHidden body.\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &trash_dir,
            &trash_dir_rev,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    let meta = fixture
        .canonical
        .get_note_metadata(
            s2_sc.clone(),
            GetNote {
                note: child_note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        meta.metadata.lifecycle(),
        notarium_core::model::Lifecycle::Trashed,
        "get_note_metadata must fold Trashed ancestor folder lifecycle"
    );
    let doc = fixture
        .canonical
        .get_note(
            s2_sc.clone(),
            GetNote {
                note: child_note.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        doc.document.lifecycle(),
        notarium_core::model::Lifecycle::Trashed,
        "get_note must fold Trashed ancestor folder lifecycle"
    );
    let recent_ext = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: owner.clone(),
                target: EgressTarget::ExternalMcp,
                request_key: CommandKey::from_bytes([
                    0xE9, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
            },
            "recent_activity",
            json!({ "project": format!("{}/h-s2-p1", s2.slug), "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        recent_ext["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["noteId"] != json!(child_note.to_string())),
        "ExternalMcp recent_activity must not leak notes under trashed ancestor folder: {recent_ext}"
    );
    let run_recent = AgentRunId::from_bytes([0xE9, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let run_recent_auth = owner
        .auth()
        .for_agent_run(
            run_recent,
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let recent_in_app = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_recent_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "recent_activity",
            json!({ "project": format!("{}/h-s2-p1", s2.slug), "limit": 50 }),
        )
        .await
        .unwrap();
    assert!(
        recent_in_app
            .provenance
            .origins
            .iter()
            .all(|origin| !matches!(
                origin,
                notarium_core::classes::ProviderOrigin::Note { reference, .. }
                    if reference.note_id == child_note
            )),
        "InAppProvider recent_activity must not record trashed-folder descendant in provenance: {:?}",
        recent_in_app.provenance
    );

    box_step(|| {
        authority_and_cursor_edge_seams(
            fixture,
            local,
            &owner,
            &mgmt_s1,
            &pat_s1,
            &pat_s1_created.value.metadata.id,
            &s2_ep_id,
            s1,
            s2,
            s1_p1,
            s2_p1,
            actor,
        )
    })
    .await;
    box_step(|| {
        ability_taint_and_kind_edge_seams(
            fixture,
            local,
            &owner,
            &pscope,
            &s2_sc,
            s2,
            s2_p1,
            &s2_skill_ab,
        )
    })
    .await;
    box_step(|| {
        shared_proposal_and_trashed_replay_edge_seams(
            fixture,
            local,
            &owner,
            &pscope,
            &s1_sc,
            &s2_sc,
            s1,
            s2,
            s1_p1,
            s2_p1,
            &s2_hidden_note,
            &oracle_thread,
            prop_leaf,
            s2_epoch,
            actor,
        )
    })
    .await;
    box_step(|| {
        oracle_and_link_many_seams(
            fixture,
            local,
            &owner,
            &pscope,
            s2,
            &s2_hidden_note,
            &oracle_thread,
            prop_leaf,
        )
    })
    .await;
    box_step(|| ability_pagination_and_trail_seams(fixture, &owner, s2, s2_p1, s2_epoch, actor))
        .await;
    box_step(|| post_trash_and_view_replay_seams(fixture, &owner, &s2_sc, s2, s2_epoch, actor))
        .await;
    let s2_p3_id = box_step(|| {
        trail_auth_and_prepromotion_seams(
            fixture, &owner, &pscope, &s2_sc, s2, s2_p1, s2_epoch, actor,
        )
    })
    .await;
    box_step(|| {
        foreign_oracle_and_management_seams(fixture, local, &owner, &pscope, s1, s2, s2_p1)
    })
    .await;
    box_step(|| {
        provider_context_and_schedule_post_delete_seams(fixture, local, &owner, s1, s2, s1_p1)
    })
    .await;
    box_step(|| {
        folder_move_large_view_and_session_rotation_seams(
            fixture, local, &owner, &pscope, &s1_sc, &s2_sc, s1, s2, s1_p1, &s2_p3_id, actor,
        )
    })
    .await;
    box_step(|| {
        hardened_offer_and_selected_skill_seams(fixture, local, &owner, &pscope, &s2_sc, s2)
    })
    .await;
    box_step(|| hardened_removed_space_episode_seams(fixture, &owner, actor)).await;
    box_step(|| hardened_trashed_source_trail_seams(fixture, &s2_sc, s2, s2_p1, s2_epoch, actor))
        .await;
    box_step(|| hardened_schedule_and_legacy_replay_seams(fixture, local, s2, actor)).await;
    box_step(|| hardened_prefix_strip_crash_replay_seams(fixture, s2, s2_epoch, actor)).await;
    box_step(|| {
        hardened_multi_project_secondary_space_seams(fixture, &pscope, s1, s1_p1, s1_p2, actor)
    })
    .await;
    box_step(|| hardened_retrieval_error_and_taint_oracle_seams(fixture, local, &pscope, s2)).await;
    box_step(|| {
        hardened_legacy_precheck_and_trail_write_seams(fixture, &s2_sc, s2, s2_epoch, actor)
    })
    .await;
    box_step(|| {
        hardened_ability_dispatch_shadow_and_replay_seams(
            fixture, local, &pscope, &s2_sc, s2, s2_p1, s2_epoch, actor,
        )
    })
    .await;
    box_step(|| {
        hardened_retry_legacy_and_recent_eviction_seams(
            fixture, local, &pscope, &s2_sc, s2, s2_p1, s2_epoch, actor,
        )
    })
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn authority_and_cursor_edge_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    mgmt_s1: &SpaceContext,
    pat_s1: &AccountContext,
    pat_s1_id: &CredentialTokenId,
    s2_ep_id: &EpisodeId,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
    s2_p1: &FolderRef,
    actor: &PrincipalId,
) {
    // 7a. Class-narrowed DirectHuman cannot launder DocClass::all() via create_pat;
    //     space-narrowed DirectHuman (mgmt_s1) cannot list/inspect excluded-Space attachments
    //     or list/revoke cross-Space PATs; narrowed PAT cannot oracle hidden episodes in begin_agent_call.
    let class_narrow_s1 = owner
        .auth()
        .restrict_read_classes(&s1.history.space_id, &BTreeSet::from([DocClass::UserDoc]))
        .unwrap();
    let owner_rev_7 = fixture
        .control
        .account(owner.clone(), actor.clone())
        .await
        .unwrap()
        .revision;
    for sel in [Some(vec![s1.history.space_id.clone()]), None] {
        let err = fixture
            .control
            .create_pat(
                AccountContext::new(class_narrow_s1.clone(), budget()),
                CreatePat {
                    name: "class-laundered".into(),
                    scope: BearerScope::Write,
                    ability_write: false,
                    selected_spaces: sel,
                    expires_at_ms: None,
                    expected: owner_rev_7,
                },
            )
            .await;
        assert!(
            matches!(err, Err(PortError::Domain(DomainError::AccessDenied))),
            "class-narrowed DirectHuman must be denied create_pat, got {err:?}"
        );
    }
    let mgmt_s1_acc = AccountContext::new(mgmt_s1.auth().clone(), budget());
    assert!(matches!(
        local
            .provider
            .list_attachments(
                mgmt_s1_acc.clone(),
                local.resource.id.clone(),
                ControlPageRequest::new(50, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let s2_att_id = local
        .provider
        .list_attachments(
            owner.clone(),
            local.resource.id.clone(),
            ControlPageRequest::new(50, None).unwrap(),
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|att| {
            matches!(
                &att.target,
                ProviderAttachmentTarget::Space(sp) | ProviderAttachmentTarget::Personal { space: sp, .. }
                    if sp == &s2.history.space_id
            )
        })
        .expect("s2 attachment")
        .id;
    assert!(matches!(
        local
            .provider
            .inspect_attachment(mgmt_s1_acc.clone(), s2_att_id)
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .create_space(
                mgmt_s1_acc.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 0x54).await,
                    input: CreateSpace {
                        id: SpaceId::from_bytes([
                            0xE9, 7, 1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                        ]),
                        name: "Denied Narrowed Space".into(),
                        kind: SpaceKind::Shared,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .set_favorite(
                mgmt_s1_acc.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 0x52).await,
                    input: SetFavorite {
                        reference: FavoriteRef::Folder(s2_p1.clone()),
                        saved: false,
                        rank: 0,
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .set_ability_preference(
                mgmt_s1_acc.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 0x53).await,
                    input: AbilityPreferenceChange {
                        preference: AbilityPreferenceUpdate {
                            ability: AbilityRef {
                                id: AbilityId::from_bytes([0xE9; 16]),
                                placement: AbilityPlacement::System,
                                revision: RevisionId::from_bytes([0xE9; 16]),
                            },
                            enabled: false,
                        },
                        expected: AbilityPreferenceGuard::Authored(None),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));
    assert!(matches!(
        fixture
            .control
            .list_pats(
                mgmt_s1_acc.clone(),
                actor.clone(),
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    assert!(matches!(
        fixture
            .control
            .revoke_pat(
                mgmt_s1_acc,
                AccountMutation {
                    identity: identity(fixture, owner, 0x51).await,
                    input: RevokePat {
                        account: actor.clone(),
                        token: pat_s1_id.clone(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    // begin_agent_call rejects excluded-Space episode ID for narrowed pat_s1.
    let begin_hidden_ep = fixture
        .control
        .begin_agent_call(
            pat_s1.clone(),
            BeginAgentCall {
                call: RequestId::from_bytes([0xE9, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                request: RequestId::from_bytes([0xE9, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                episode: Some(s2_ep_id.clone()),
                operation: AgentOperation::Read,
                transport: AgentTransport::Mcp,
                effect: AgentEffect::Read,
                input_bytes: 16,
            },
        )
        .await;
    assert!(
        matches!(
            begin_hidden_ep,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "begin_agent_call must hide excluded-Space episode from narrowed PAT, got {begin_hidden_ep:?}"
    );

    // 7b. EpisodeSelector::Name resumes sole visible s1 episode even when a hidden s2 episode shares its name.
    let dup_s1_id = EpisodeId::from_bytes([0xE9, 7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let dup_s2_id = EpisodeId::from_bytes([0xE9, 7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    for (k, eid, proj) in [(0x52_u8, &dup_s1_id, s1_p1), (0x53_u8, &dup_s2_id, s2_p1)] {
        fixture
            .control
            .start_or_resume_episode(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, k).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: eid.clone(),
                            name: Some("dup-vis-hid".into()),
                        },
                        project_hint: Some(proj.clone()),
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await
            .unwrap();
    }
    let dup_res = fixture
        .control
        .start_or_resume_episode(
            pat_s1.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 0x54).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Name("dup-vis-hid".into()),
                    project_hint: Some(s1_p1.clone()),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await
        .expect(
            "narrowed PAT must resume/fork sole visible named episode despite hidden duplicate",
        );
    match dup_res.value {
        EpisodeStartResult::Resumed(ep) => assert_eq!(ep.id, dup_s1_id),
        EpisodeStartResult::Forked(ep) => assert_eq!(ep.parent.as_ref(), Some(&dup_s1_id)),
        other => panic!("expected Resumed/Forked of sole visible s1 episode, got {other:?}"),
    }

    // 7c. list_notes with own-Space cursor + missing foreign path fails scope check before directory() without taint.
    let s1_sc_cur = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let cur_n1 = NoteId::from_bytes([0xE9, 7, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let cur_n2 = NoteId::from_bytes([0xE9, 7, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    for (idx, (nid, slug)) in [(&cur_n1, "cur-n1"), (&cur_n2, "cur-n2")]
        .into_iter()
        .enumerate()
    {
        fixture
            .canonical
            .create_note(
                s1_sc_cur.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: s1.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xE9,
                            7,
                            3,
                            1,
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
                        hash: ContentDigest::from_bytes([0xE9; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: nid.clone(),
                        parent: Some(s1_p1.folder_id.clone()),
                        slug: slug.into(),
                        class: DocClass::UserDoc,
                        carrier: format!("# {slug}\n"),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
    }
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: s1.history.space_id.clone(),
            note_id: cur_n1.clone(),
        },
        notes: vec![cur_n1, cur_n2],
    });
    let run_cur = AgentRunId::from_bytes([0xE9, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let run_cur_auth = owner
        .auth()
        .for_agent_run(
            run_cur,
            s1.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let own_cur_page = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_cur_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "list_notes",
            json!({ "project": format!("{}/h-s1-p1", s1.slug), "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    let s1_cursor = own_cur_page["nextCursor"]
        .as_str()
        .expect("s1_p1 has >=2 notes so limit=1 emits nextCursor")
        .to_owned();
    assert!(!run_cur_auth.taint().is_tainted());
    for (idx, probe_path) in ["secret-locked", "no-such-folder-xyz"]
        .into_iter()
        .enumerate()
    {
        let cross_cur = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_cur_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xE9,
                        7,
                        3,
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
                        3 + idx as u8,
                    ]),
                },
                "list_notes",
                json!({
                    "project": format!("{}/h-s2-p1", s2.slug),
                    "path": probe_path,
                    "cursor": s1_cursor,
                }),
            )
            .await;
        assert!(
            matches!(
                cross_cur,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "own-Space cursor against foreign Space ({probe_path}) must fail ResourceNotFound before folder probe, got {:?}",
            cross_cur.err()
        );
        assert!(!run_cur_auth.taint().is_tainted());
    }
}

#[allow(clippy::too_many_arguments)]
async fn ability_taint_and_kind_edge_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_skill_ab: &serde_json::Value,
) {
    // 7d. Disabled foreign OwnedSpace(s2) Skill shadowing a local OwnedPersonal Role commits
    //     BranchTaint in list_abilities(view="runtime", source="owned", kind="role") even though
    //     zero foreign Role bodies are read.
    call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "create_ability",
        json!({
            "kind": "role",
            "name": "shadow-probe",
            "description": "Local personal role shadowed by disabled s2 skill",
            "instructions": "Local personal body.",
            "placement": { "home": "personal" },
        }),
    )
    .await
    .unwrap();
    let s2_shadow_sys = call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "shadow-probe",
            "description": "Shadow local personal role",
            "instructions": "Shadow body.",
            "placement": { "home": "space", "space": s2.slug },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": s2_shadow_sys["ref"],
            "versionToken": s2_shadow_sys["versionToken"],
            "enabled": false,
        }),
    )
    .await
    .unwrap();
    let run_shadow = AgentRunId::from_bytes([0xE9, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let run_shadow_auth = owner
        .auth()
        .for_agent_run(
            run_shadow,
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shadowed_list = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_shadow_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                ]),
            },
            "list_abilities",
            json!({ "view": "runtime", "source": "owned", "kind": "role", "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        shadowed_list["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["name"] != "shadow-probe"),
        "disabled foreign OwnedSpace skill must suppress shadowed local OwnedPersonal ability"
    );
    assert!(
        run_shadow_auth.taint().is_tainted(),
        "disabled foreign winner suppressing local ability MUST commit BranchTaint"
    );

    // 7e. Disabled wrong-kind ability (Skill) returns ResourceNotFound (not InvalidState) in
    //     ExternalMcp use_role(ar1 / raw ID) and bind_chat_role(raw ID / name).
    let disabled_skill_ar1 = s2_shadow_sys["ref"].as_str().unwrap().to_owned();
    let disabled_skill_id = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: None,
                kind: Some(AbilityKind::Skill),
                name: Some("shadow-probe".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| {
            item.descriptor.reference.placement
                == AbilityPlacement::OwnedSpace(s2.history.space_id.clone())
        })
        .expect("s2 disabled shadow-probe skill")
        .descriptor
        .reference
        .id
        .to_string();
    for (idx, selector) in [disabled_skill_ar1.as_str(), disabled_skill_id.as_str()]
        .into_iter()
        .enumerate()
    {
        let res = call_mcp(
            &fixture.registry,
            owner,
            [
                0xE9,
                7,
                5,
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
                1 + idx as u8,
            ],
            "use_role",
            json!({ "role": selector }),
        )
        .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "ExternalMcp use_role on disabled Skill ({selector}) must return ResourceNotFound, got {:?}",
            res.err()
        );
    }
    let s2_sel = local
        .provider
        .select_provider(
            s2_sc.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let bind_ep = EpisodeId::from_bytes([0xE9, 7, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 0x55).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: bind_ep.clone(),
                        name: Some("bind-wrong-kind".into()),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    for selector in [disabled_skill_id.as_str(), "shadow-probe"] {
        let bind_err = notarium_agents::mcp::bind_chat_role_for_test(
            &local.registry,
            owner.clone(),
            s2_sc.clone(),
            &s2_sel,
            &bind_ep,
            selector,
            Some(s2_p1),
            &AgentRunId::from_bytes([0xE9, 7, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]),
        )
        .await;
        assert!(
            matches!(
                bind_err,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "bind_chat_role on disabled Skill ({selector}) must return ResourceNotFound, got {bind_err:?}"
        );
    }

    // 7f. Attached foreign Skill exceeding budgetTokens in use_role omits skill AND commits BranchTaint.
    let s1_parent_role = call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "local-role-with-foreign-skill",
            "description": "Local role attaching foreign skill",
            "instructions": "Short role body.",
            "placement": { "home": "personal" },
            "attachments": [{ "ref": s2_skill_ab["ref"], "label": "Big Foreign Skill" }],
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let run_attach = AgentRunId::from_bytes([0xE9, 7, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let run_attach_auth = owner
        .auth()
        .for_agent_run(
            run_attach,
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let attached_res = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_attach_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 7, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                ]),
            },
            "use_role",
            json!({ "role": s1_parent_role["ref"], "budgetTokens": 100 }),
        )
        .await
        .unwrap()
        .structured_content;
    assert_eq!(attached_res["skills"], json!([]));
    assert!(
        !attached_res["omittedSkills"].as_array().unwrap().is_empty(),
        "oversized foreign attached skill must appear in omittedSkills"
    );
    assert!(
        run_attach_auth.taint().is_tainted(),
        "omitting a foreign attached skill due to budgetTokens MUST commit BranchTaint"
    );
}

#[allow(clippy::too_many_arguments)]
async fn shared_proposal_and_trashed_replay_edge_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s1_sc: &SpaceContext,
    s2_sc: &SpaceContext,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
    s2_p1: &FolderRef,
    s2_hidden_note: &NoteId,
    oracle_thread: &ChatThreadId,
    prop_leaf: ThreadEntrySeq,
    s2_epoch: LeaseEpoch,
    actor: &PrincipalId,
) {
    // 7g. Personal chat anchored in SpaceKind::Shared (s1): existing vs missing foreign note returns
    //     uniform ResourceNotFound with BranchTaint == false; all-invalid link_many returns InvalidQuery.
    let shared_personal_thread =
        ChatThreadId::from_bytes([0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_chat(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: shared_personal_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: Some(s1_p1.folder_id.clone()),
                    title: "Shared personal oracle check".into(),
                },
            },
        )
        .await
        .unwrap();
    let shared_msg = fixture
        .canonical
        .append_chat(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xE9; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: shared_personal_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("hello".into()),
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
    let shared_binding = PersonalToolInvocation {
        source: s1.history.clone(),
        thread: shared_personal_thread,
        leaf: shared_msg.value.seq,
        owner: owner.clone(),
    };
    let run_sp = AgentRunId::from_bytes([0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let run_sp_auth = owner
        .auth()
        .for_agent_run(
            run_sp,
            s1.history.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    for (idx, target_note) in [
        s2_hidden_note,
        &NoteId::from_bytes([0xE9, 7, 7, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]),
    ]
    .into_iter()
    .enumerate()
    {
        let res = local
            .registry
            .call_personal_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_sp_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xE9,
                        7,
                        7,
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
                        4 + idx as u8,
                    ]),
                },
                shared_binding.clone(),
                "delete_note",
                json!({ "ref": target_note }),
            )
            .await;
        assert!(
            matches!(res, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "Personal chat in Shared Space must return uniform ResourceNotFound on foreign note, got {:?}",
            res.err()
        );
        assert!(!run_sp_auth.taint().is_tainted());
    }
    let bad_lm = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(
                    owner
                        .auth()
                        .for_agent_run(
                            AgentRunId::from_bytes([
                                0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10,
                            ]),
                            pscope.space_id.clone(),
                            ChatAudience::Personal,
                            owner.auth().spaces().clone(),
                        )
                        .unwrap(),
                    budget(),
                ),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xE9, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
                ]),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: oracle_thread.clone(),
                leaf: prop_leaf,
                owner: owner.clone(),
            },
            "link_many",
            json!({
                "links": [{
                    "from": s2_hidden_note,
                    "to": s2_hidden_note,
                    "relation": "bad:colon",
                }]
            }),
        )
        .await;
    assert!(
        matches!(
            bad_lm,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidQuery
        ),
        "all-invalid link_many must fail InvalidQuery before foreign lookup, got {:?}",
        bad_lm.err()
    );

    // 7h. Post-ancestor-folder-trash idempotent replay (edit_note, move_note, link with alias)
    //     and ChangeRead::Seed historical folder lifecycle folding.
    let anc_dir = FolderId::from_bytes([0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let (_, anc_dir_rev, _) = fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: anc_dir.clone(),
            parent: Some(s2_p1.folder_id.clone()),
            slug: "anc-replay-dir".into(),
            display_name: "Anc Replay Dir".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let anc_a = call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "create_note",
        json!({
            "project": format!("{}/h-s2-p1", s2.slug),
            "path": "anc-replay-dir",
            "title": "Anc Replay A",
            "body": "# Anc Replay A\n\nInitial.\n",
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let anc_b = call_mcp(
        &fixture.registry,
        owner,
        [0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_note",
        json!({
            "project": format!("{}/h-s2-p1", s2.slug),
            "path": "anc-replay-dir",
            "title": "Anc Replay B",
            "body": "# Anc Replay B\n\nTarget.\n",
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let anc_edit_key = [0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    let anc_edit_args = json!({
        "ref": anc_a["noteId"],
        "operation": "append",
        "content": "\nEdited before ancestor trash.\n",
    });
    let anc_edit_1 = call_mcp(
        &fixture.registry,
        owner,
        anc_edit_key,
        "edit_note",
        anc_edit_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let anc_link_key = [0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
    let anc_link_args = json!({
        "from": anc_a["noteId"],
        "to": anc_b["noteId"],
        "relation": "relates",
    });
    let anc_link_1 = call_mcp(
        &fixture.registry,
        owner,
        anc_link_key,
        "link",
        anc_link_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let anc_move_key = [0xE9, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6];
    let anc_move_args = json!({
        "ref": anc_a["noteId"],
        "toFolder": "h-s2-p1/anc-replay-dir/sub",
    });
    let anc_move_1 = call_mcp(
        &fixture.registry,
        owner,
        anc_move_key,
        "move_note",
        anc_move_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let (trashed_anc_rev, trashed_anc_seq) = fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &anc_dir,
            &anc_dir_rev,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    let anc_edit_2 = call_mcp(
        &fixture.registry,
        owner,
        anc_edit_key,
        "edit_note",
        anc_edit_args,
    )
    .await
    .expect("edit_note idempotent replay must succeed after ancestor folder trash")
    .structured_content;
    assert_eq!(anc_edit_2["versionToken"], anc_edit_1["versionToken"]);
    let anc_link_2 = call_mcp(
        &fixture.registry,
        owner,
        anc_link_key,
        "link",
        anc_link_args,
    )
    .await
    .expect("link with alias idempotent replay must succeed after ancestor folder trash")
    .structured_content;
    assert_eq!(anc_link_2["versionToken"], anc_link_1["versionToken"]);
    let anc_move_2 = call_mcp(
        &fixture.registry,
        owner,
        anc_move_key,
        "move_note",
        anc_move_args,
    )
    .await
    .expect("move_note idempotent replay must succeed after ancestor folder trash")
    .structured_content;
    assert_eq!(anc_move_2["versionToken"], anc_move_1["versionToken"]);
    // Restore anc_dir AFTER trashed_anc_seq, then read ChangeRead::Seed pinned at trashed_anc_seq:
    // the note snapshot MUST carry recorded lifecycle Trashed (folded from historical ancestor).
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &anc_dir,
            &trashed_anc_rev,
            notarium_core::model::Lifecycle::Active,
            actor,
            None,
        )
        .await
        .unwrap();
    let anc_a_id = NoteId::parse(anc_a["noteId"].as_str().unwrap()).unwrap();
    let mut seed_cursor = None;
    let mut saw_anc_a_seed = None;
    for _ in 0..32 {
        let req = match seed_cursor.take() {
            None => ChangeRead::Seed {
                scope: s2.history.clone(),
                cutoff: Some(trashed_anc_seq),
                limit: PageLimit::new(50).unwrap(),
            },
            Some(cursor) => ChangeRead::ContinueSeed { cursor },
        };
        let res = fixture
            .canonical
            .read_changes(s2_sc.clone(), req)
            .await
            .unwrap();
        let ChangeReadResult::Seed(seed) = res else {
            panic!("expected ChangeReadResult::Seed");
        };
        if let Some(found) = seed
            .notes
            .iter()
            .find(|snap| snap.document.reference().note_id == anc_a_id)
        {
            saw_anc_a_seed = Some(found.document.lifecycle());
            break;
        }
        if let Some(next) = seed.next {
            seed_cursor = Some(next);
        } else {
            break;
        }
    }
    assert_eq!(
        saw_anc_a_seed,
        Some(notarium_core::model::Lifecycle::Trashed),
        "ChangeRead::Seed must fold historical Trashed ancestor lifecycle at cutoff even after later restore"
    );
}

#[allow(clippy::too_many_arguments)]
async fn oracle_and_link_many_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s2: &AccessibleSpace,
    s2_hidden_note: &NoteId,
    oracle_thread: &ChatThreadId,
    prop_leaf: ThreadEntrySeq,
) {
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);

    // (1) Pure syntax validation precedes target resolution in list_notes/search/recent_activity,
    //     and explicit foreign project queries commit BranchTaint even on 0-hit/empty responses.
    let run_syn_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEA, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    for (idx, proj) in [s2_p1_handle.as_str(), "no-such-space/no-proj"]
        .into_iter()
        .enumerate()
    {
        let err = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_syn_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        1,
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
                },
                "list_notes",
                json!({ "project": proj, "limit": 0 }),
            )
            .await;
        assert!(
            matches!(
                err,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if matches!(
                        diagnostic.reason,
                        ValidationReason::InvalidLimit | ValidationReason::InvalidQuery
                    )
            ),
            "list_notes limit=0 must fail validation before project resolution, got {:?}",
            err.err()
        );
        let cur_err = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_syn_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        1,
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
                        40 + idx as u8,
                    ]),
                },
                "list_notes",
                json!({ "project": proj, "cursor": "not-a-valid-cursor" }),
            )
            .await;
        assert!(
            matches!(
                cur_err,
                Err(PortError::Domain(DomainError::ValidationFailed { .. }))
            ),
            "list_notes malformed cursor must fail validation before project resolution, got {:?}",
            cur_err.err()
        );
        let path_err = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_syn_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        1,
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
                        20 + idx as u8,
                    ]),
                },
                "list_notes",
                json!({ "project": proj, "path": "../escape" }),
            )
            .await;
        assert!(
            matches!(
                path_err,
                Err(PortError::Domain(DomainError::ValidationFailed { .. }))
            ),
            "list_notes invalid path must fail before project resolution, got {:?}",
            path_err.err()
        );
        let recent_err = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_syn_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        1,
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
                        30 + idx as u8,
                    ]),
                },
                "recent_activity",
                json!({ "project": proj, "limit": 0 }),
            )
            .await;
        assert!(
            matches!(
                recent_err,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if matches!(
                        diagnostic.reason,
                        ValidationReason::InvalidLimit | ValidationReason::InvalidQuery
                    )
            ),
            "recent_activity limit=0 must fail validation before project resolution, got {:?}",
            recent_err.err()
        );
    }
    assert!(
        !run_syn_auth.taint().is_tainted(),
        "pure syntax rejections must not taint caller"
    );

    // Explicit foreign project queries commit external_read taint even on empty/0-hit results.
    fixture.projections.install(ProjectionFixture {
        view_owner: NoteRef {
            space_id: s2.history.space_id.clone(),
            note_id: s2_hidden_note.clone(),
        },
        notes: vec![s2_hidden_note.clone()],
    });
    for (idx, (tool, args)) in [
        (
            "list_notes",
            json!({ "project": s2_p1_handle, "path": "nonexistent-empty-subdir" }),
        ),
        (
            "search",
            json!({ "project": s2_p1_handle, "query": "zzz_unmatched_query_999" }),
        ),
        (
            "recent_activity",
            json!({ "project": s2_p1_handle, "limit": 5 }),
        ),
        (
            "list_abilities",
            json!({ "project": s2_p1_handle, "view": "authoring", "source": "system" }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let run_auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([
                    0xEA,
                    2,
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
                    1 + idx as u8,
                ]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let _ = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        2,
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
                        20 + idx as u8,
                    ]),
                },
                tool,
                args,
            )
            .await
            .unwrap();
        assert!(
            run_auth.taint().is_tainted(),
            "explicit foreign project {tool} must commit external_read taint even on 0 hits"
        );
    }

    // Episode-bound foreign project_hint (args.project omitted) must also commit
    // cross-space BranchTaint on 0-hit search, recall, and recent_activity.
    let s2_sc_local =
        SpaceContext::new(owner.auth().clone(), s2.history.clone(), budget()).unwrap();
    let s2_p1 = fixture
        .canonical
        .project_by_slug(s2_sc_local, "h-s2-p1".into())
        .await
        .unwrap()
        .folder;
    let foreign_ep = match fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 91).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::parse("ses_ForHint00001").unwrap(),
                        name: Some("foreign-hint-taint-ep".into()),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap()
        .value
    {
        EpisodeStartResult::New(ep) => ep.id,
        other => panic!("expected New episode, got {other:?}"),
    };
    for (idx, (tool, args)) in [
        (
            "search",
            json!({ "query": "zzz_unmatched_hint_999", "session": foreign_ep }),
        ),
        (
            "recall",
            json!({ "query": "zzz_unmatched_hint_999", "session": foreign_ep }),
        ),
        (
            "recent_activity",
            json!({ "session": foreign_ep, "limit": 5 }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let run_auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([
                    0xEA,
                    2,
                    1,
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
                    1 + idx as u8,
                ]),
                pscope.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let _ = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run_auth.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([
                        0xEA,
                        2,
                        1,
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
                        20 + idx as u8,
                    ]),
                },
                tool,
                args,
            )
            .await
            .unwrap();
        assert!(
            run_auth.taint().is_tainted(),
            "episode project_hint foreign {tool} must commit external_read taint even on 0 hits"
        );
    }

    // CatalogDisclosure::Space for an excluded Space with dummy incarnation must
    // collapse to ResourceNotFound (never HistoryIncarnationMismatch).
    let personal_only_acc = AccountContext::new(
        owner.auth().restrict_to_space(&pscope.space_id).unwrap(),
        budget(),
    );
    let dummy_s2_scope = notarium_core::model::HistoryScope {
        space_id: s2.history.space_id.clone(),
        incarnation: notarium_core::ids::HistoryIncarnation::from_bytes([0xFE; 16]),
    };
    assert!(matches!(
        fixture
            .canonical
            .disclosure(
                personal_only_acc,
                notarium_core::ports::CatalogDisclosure::Space(dummy_s2_scope),
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    // ControlService::inspect_memory_target for foreign Space projects on an
    // untainted AgentRun pinned to Personal Space must return SpaceReadOnly
    // without touching catalog_project or flipping taint (both real & fake IDs).
    let mem_probe_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEA, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let mem_probe_acc = AccountContext::new(mem_probe_auth.clone(), budget());
    for folder in [
        s2_p1.clone(),
        FolderRef {
            space_id: s2.history.space_id.clone(),
            folder_id: FolderId::from_bytes([0xFD; 16]),
        },
    ] {
        assert!(matches!(
            fixture
                .control
                .inspect_memory_target(
                    mem_probe_acc.clone(),
                    MemoryTarget::Project { folder },
                    "probe".to_owned(),
                )
                .await,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ));
    }
    assert!(
        !mem_probe_auth.taint().is_tainted(),
        "rejected foreign inspect_memory_target must not taint caller"
    );

    // (2) link_many must not route to an approvalRequired proposal when foreign targets
    //     are read-only (Viewer) or non-proposal classes (Skill), preventing existence oracles.
    let mut viewer_spaces = owner.auth().spaces().clone();
    if let Some(grant) = viewer_spaces.get_mut(&s2.history.space_id) {
        grant.role = SpaceRole::Viewer;
        grant.write_classes.clear();
    }
    let viewer_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEA, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            viewer_spaces,
        )
        .unwrap();
    let lm_viewer = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(viewer_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xEA, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: oracle_thread.clone(),
                leaf: prop_leaf,
                owner: owner.clone(),
            },
            "link_many",
            json!({
                "links": [{
                    "from": s2_hidden_note,
                    "to": NoteId::from_bytes([0xEA; 16]),
                    "relation": "relates",
                }]
            }),
        )
        .await
        .unwrap();
    assert!(
        lm_viewer.proposal().is_none(),
        "link_many on Viewer foreign note must not mint approvalRequired proposal"
    );
    let skill_entry = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: None,
                kind: Some(AbilityKind::Skill),
                name: Some("budget-taint-skill".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items[0]
        .descriptor
        .entrypoint
        .as_ref()
        .unwrap()
        .note_id
        .clone();
    let skill_lm_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEA, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let lm_skill = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(skill_lm_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xEA, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                ]),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: oracle_thread.clone(),
                leaf: prop_leaf,
                owner: owner.clone(),
            },
            "link_many",
            json!({
                "links": [{
                    "from": skill_entry,
                    "to": NoteId::from_bytes([0xEA; 16]),
                    "relation": "relates",
                }]
            }),
        )
        .await
        .unwrap();
    assert!(
        lm_skill.proposal().is_none(),
        "link_many on non-proposal Skill note must not mint approvalRequired proposal"
    );
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn ability_pagination_and_trail_seams(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);
    // (3) Visibility-scoped ability pagination & cursor isolation for project-scoped humans & Keepers.
    let s2_p2_id = FolderId::from_bytes([0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: s2_p2_id,
            parent: None,
            slug: "h-s2-p2".into(),
            display_name: "H S2 P2".into(),
            is_project: true,
            project_slug: Some("h-s2-p2".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let s2_p2_handle = format!("{}/h-s2-p2", s2.slug);
    let _p1_role_a = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p1-page-a",
            "description": "P1 role A",
            "instructions": "Role A",
            "placement": { "home": "project", "project": s2_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let p1_role_b = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p1-page-b",
            "description": "P1 role B",
            "instructions": "Role B",
            "placement": { "home": "project", "project": s2_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _p2_role_a = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p2-hidden-a",
            "description": "P2 hidden role A",
            "instructions": "Hidden A",
            "placement": { "home": "project", "project": s2_p2_handle },
        }),
    )
    .await
    .unwrap();
    let p1_scoped_acc = AccountContext::new(
        owner
            .auth()
            .restrict_to_space(&s2.history.space_id)
            .unwrap()
            .restrict_to_project(s2_p1)
            .unwrap(),
        budget(),
    );
    let page1 = fixture
        .canonical
        .abilities(
            p1_scoped_acc.clone(),
            AbilityQuery {
                project: Some(s2_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: true,
                page: ControlPageRequest::new(1, None).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(page1.items.len(), 1);
    assert!(
        page1.continuation.is_some(),
        "project-scoped abilities page 1 must advance when >1 visible role exists"
    );
    // Mutating an ability in unrelated project s2_p2 must NOT stale s2_p1's cursor.
    let _p2_role_b = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
        "create_ability",
        json!({
            "kind": "role",
            "name": "p2-hidden-b",
            "description": "P2 hidden role B",
            "instructions": "Hidden B",
            "placement": { "home": "project", "project": s2_p2_handle },
        }),
    )
    .await
    .unwrap();
    let page2 = fixture
        .canonical
        .abilities(
            p1_scoped_acc,
            AbilityQuery {
                project: Some(s2_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: true,
                page: ControlPageRequest::new(1, page1.continuation).unwrap(),
            },
        )
        .await
        .expect("mutation in unrelated project must not stale project-scoped ability cursor");
    assert_eq!(page2.items.len(), 1);
    assert_ne!(page1.items[0].reference.id, page2.items[0].reference.id);
    // Keeper readonly_abilities pagination returns exact visible item with continuation: None.
    let p1_a_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: Some(s2_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: Some("p1-page-a".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items[0]
        .descriptor
        .reference
        .clone();
    let keeper_acc = AccountContext::new(
        owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes([0xEA, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]),
                s2.history.space_id.clone(),
                Some(s2_p1.folder_id.clone()),
                BTreeSet::from([p1_a_ref.id.clone()]),
            )
            .unwrap(),
        budget(),
    );
    let keeper_page = fixture
        .canonical
        .abilities(
            keeper_acc,
            AbilityQuery {
                project: Some(s2_p1.clone()),
                kind: None,
                name: None,
                authoring: false,
                page: ControlPageRequest::new(1, None).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(keeper_page.items.len(), 1);
    assert_eq!(keeper_page.items[0].reference.id, p1_a_ref.id);
    assert!(
        keeper_page.continuation.is_none(),
        "Keeper abilities page must not emit continuation for hidden abilities"
    );

    // (4) Placement trail following for Disabled/Stale exact ar1: tokens in use_role / use_skill.
    let trail_old_token = p1_role_b["ref"].as_str().unwrap().to_owned();
    let promoted = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "edit_ability",
        json!({
            "ref": trail_old_token,
            "versionToken": p1_role_b["versionToken"],
            "home": { "home": "space" },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _disabled = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": promoted["ref"],
            "versionToken": promoted["versionToken"],
            "enabled": false,
        }),
    )
    .await
    .unwrap();
    let use_old_role = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "use_role",
        json!({ "role": trail_old_token, "project": s2_p1_handle }),
    )
    .await;
    assert!(
        matches!(
            use_old_role,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if matches!(
                    diagnostic.reason,
                    ValidationReason::InvalidState | ValidationReason::SourceMismatch
                )
        ),
        "use_role on promoted+disabled old ar1 token must follow trail, got {:?}",
        use_old_role.err()
    );
    let use_old_as_skill = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "use_skill",
        json!({ "skill": trail_old_token, "project": s2_p1_handle }),
    )
    .await;
    assert!(
        matches!(
            use_old_as_skill,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "use_skill on promoted+disabled Role token must reject wrong kind with ResourceNotFound, got {:?}",
        use_old_as_skill.err()
    );

    // Promoted skill attached to a Role must still be followed and delivered by
    // both get_ability and use_role after promotion from project to Space scope.
    let s2_sc_trail =
        SpaceContext::new(owner.auth().clone(), s2.history.clone(), budget()).unwrap();
    let att_skill_note = NoteId::from_bytes([0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xA1]);
    let att_skill_id =
        AbilityId::from_bytes([0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xA2]);
    let _ = fixture
        .canonical
        .create_note(
            s2_sc_trail.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: owner.auth().principal().clone(),
                    key: CommandKey::from_bytes([
                        0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xB1,
                    ]),
                    hash: ContentDigest::from_bytes([0xB1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: att_skill_note.clone(),
                    parent: Some(s2_p1.folder_id.clone()),
                    slug: "promoted-attached-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: promoted-attached-skill\ndescription: Attached skill before promotion.\n---\nFollow this promoted skill.\n".into(),
                },
            },
        )
        .await
        .unwrap();
    let _ = fixture
        .canonical
        .publish_ability_package(
            s2_sc_trail,
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: owner.auth().principal().clone(),
                    key: CommandKey::from_bytes([
                        0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xB2,
                    ]),
                    hash: ContentDigest::from_bytes([0xB2; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: att_skill_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: att_skill_note,
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: None,
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap();
    let listed_att = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xB3],
        "list_abilities",
        json!({ "view": "authoring", "kind": "skill", "project": s2_p1_handle, "q": "promoted-attached-skill" }),
    )
    .await
    .unwrap()
    .structured_content;
    let att_skill_ref = listed_att["items"][0]["ref"].as_str().unwrap().to_owned();
    let att_skill_get = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xB4],
        "get_ability",
        json!({ "ref": att_skill_ref }),
    )
    .await
    .unwrap()
    .structured_content;
    let att_skill_ver = att_skill_get["versionToken"].as_str().unwrap().to_owned();
    let att_role = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "create_ability",
        json!({
            "kind": "role",
            "name": "role-with-promoted-skill",
            "description": "Role attaching promoted skill.",
            "instructions": "Use attached skill.\n",
            "placement": { "home": "project", "project": s2_p1_handle },
            "attachments": [{ "ref": att_skill_ref }],
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let att_role_ref = att_role["ref"].as_str().unwrap().to_owned();
    let _promoted_skill = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "edit_ability",
        json!({
            "ref": att_skill_ref,
            "versionToken": att_skill_ver,
            "home": { "home": "space" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    let s2_p1_ep = match fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 92).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::parse("ses_PromSk000002").unwrap(),
                        name: Some("promoted-skill-ep".into()),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap()
        .value
    {
        EpisodeStartResult::New(ep) => ep.id,
        other => panic!("expected New episode, got {other:?}"),
    };
    let inspected_role = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "get_ability",
        json!({ "ref": att_role_ref, "session": s2_p1_ep }),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(
        inspected_role["attachments"][0]["status"], "healthy",
        "promoted attached skill must stay healthy via placement trail: {inspected_role:?}"
    );
    let activated_role = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
        "use_role",
        json!({ "role": att_role_ref, "project": s2_p1_handle }),
    )
    .await
    .unwrap()
    .structured_content;
    assert!(
        activated_role["omittedSkills"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "promoted attached skill must not be omitted from use_role: {activated_role:?}"
    );

    // Cross-project list_child_folders staleness isolation: creating a folder
    // in sibling project s2_p2 must not stale a cursor pinned to s2_p1.
    for (tag, sub) in [(11u8, "p1-sub-a"), (12u8, "p1-sub-b")] {
        let _ = call_mcp(
            &fixture.registry,
            owner,
            [0xEA, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag],
            "create_note",
            json!({
                "project": s2_p1_handle,
                "path": sub,
                "title": sub,
                "body": "Body\n",
            }),
        )
        .await
        .unwrap();
    }
    let s2_p1_sc = SpaceContext::new(
        owner.auth().restrict_to_project(s2_p1).unwrap(),
        s2.history.clone(),
        budget(),
    )
    .unwrap();
    let f_page1 = fixture
        .canonical
        .list_child_folders(
            s2_p1_sc.clone(),
            Some(s2_p1.folder_id.clone()),
            None,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    let f_next = f_page1.next.clone().expect("p1 has >= 2 child folders");
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13],
        "create_note",
        json!({
            "project": s2_p2_handle,
            "path": "sibling-p2-folder-mut",
            "title": "Sibling P2 Folder",
            "body": "Body\n",
        }),
    )
    .await
    .unwrap();
    let f_page2 = fixture
        .canonical
        .list_child_folders(
            s2_p1_sc,
            Some(s2_p1.folder_id.clone()),
            Some(f_next),
            Some(f_page1.cut_seq),
            PageLimit::new(1).unwrap(),
        )
        .await
        .expect("sibling project folder write must not stale p1 list_child_folders cursor");
    assert!(!f_page2.items.is_empty());
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn post_trash_and_view_replay_seams(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    // (5) Post-trash & post-rename idempotent replay for create_note, create_notes,
    //     ensure_folder_path, create_ability, and view-edit edit_note.
    let p_rep_id = FolderId::from_bytes([0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_rep_ref = FolderRef {
        space_id: s2.history.space_id.clone(),
        folder_id: p_rep_id.clone(),
    };
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_rep_id.clone(),
            parent: None,
            slug: "h-s2-replay".into(),
            display_name: "H S2 Replay".into(),
            is_project: true,
            project_slug: Some("h-s2-replay".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let p_rep_rev = fixture
        .canonical
        .resolve_folder_path(s2_sc.clone(), Some(p_rep_id.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    let p_rep_handle = format!("{}/h-s2-replay", s2.slug);

    // Direct ensure_folder_path replay on trashed folder.
    let ensure_mut = Mutation {
        identity: CommandIdentity {
            scope: s2.history.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
            hash: ContentDigest::from_bytes([0xEA; 32]),
        },
        preconditions: Preconditions::default(),
        input: EnsureFolderPath {
            base: Some(p_rep_id.clone()),
            path: "ensured/nested".into(),
        },
    };
    let ensured_1 = fixture
        .canonical
        .ensure_folder_path(s2_sc.clone(), ensure_mut.clone())
        .await
        .unwrap();

    // MCP create_note + create_notes + create_ability in p_rep.
    let cn_key = [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
    let cn_args = json!({
        "project": p_rep_handle,
        "path": "sub/leaf",
        "title": "Post Trash Create Note",
        "body": "Body",
    });
    let cn_1 = call_mcp(
        &fixture.registry,
        owner,
        cn_key,
        "create_note",
        cn_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;

    let cns_key = [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
    let cns_args = json!({
        "project": p_rep_handle,
        "notes": [{
            "path": "batch-sub",
            "title": "Post Trash Batch Note",
            "body": "Batch body",
        }],
    });
    let cns_1 = call_mcp(
        &fixture.registry,
        owner,
        cns_key,
        "create_notes",
        cns_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;

    let cab_key = [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6];
    let cab_args = json!({
        "kind": "role",
        "name": "replay-post-trash-role",
        "description": "Replay role",
        "instructions": "Replay instructions",
        "placement": { "home": "project", "project": p_rep_handle },
    });
    let cab_1 = call_mcp(
        &fixture.registry,
        owner,
        cab_key,
        "create_ability",
        cab_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;

    // View-edit edit_note with a project-scoped human before trashing p_rep.
    let view_key = ViewKey::from_bytes([0xEA; 16]);
    let view_note_res = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7],
        "create_note",
        json!({
            "project": p_rep_handle,
            "title": "View Replay Note",
            "body": format!("Intro.\n\n```nota\nid: {view_key}\ntype: table\n```\n"),
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let view_note_id = view_note_res["noteId"].as_str().unwrap().to_owned();
    let p_rep_scoped_acc = AccountContext::new(
        owner
            .auth()
            .restrict_to_space(&s2.history.space_id)
            .unwrap()
            .restrict_to_project(&p_rep_ref)
            .unwrap(),
        budget(),
    );
    let view_edit_key = [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8];
    let view_edit_args = json!({
        "ref": view_note_id,
        "versionToken": view_note_res["versionToken"],
        "view": {
            "viewRef": format!("{view_note_id}:{view_key}"),
            "common": { "set": { "title": "Updated Board View" } },
        },
    });
    let view_edit_1 = call_mcp(
        &fixture.registry,
        &p_rep_scoped_acc,
        view_edit_key,
        "edit_note",
        view_edit_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;

    // Rename `.abilities` inside p_rep, then trash p_rep!
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xEA, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9],
        "rename_folder",
        json!({
            "project": p_rep_handle,
            "folder": ".abilities",
            "name": "renamed-abilities",
        }),
    )
    .await
    .unwrap();
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &p_rep_id,
            &p_rep_rev,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();

    // Replay all five operations after rename + trash.
    let ensured_2 = fixture
        .canonical
        .ensure_folder_path(s2_sc.clone(), ensure_mut)
        .await
        .expect("ensure_folder_path idempotent replay must succeed after folder trash");
    assert_eq!(ensured_2, ensured_1);

    let cn_2 = call_mcp(&fixture.registry, owner, cn_key, "create_note", cn_args)
        .await
        .expect("create_note idempotent replay must succeed after project trash")
        .structured_content;
    assert_eq!(cn_2["noteId"], cn_1["noteId"]);
    assert_eq!(cn_2["versionToken"], cn_1["versionToken"]);

    let cns_2 = call_mcp(&fixture.registry, owner, cns_key, "create_notes", cns_args)
        .await
        .expect("create_notes idempotent replay must succeed after project trash")
        .structured_content;
    assert_eq!(cns_2["results"][0]["noteId"], cns_1["results"][0]["noteId"]);

    let cab_2 = call_mcp(
        &fixture.registry,
        owner,
        cab_key,
        "create_ability",
        cab_args,
    )
    .await
    .expect(
        "create_ability idempotent replay must succeed after .abilities rename and project trash",
    )
    .structured_content;
    assert_eq!(cab_2["ref"], cab_1["ref"]);

    let view_edit_2 = call_mcp(
        &fixture.registry,
        &p_rep_scoped_acc,
        view_edit_key,
        "edit_note",
        view_edit_args,
    )
    .await
    .expect("project-scoped view edit_note replay must succeed after project trash")
    .structured_content;
    assert_eq!(view_edit_2["versionToken"], view_edit_1["versionToken"]);
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn trail_auth_and_prepromotion_seams(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) -> FolderId {
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);

    // Create a second project under s2 for cursor/move/ensure tests.
    let s2_p3_id = FolderId::from_bytes([0xEC, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: s2_p3_id.clone(),
            parent: None,
            slug: "h-s2-p3".into(),
            display_name: "H S2 P3".into(),
            is_project: true,
            project_slug: Some("h-s2-p3".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();

    // (1) Ability chain & placement authorization: personal placement requires
    //     personal Space grant + Skill class + unpinned project; Keeper requires
    //     readonly_abilities; Space/Project placements enforce Skill class + project_root.
    let pers_created = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "pers-auth-chain-skill",
            "description": "Personal skill for chain auth check.",
            "instructions": "Personal instructions.\n",
            "placement": { "home": "personal" },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _pers_ref_str = pers_created["ref"].as_str().unwrap();
    let pers_ab_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: None,
                kind: Some(AbilityKind::Skill),
                name: Some("pers-auth-chain-skill".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .next()
        .expect("personal skill discovered")
        .descriptor
        .reference;

    // Shared-audience run lacking personal Space cannot follow/resolve OwnedPersonal.
    let shared_run_only_s2 = AccountContext::new(
        owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xEC, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                s2.history.space_id.clone(),
                ChatAudience::Shared,
                owner
                    .auth()
                    .restrict_to_spaces(&[s2.history.space_id.clone()].into())
                    .spaces()
                    .clone(),
            )
            .unwrap(),
        budget(),
    );
    assert!(matches!(
        fixture
            .control
            .follow_ability(shared_run_only_s2.clone(), pers_ab_ref.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .resolve_ability(
                shared_run_only_s2,
                AbilitySelection::Exact {
                    reference: pers_ab_ref.clone(),
                    project: None,
                },
            )
            .await,
        Ok(AbilityResolution::OutOfScope)
    ));

    // Caller without DocClass::Skill on personal Space cannot follow OwnedPersonal.
    let no_skill_pers = AccountContext::new(
        owner
            .auth()
            .restrict_read_classes(&pscope.space_id, &[DocClass::UserDoc].into())
            .unwrap(),
        budget(),
    );
    assert!(matches!(
        fixture
            .control
            .follow_ability(no_skill_pers.clone(), pers_ab_ref.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        fixture
            .control
            .resolve_ability(
                no_skill_pers,
                AbilitySelection::Exact {
                    reference: pers_ab_ref,
                    project: None,
                },
            )
            .await,
        Ok(AbilityResolution::OutOfScope)
    ));

    // (2) In-place edit before promotion: trail follows by identity for
    //     follow_ability / get_ability / edit_ability while resolve_ability(Exact)
    //     returns Stale for the pre-edit revision.
    let edited_skill_note = NoteId::from_bytes([0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let edited_skill_id =
        AbilityId::from_bytes([0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let _ = fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
                    hash: ContentDigest::from_bytes([0xC2; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: edited_skill_note.clone(),
                    parent: Some(s2_p1.folder_id.clone()),
                    slug: "edit-then-promote-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: edit-then-promote-skill\ndescription: Version 1.\n---\nV1 instructions.\n".into(),
                },
            },
        )
        .await
        .unwrap();
    let _ = fixture
        .canonical
        .publish_ability_package(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xC3; 32]),
                },
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: edited_skill_id.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: edited_skill_note,
                    files: vec![],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: None,
                    requires_explicit_binding: false,
                },
            },
        )
        .await
        .unwrap();
    let pre_edit_list = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
        "list_abilities",
        json!({ "view": "authoring", "kind": "skill", "project": s2_p1_handle, "q": "edit-then-promote-skill" }),
    )
    .await
    .unwrap()
    .structured_content;
    let ar1_rev1 = pre_edit_list["items"][0]["ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let rev1_desc = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: Some(s2_p1.clone()),
                kind: Some(AbilityKind::Skill),
                name: Some("edit-then-promote-skill".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|it| it.descriptor.reference.id == edited_skill_id)
        .expect("v1 skill discovered")
        .descriptor
        .reference;
    let rev1_get = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
        "get_ability",
        json!({ "ref": ar1_rev1 }),
    )
    .await
    .unwrap()
    .structured_content;
    let ver1 = rev1_get["versionToken"].as_str().unwrap().to_owned();

    // Edit in-place (rev1 -> rev2), then promote (rev2 -> OwnedSpace@rev3).
    let edited_v2 = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7],
        "edit_ability",
        json!({
            "ref": ar1_rev1,
            "versionToken": ver1,
            "instructions": "V2 instructions before promotion.\n",
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let ar1_rev2 = edited_v2["ref"].as_str().unwrap().to_owned();
    let rev2_get = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8],
        "get_ability",
        json!({ "ref": ar1_rev2 }),
    )
    .await
    .unwrap()
    .structured_content;
    let ver2 = rev2_get["versionToken"].as_str().unwrap().to_owned();
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9],
        "edit_ability",
        json!({
            "ref": ar1_rev2,
            "versionToken": ver2,
            "home": { "home": "space" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();

    // Pre-edit rev1 follows to OwnedSpace on identity-based follow_ability, returns
    // Stale on exact resolution, and works via MCP get_ability / edit_ability.
    let followed_rev1 = fixture
        .control
        .follow_ability(owner.clone(), rev1_desc.clone())
        .await
        .expect("follow_ability must follow trail across pre-promotion in-place edit");
    assert_eq!(
        followed_rev1.placement,
        AbilityPlacement::OwnedSpace(s2.history.space_id.clone())
    );
    assert!(matches!(
        fixture
            .control
            .resolve_ability(
                owner.clone(),
                AbilitySelection::Exact {
                    reference: rev1_desc.clone(),
                    project: Some(s2_p1.clone()),
                },
            )
            .await,
        Ok(AbilityResolution::Stale)
    ));
    let get_via_old_ar1 = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
        "get_ability",
        json!({ "ref": ar1_rev1 }),
    )
    .await
    .expect("get_ability with pre-promotion ar1 token must follow trail")
    .structured_content;
    assert!(
        get_via_old_ar1["instructions"]
            .as_str()
            .unwrap()
            .contains("V2 instructions before promotion")
    );
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11],
        "edit_ability",
        json!({
            "ref": ar1_rev1,
            "enabled": false,
        }),
    )
    .await
    .expect("edit_ability with pre-promotion ar1 token must follow trail");

    // Project-pinned caller without readonly_abilities cannot follow OwnedSpace ability.
    let s2_p1_pinned =
        AccountContext::new(owner.auth().restrict_to_project(s2_p1).unwrap(), budget());
    assert!(matches!(
        fixture
            .control
            .follow_ability(s2_p1_pinned, followed_rev1.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    s2_p3_id
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn foreign_oracle_and_management_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
) {
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);
    let s2_p3_handle = format!("{}/h-s2-p3", s2.slug);

    // (3) Zero-taint foreign project oracles & ForeignProject taint on get_ability /
    //     empty-class search / cursor mismatch.
    let make_s1_run = |tag: u8| {
        let auth = owner
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([0xEC, 3, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
                s1.history.space_id.clone(),
                ChatAudience::Personal,
                owner.auth().spaces().clone(),
            )
            .unwrap();
        let acc = AccountContext::new(auth.clone(), budget());
        (auth, acc)
    };
    let in_app_ctx = |acc: &AccountContext, tag: u8| McpInvocationContext {
        account: acc.clone(),
        target: EgressTarget::InAppProvider {
            provider: local.resource.id.clone(),
            model: local.model.clone(),
            primary_project: None,
        },
        request_key: CommandKey::from_bytes([0xEC, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag]),
    };

    // Malformed cursor on list_abilities and malformed ar1: on use_role reject
    // identically with InvalidId before project lookup, without taint.
    let (auth_ora, acc_ora) = make_s1_run(1);
    for (idx, proj) in [&s2_p1_handle, &format!("{}/no-such-proj-ec", s2.slug)]
        .into_iter()
        .enumerate()
    {
        let err_list = local
            .registry
            .call_tool(
                in_app_ctx(&acc_ora, 1 + idx as u8),
                "list_abilities",
                json!({ "view": "runtime", "project": proj, "cursor": "bad-cursor" }),
            )
            .await;
        assert!(
            matches!(
                &err_list,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidId
            ),
            "bad list_abilities cursor must fail InvalidId before project lookup, got {:?}",
            err_list.err()
        );
        let err_role = local
            .registry
            .call_tool(
                in_app_ctx(&acc_ora, 10 + idx as u8),
                "use_role",
                json!({ "role": "ar1:not-valid-base64", "project": proj }),
            )
            .await;
        assert!(
            matches!(
                &err_role,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidId
            ),
            "bad use_role ar1 token must fail InvalidId before project lookup, got {:?}",
            err_role.err()
        );
    }
    assert!(!auth_ora.taint().is_tainted());

    // Valid foreign-Space cursor probed against a different foreign project commits
    // external-read taint on CursorScopeMismatch.
    let (_auth_cur_a, acc_cur_a) = make_s1_run(2);
    let page_s2 = local
        .registry
        .call_tool(
            in_app_ctx(&acc_cur_a, 20),
            "list_notes",
            json!({ "project": s2_p1_handle, "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    let s2_p1_cursor = page_s2["nextCursor"]
        .as_str()
        .expect("s2_p1 has >=2 items for cursor")
        .to_owned();
    let (auth_cur_b, acc_cur_b) = make_s1_run(3);
    let mismatch_err = local
        .registry
        .call_tool(
            in_app_ctx(&acc_cur_b, 21),
            "list_notes",
            json!({ "project": s2_p3_handle, "cursor": s2_p1_cursor }),
        )
        .await;
    assert!(matches!(
        mismatch_err,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorScopeMismatch
    ));
    assert!(
        auth_cur_b.taint().is_tainted(),
        "foreign project CursorScopeMismatch must commit BranchTaint"
    );

    // Search targeting foreign project with empty class intersection still taints.
    let s2_userdoc_only_auth = owner
        .auth()
        .restrict_read_classes(&s2.history.space_id, &[DocClass::UserDoc].into())
        .unwrap()
        .for_agent_run(
            AgentRunId::from_bytes([0xEC, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
            s1.history.space_id.clone(),
            ChatAudience::Personal,
            owner
                .auth()
                .restrict_read_classes(&s2.history.space_id, &[DocClass::UserDoc].into())
                .unwrap()
                .spaces()
                .clone(),
        )
        .unwrap();
    let s2_userdoc_acc = AccountContext::new(s2_userdoc_only_auth.clone(), budget());
    let empty_cls_search = local
        .registry
        .call_tool(
            in_app_ctx(&s2_userdoc_acc, 22),
            "search",
            json!({ "project": s2_p1_handle, "query": "anything", "class": "agent-memory" }),
        )
        .await
        .unwrap()
        .structured_content;
    assert!(
        empty_cls_search["results"]
            .as_array()
            .is_some_and(Vec::is_empty)
    );
    assert!(
        s2_userdoc_only_auth.taint().is_tainted(),
        "foreign project search with empty class intersection must still mark BranchTaint"
    );

    // get_ability with an episode pointing at a foreign project commits ForeignProject taint.
    let s2_hint_ep = match fixture
        .control
        .start_or_resume_episode(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 93).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::parse("ses_GetAbHint001").unwrap(),
                        name: Some("foreign-hint-ep".into()),
                    },
                    project_hint: Some(s2_p1.clone()),
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap()
        .value
    {
        EpisodeStartResult::New(ep) => ep.id,
        other => panic!("expected New episode, got {other:?}"),
    };
    let sys_list = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "list_abilities",
        json!({ "view": "runtime", "source": "system", "kind": "role" }),
    )
    .await
    .unwrap()
    .structured_content;
    let sys_role_ref = sys_list["items"][0]["ref"].as_str().unwrap();
    let auth_get_ab = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEC, 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let acc_get_ab = AccountContext::new(auth_get_ab.clone(), budget());
    let _ = local
        .registry
        .call_tool(
            in_app_ctx(&acc_get_ab, 23),
            "get_ability",
            json!({
                "ref": sys_role_ref,
                "session": s2_hint_ep,
            }),
        )
        .await
        .unwrap();
    assert!(
        auth_get_ab.taint().is_tainted(),
        "get_ability using foreign episode project_hint must mark ForeignProject BranchTaint"
    );

    // (4) admit_space_management space-narrowed ownership oracle: owned excluded Space
    //     and non-existent Space both return AccessDenied.
    let owner_only_s1 = AccountContext::new(
        owner
            .auth()
            .restrict_to_spaces(&[s1.history.space_id.clone()].into()),
        budget(),
    );
    let missing_scope = HistoryScope {
        space_id: SpaceId::from_bytes([0xEC; 16]),
        incarnation: HistoryIncarnation::from_bytes([0xEC; 16]),
    };
    for target_scope in [&s2.history, &missing_scope] {
        assert!(matches!(
            fixture
                .control
                .admit_space_management(owner_only_s1.clone(), target_scope.clone())
                .await,
            Err(PortError::Domain(DomainError::AccessDenied))
        ));
    }
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn provider_context_and_schedule_post_delete_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
) {
    // (5) list_offer_models pre-revalidation & pre-approval oracle: pending attachment
    //     and missing attachment with bogus incarnation both return ResourceNotFound.
    let del_res = local
        .provider
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 94).await,
                input: ProviderResourceSpec {
                    id: ProviderResourceId::from_bytes([
                        0xEC, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    name: "ephemeral-replay-provider".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: "https://api.example.com/v1".into(),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let pending_att_id = RequestId::from_bytes([0xEC, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let att_disclosure = ProviderDisclosure {
        classes: [DocClass::UserDoc].into(),
    };
    let pending_att = local
        .provider
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 95).await,
                input: RequestProviderAttachment {
                    id: pending_att_id.clone(),
                    expected: None,
                    resource: del_res.id.clone(),
                    target: ProviderAttachmentTarget::Space(s2.history.space_id.clone()),
                    consent: ProviderDisclosureConsent::attest_checked(att_disclosure.clone()),
                    resource_consent_epoch: del_res.consent_epoch,
                    credential_consent_epoch: None,
                    expires_at_ms: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let bogus_s2_scope = HistoryScope {
        space_id: s2.history.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes([0xFE; 16]),
    };
    let bogus_s2_ctx = SpaceContext::new(owner.auth().clone(), bogus_s2_scope, budget()).unwrap();
    for probe_offer in [
        pending_att_id.clone(),
        RequestId::from_bytes([0xEC, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99]),
    ] {
        assert!(matches!(
            local
                .provider
                .list_offer_models(
                    bogus_s2_ctx.clone(),
                    probe_offer,
                    ControlPageRequest::new(10, None).unwrap(),
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }

    // (6) approve_attachment & revoke_attachment replay AFTER delete_resource.
    let approve_mut = AccountMutation {
        identity: identity(fixture, owner, 96).await,
        input: ApproveProviderAttachment {
            id: pending_att.id.clone(),
            expected: pending_att.revision,
            consent: ProviderDisclosureConsent::attest_checked(att_disclosure),
            resource_consent_epoch: del_res.consent_epoch,
            credential_consent_epoch: None,
        },
    };
    let approved_1 = local
        .provider
        .approve_attachment(owner.clone(), approve_mut.clone())
        .await
        .unwrap();
    let revoke_mut = AccountMutation {
        identity: identity(fixture, owner, 97).await,
        input: RevokeProviderAttachment {
            id: pending_att.id.clone(),
            expected: approved_1.value.revision,
        },
    };
    let revoked_1 = local
        .provider
        .revoke_attachment(owner.clone(), revoke_mut.clone())
        .await
        .unwrap();
    let del_res_latest = local
        .provider
        .list_resources(owner.clone(), ControlPageRequest::new(50, None).unwrap())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|r| r.id == del_res.id)
        .unwrap();
    local
        .provider
        .delete_resource(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 98).await,
                input: DeleteProviderResource {
                    resource: del_res.id.clone(),
                    expected: del_res_latest.revision,
                },
            },
        )
        .await
        .unwrap();
    let approved_2 = local
        .provider
        .approve_attachment(owner.clone(), approve_mut)
        .await
        .expect("approve_attachment replay must succeed after delete_resource");
    assert_eq!(approved_2.revision, approved_1.revision);
    assert_eq!(approved_2.value.id, approved_1.value.id);
    let revoked_2 = local
        .provider
        .revoke_attachment(owner.clone(), revoke_mut)
        .await
        .expect("revoke_attachment replay must succeed after delete_resource");
    assert_eq!(revoked_2.revision, revoked_1.revision);

    // (7) put_context_set, create_schedule, and update_schedule replay AFTER delete.
    let cs_id = ContextSetId::from_bytes([0xEC, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let put_cs_mut = AccountMutation {
        identity: identity(fixture, owner, 99).await,
        input: PutContextSet {
            id: cs_id.clone(),
            home: s2.history.space_id.clone(),
            name: "post-delete-replay-set".into(),
            notes: vec![],
            expected: None,
        },
    };
    let cs_1 = fixture
        .control
        .put_context_set(owner.clone(), put_cs_mut.clone())
        .await
        .unwrap();
    fixture
        .control
        .delete_context_set(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 100).await,
                input: DeleteContextSet {
                    id: cs_id.clone(),
                    expected: cs_1.value.revision,
                },
            },
        )
        .await
        .unwrap();
    let cs_2 = fixture
        .control
        .put_context_set(owner.clone(), put_cs_mut)
        .await
        .expect("put_context_set replay must succeed after delete_context_set");
    assert_eq!(cs_2.revision, cs_1.revision);
    assert_eq!(cs_2.value.id, cs_1.value.id);

    let sched_desc = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: Some(s1_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|it| {
            it.descriptor.reference.placement == AbilityPlacement::System
                && it.descriptor.enabled
                && it.binding_enabled
                && it.preference_enabled
        })
        .expect("enabled builtin system role present")
        .descriptor;
    let sched_id = ScheduleId::from_bytes([0xEC, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let sched_slot = Timestamp::parse("2030-01-01T09:00:00Z").unwrap();
    let sched_def = ScheduleDefinition {
        space: s1.history.space_id.clone(),
        project: Some(s1_p1.clone()),
        title: "Post Delete Schedule".into(),
        init_prompt: "Check tasks".into(),
        cron: "0 0 9 * * * *".into(),
        timezone: "UTC".into(),
        approved_role: sched_desc.reference,
        limits: RunLimits {
            max_steps: 4,
            max_tokens: 64_000,
            timeout_ms: 15_000,
        },
    };
    let create_sched_mut = AccountMutation {
        identity: identity(fixture, owner, 101).await,
        input: CreateSchedule {
            id: sched_id.clone(),
            definition: sched_def.clone(),
            approved_skills: sched_desc.attached_skills,
            next_slot: sched_slot,
            paused: true,
        },
    };
    let sch_1 = fixture
        .control
        .create_schedule(owner.clone(), create_sched_mut.clone())
        .await
        .unwrap();
    let update_sched_mut = AccountMutation {
        identity: identity(fixture, owner, 102).await,
        input: UpdateSchedule {
            schedule: sched_id.clone(),
            expected: sch_1.value.revision,
            definition: sched_def,
            approved_skills: None,
            next_slot: Some(sched_slot),
            paused: true,
        },
    };
    let sch_u1 = fixture
        .control
        .update_schedule(owner.clone(), update_sched_mut.clone())
        .await
        .unwrap();
    fixture
        .control
        .delete_schedule(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 103).await,
                input: DeleteSchedule {
                    schedule: sched_id,
                    expected: sch_u1.value.revision,
                },
            },
        )
        .await
        .unwrap();
    let sch_2 = fixture
        .control
        .create_schedule(owner.clone(), create_sched_mut)
        .await
        .expect("create_schedule replay must succeed after delete_schedule");
    assert_eq!(sch_2.revision, sch_1.revision);
    assert_eq!(sch_2.value.id, sch_1.value.id);
    let sch_u2 = fixture
        .control
        .update_schedule(owner.clone(), update_sched_mut)
        .await
        .expect("update_schedule replay must succeed after delete_schedule");
    assert_eq!(sch_u2.revision, sch_u1.revision);
    assert_eq!(sch_u2.value.revision, sch_u1.value.revision);
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn folder_move_large_view_and_session_rotation_seams(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s1_sc: &SpaceContext,
    s2_sc: &SpaceContext,
    s1: &AccessibleSpace,
    s2: &AccessibleSpace,
    s1_p1: &FolderRef,
    s2_p3_id: &FolderId,
    actor: &PrincipalId,
) {
    let s1_p1_handle = format!("{}/h-s1-p1", s1.slug);

    // (8) list_child_folders at_seq staleness on child moved OUT of base, plus
    //     ensure_folder_path post-move replay & existing-folder write auth check.
    let ensure_mv_mut = Mutation {
        identity: CommandIdentity {
            scope: s2.history.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xEC, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            hash: ContentDigest::from_bytes([0xC8; 32]),
        },
        preconditions: Preconditions::default(),
        input: EnsureFolderPath {
            base: Some(s2_p3_id.clone()),
            path: "child-a".into(),
        },
    };
    let child_a = fixture
        .canonical
        .ensure_folder_path(s2_sc.clone(), ensure_mv_mut.clone())
        .await
        .unwrap();
    let _child_b = fixture
        .canonical
        .ensure_folder_path(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xC9; 32]),
                },
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: Some(s2_p3_id.clone()),
                    path: "child-b".into(),
                },
            },
        )
        .await
        .unwrap();
    // Read-only caller cannot pass ensure_folder_path even when path already exists.
    let ro_pat = fixture.pat(BearerScope::Read, false).await;
    let ro_s2_sc = SpaceContext::new(ro_pat.auth().clone(), s2.history.clone(), budget()).unwrap();
    assert!(matches!(
        fixture
            .canonical
            .ensure_folder_path(
                ro_s2_sc,
                Mutation {
                    identity: CommandIdentity {
                        scope: s2.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes([
                            0xEC, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                        ]),
                        hash: ContentDigest::from_bytes([0xCA; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: EnsureFolderPath {
                        base: Some(s2_p3_id.clone()),
                        path: "child-a".into(),
                    },
                },
            )
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    let cf_p1 = fixture
        .canonical
        .list_child_folders(
            s2_sc.clone(),
            Some(s2_p3_id.clone()),
            None,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    let cf_next = cf_p1.next.clone().expect("p3 has 2 children");
    // Move `child-a` OUT of `s2_p3_id` to Space root.
    let child_a_snap = fixture
        .canonical
        .resolve_folder_path(
            s2_sc.clone(),
            Some(child_a.folder_id.clone()),
            String::new(),
        )
        .await
        .unwrap()
        .unwrap();
    fixture
        .canonical
        .move_folder(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                    ]),
                    hash: ContentDigest::from_bytes([0xCB; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(child_a_snap.revision),
                    ..Default::default()
                },
                input: MoveFolder {
                    folder: child_a.folder_id.clone(),
                    new_parent: None,
                },
            },
        )
        .await
        .unwrap();
    let cf_stale = fixture
        .canonical
        .list_child_folders(
            s2_sc.clone(),
            Some(s2_p3_id.clone()),
            Some(cf_next),
            Some(cf_p1.cut_seq),
            PageLimit::new(1).unwrap(),
        )
        .await;
    assert!(
        matches!(
            &cf_stale,
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if diagnostic.reason == ValidationReason::CursorStale
        ),
        "moving a child folder out of base must stale list_child_folders at_seq cursor, got {:?}",
        cf_stale.err()
    );
    let ensure_mv_replay = fixture
        .canonical
        .ensure_folder_path(s2_sc.clone(), ensure_mv_mut)
        .await
        .expect("ensure_folder_path replay must succeed after ensured folder moved out of base");
    assert_eq!(ensure_mv_replay, child_a);

    // (9) View edit_note with >64 KiB body succeeds without exceeding control.mcp_dedup
    //     64 KiB limit and replays cleanly, and confirmed proposal replay works across
    //     human session (GrantId) rotation.
    let big_view_note = NoteId::from_bytes([0xEC, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let big_view_key = ViewKey::from_bytes([0xEC; 16]);
    let filler = "x".repeat(70_000);
    let _ = fixture
        .canonical
        .create_note(
            s1_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s1.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([0xEC, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    hash: ContentDigest::from_bytes([0xCC; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: big_view_note.clone(),
                    parent: Some(s1_p1.folder_id.clone()),
                    slug: "large-view-note".into(),
                    class: DocClass::UserDoc,
                    carrier: format!(
                        "---\ntitle: Large View\n---\n{filler}\n\n```nota\nid: {big_view_key}\ntype: table\n```\n"
                    ),
                },
            },
        )
        .await
        .unwrap();
    let big_edit_key = [0xEC, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3];
    let big_edit_args = json!({
        "ref": big_view_note,
        "view": {
            "viewRef": format!("{big_view_note}:{big_view_key}"),
            "common": { "set": { "type": "board", "group_by": "status" } },
        },
    });
    let big_edit_1 = call_mcp(
        &fixture.registry,
        owner,
        big_edit_key,
        "edit_note",
        big_edit_args.clone(),
    )
    .await
    .expect(">64 KiB view edit_note must succeed with content-free schema journal")
    .structured_content;
    let big_edit_2 = call_mcp(
        &fixture.registry,
        owner,
        big_edit_key,
        "edit_note",
        big_edit_args,
    )
    .await
    .expect(">64 KiB view edit_note must replay identically")
    .structured_content;
    assert_eq!(big_edit_2["versionToken"], big_edit_1["versionToken"]);

    // Confirmed proposal replay across session/GrantId rotation.
    let prop_thread = ChatThreadId::from_bytes([0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_sc = SpaceContext::new(owner.auth().clone(), pscope.clone(), budget()).unwrap();
    let _ = fixture
        .canonical
        .create_chat(
            p_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xCD; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateChat {
                    thread: prop_thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Session Rotation Proposal".into(),
                },
            },
        )
        .await
        .unwrap();
    let movable_note = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_note",
        json!({
            "project": s1_p1_handle,
            "title": "Confirmed Move Target",
            "body": "Move me across sessions.\n",
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let movable_note_id = NoteId::parse(movable_note["noteId"].as_str().unwrap()).unwrap();
    let prop_run = AgentRunId::from_bytes([0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    let prop_auth = owner
        .auth()
        .for_agent_run(
            prop_run.clone(),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let prop_run_scope = SpaceContext::new(prop_auth.clone(), pscope.clone(), budget()).unwrap();
    assert_eq!(
        fixture
            .canonical
            .claim_active_run(
                prop_run_scope.clone(),
                ClaimChatRun {
                    thread: prop_thread.clone(),
                    run: prop_run,
                    expected_leaf: ThreadEntrySeq::ZERO,
                    previous_run: None,
                },
            )
            .await
            .unwrap(),
        ClaimChatRunOutcome::Claimed
    );
    let move_call_key = CommandKey::from_bytes([0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    let move_args = json!({
        "ref": movable_note_id,
        "toFolder": "h-s1-p1/rot-dest/nested",
    });
    let model_entry = fixture
        .canonical
        .append_chat(
            prop_run_scope.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6,
                    ]),
                    hash: ContentDigest::from_bytes([0xCE; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: prop_thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Model,
                    body: ChatInputBody::Text("Proposing move".into()),
                    tool_calls: vec![ProviderToolCall {
                        id: ProviderToolCallId::new(move_call_key.as_str().into()).unwrap(),
                        name: "move_note".into(),
                        arguments: move_args.as_object().unwrap().clone().into_iter().collect(),
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
    let prepared_move = local
        .registry
        .call_personal_tool(
            McpInvocationContext {
                account: AccountContext::new(prop_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: move_call_key.clone(),
            },
            PersonalToolInvocation {
                source: pscope.clone(),
                thread: prop_thread.clone(),
                leaf: model_entry.value.seq,
                owner: owner.clone(),
            },
            "move_note",
            move_args,
        )
        .await
        .unwrap();
    assert_eq!(
        prepared_move.structured_content["outcome"],
        "approvalRequired"
    );
    let draft = prepared_move
        .proposal()
        .expect("out-of-Space move_note in personal chat must emit proposal");
    let prop_entry = fixture
        .canonical
        .append_chat(
            prop_run_scope,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xEC, 9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10,
                    ]),
                    hash: ContentDigest::from_bytes([0xCF; 32]),
                },
                preconditions: Preconditions::default(),
                input: AppendChat {
                    thread: prop_thread.clone(),
                    parent: model_entry.value.seq,
                    kind: ChatEntryKind::Tool {
                        call_id: move_call_key,
                    },
                    body: ChatInputBody::Text(prepared_move.content[0].text.clone()),
                    tool_calls: vec![],
                    provenance: Some(prepared_move.provenance.clone()),
                    interruption: None,
                    proposed_diff: Some(draft.envelope().to_owned()),
                    proposed_effect: Some(draft.effect()),
                    referenced_notes: vec![],
                    tainted: true,
                },
            },
        )
        .await
        .unwrap();
    let apply_req = ConfirmProposedDiff {
        source: pscope.clone(),
        thread: prop_thread,
        entry: prop_entry.value.seq,
        proposal: draft.id(),
    };
    let applied_g1 = local
        .registry
        .apply_proposed_diff(owner.clone(), apply_req.clone())
        .await
        .expect("initial apply_proposed_diff under session 1 must succeed");
    // Seed a fresh human session (new GrantId G2 != G1) and replay apply_proposed_diff.
    let session2_token = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            actor,
            &AuthSessionId::from_bytes([0xEC; 16]),
            &session2_token,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let auth_g2 = fixture
        .control
        .resolve(support::evidence(
            AuthEvidenceKind::Session,
            session2_token.secret.expose(),
        ))
        .await
        .unwrap();
    assert_ne!(auth_g2.grant(), owner.auth().grant());
    let owner_g2 = AccountContext::new(auth_g2, budget());
    let applied_g2 = local
        .registry
        .apply_proposed_diff(owner_g2, apply_req)
        .await
        .expect("replaying apply_proposed_diff under rotated human GrantId must succeed");
    assert_eq!(applied_g2.result, applied_g1.result);

    // (10) create_ability when `.abilities` already exists preserves CommitEffect::NotCommitted
    //      on operational create_note failure, while a Space/project without `.abilities`
    //      escalates to CommitEffect::Unknown after creating `.abilities`.
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "preexisting-abilities-seed",
            "description": "Ensure s2/.abilities already exists.",
            "instructions": "Seed body.\n",
            "placement": { "home": "space", "space": s2.slug },
        }),
    )
    .await
    .expect("seeding s2/.abilities must succeed");
    fixture.projections.fail_next_create_note_not_committed();
    let pre_err = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "preexisting-abilities-no-unknown",
            "description": "Operational failure after pre-existing .abilities.",
            "instructions": "Body.\n",
            "placement": { "home": "space", "space": s2.slug },
        }),
    )
    .await;
    assert!(
        matches!(
            pre_err,
            Err(PortError::DeadlineExceeded(ref f))
                if f.effect() == CommitEffect::NotCommitted
        ),
        "operational create_note failure with pre-existing .abilities must preserve CommitEffect::NotCommitted, got {:?}",
        pre_err.err()
    );
    let s2_p3_handle = format!("{}/h-s2-p3", s2.slug);
    fixture.projections.fail_next_create_note_not_committed();
    let fresh_dir_err = call_mcp(
        &fixture.registry,
        owner,
        [0xEC, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_ability",
        json!({
            "kind": "role",
            "name": "fresh-abilities-escalates-unknown",
            "description": "Operational failure after creating fresh .abilities.",
            "instructions": "Body.\n",
            "placement": { "home": "project", "project": s2_p3_handle },
        }),
    )
    .await;
    assert!(
        matches!(
            fresh_dir_err,
            Err(PortError::DeadlineExceeded(ref f))
                if f.effect() == CommitEffect::Unknown
        ),
        "operational create_note failure after newly creating .abilities must escalate to CommitEffect::Unknown, got {:?}",
        fresh_dir_err.err()
    );
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_offer_and_selected_skill_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    owner: &AccountContext,
    pscope: &HistoryScope,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
) {
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);

    // (11) `list_offer_models` must authenticate/authorize caller BEFORE querying
    //      `provider_attachments` so non-DirectHuman callers get uniform AccessDenied
    //      for both existing and nonexistent offer IDs (no pre-auth oracle).
    let offers = local
        .provider
        .list_offers(
            s2_sc.clone(),
            ProviderOfferQuery {
                project: None,
                page: ControlPageRequest::new(20, None).unwrap(),
            },
        )
        .await
        .unwrap();
    let existing_offer = offers
        .items
        .first()
        .expect("s2 has an approved offer")
        .attachment
        .id
        .clone();
    let ro_pat = fixture.pat(BearerScope::Read, false).await;
    let ro_s2_sc = SpaceContext::new(ro_pat.auth().clone(), s2.history.clone(), budget()).unwrap();
    let nonexistent_offer =
        RequestId::from_bytes([0xED, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    for candidate in [existing_offer, nonexistent_offer] {
        let err = local
            .provider
            .list_offer_models(
                ro_s2_sc.clone(),
                candidate,
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await;
        assert!(
            matches!(err, Err(PortError::Domain(DomainError::AccessDenied))),
            "non-DirectHuman list_offer_models must return uniform AccessDenied before attachment lookup, got {:?}",
            err.err()
        );
    }

    // (12) `provider_ability_allowed` rejects `selected-projects` OwnedSpace ability in
    //      a Space-level chat (`primary_project: None`) AND in a Personal chat (foreign
    //      OwnedSpace) so recorded provenance never bricks the next completion step.
    let sel_skill = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "h6a-selected-space-skill",
            "description": "Selected-project space skill.",
            "instructions": "Only valid in s2_p1.\n",
            "placement": { "home": "space", "space": s2.slug },
            "availability": { "mode": "selected-projects", "projects": [s2_p1_handle.clone()] },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": sel_skill["ref"],
            "versionToken": sel_skill["versionToken"],
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    // Space-level chat in s2 (`primary_project: None`).
    let space_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xED, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            s2.history.space_id.clone(),
            ChatAudience::Shared,
            owner
                .auth()
                .restrict_to_space(&s2.history.space_id)
                .unwrap()
                .spaces()
                .clone(),
        )
        .unwrap();
    let space_chat_use = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(space_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xED, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "use_skill",
            json!({ "skill": "h6a-selected-space-skill", "project": s2_p1_handle }),
        )
        .await;
    assert!(
        matches!(
            space_chat_use,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "selected-projects OwnedSpace skill must not be admitted in a Space-level chat without primary_project, got {:?}",
        space_chat_use.err()
    );
    // Authoring view without a `project` filter must report `enabled: true` for an enabled
    // `selected-projects` ability (matching `get_ability`), while runtime view hides it.
    let authoring_list = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "list_abilities",
        json!({ "view": "authoring", "q": "h6a-selected-space-skill" }),
    )
    .await
    .unwrap()
    .structured_content;
    let authoring_item = authoring_list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "h6a-selected-space-skill")
        .expect("selected-projects skill must appear in authoring list without project filter");
    assert_eq!(
        authoring_item["enabled"],
        json!(true),
        "authoring list must report enabled=true for enabled selected-projects ability"
    );
    let runtime_list = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "list_abilities",
        json!({ "view": "runtime", "q": "h6a-selected-space-skill" }),
    )
    .await
    .unwrap()
    .structured_content;
    assert!(
        runtime_list["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["name"] != "h6a-selected-space-skill"),
        "runtime list without matching project must omit selected-projects ability"
    );

    // Personal chat in personal Space calling foreign OwnedSpace `selected-projects` skill:
    // succeeds WITH matching `project: s2_p1_handle` (recording `s2_p1` in provenance so
    // ProviderService::validate_dispatch admits it under Space-wide consent too!), and fails
    // ResourceNotFound WITHOUT `project` or with a non-selected project.
    let pers_run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xED, 12, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let pers_chat_use = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(pers_run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xED, 12, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "use_skill",
            json!({ "skill": "h6a-selected-space-skill", "project": s2_p1_handle }),
        )
        .await
        .expect(
            "foreign OwnedSpace selected-projects skill with matching project must be admitted in Personal chat",
        );
    assert!(
        !pers_chat_use.provenance.projects.is_empty(),
        "foreign OwnedSpace selected-projects skill must witness its scoped project in provenance"
    );
    let pers_chat_missing_proj = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(pers_run_auth, budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xED, 12, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                ]),
            },
            "use_skill",
            json!({ "skill": "h6a-selected-space-skill" }),
        )
        .await;
    assert!(
        matches!(
            pers_chat_missing_proj,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "foreign OwnedSpace selected-projects skill without matching project must fail ResourceNotFound, got {:?}",
        pers_chat_missing_proj.err()
    );
}

#[inline(never)]
async fn hardened_removed_space_episode_seams(
    fixture: &mut RuntimeFixture,
    owner: &AccountContext,
    actor: &PrincipalId,
) {
    // (13) `named_episode_project_hint` skips episodes bound to a Space the caller was
    //      removed from, matching `start_or_resume_episode` so `start_session` with a
    //      role does not lock out an unnarrowed DirectHuman.
    let s_rm = fixture
        .control
        .create_space(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, owner, 0xED).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xED, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
                    kind: SpaceKind::Shared,
                    name: "Removable Ep Space".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner_fresh = fresh_owner(fixture).await;
    let p_rm = create_project_folder(
        fixture,
        &s_rm.history,
        actor,
        FolderId::from_bytes([0xED, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        "p-rm",
    )
    .await;
    let bob_rm = fixture
        .control
        .create_account(
            owner_fresh.clone(),
            AccountMutation {
                identity: identity(fixture, &owner_fresh, 0xEC).await,
                input: NewAccount {
                    username: "bob_removed_space_ep".into(),
                    email: None,
                    display_name: "Bob RM".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let s_rm_sc =
        SpaceContext::new(owner_fresh.auth().clone(), s_rm.history.clone(), budget()).unwrap();
    let add_bob = fixture
        .control
        .change_membership(
            s_rm_sc.clone(),
            MembershipChange {
                command: CommandKey::from_bytes([
                    0xED, 13, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                ]),
                expected: ControlRevision::ZERO,
                member: bob_rm.id.clone(),
                role: Some(SpaceRole::Editor),
            },
        )
        .await
        .unwrap();
    let bob_tok = mint(TokenKind::Session).unwrap();
    fixture
        .storage
        .observer
        .seed_session(
            &bob_rm.id,
            &AuthSessionId::from_bytes([0xED, 13, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            &bob_tok,
            fixture.storage.clock.0.load(Ordering::SeqCst),
        )
        .await;
    let bob_auth1 = fixture
        .control
        .resolve(support::evidence(
            AuthEvidenceKind::Session,
            bob_tok.secret.expose(),
        ))
        .await
        .unwrap();
    let bob_acc1 = AccountContext::new(bob_auth1, budget());
    let _ = call_mcp(
        &fixture.registry,
        &bob_acc1,
        [0xED, 13, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "start_session",
        json!({
            "project": format!("{}/p-rm", s_rm.slug),
            "session": { "name": "h6a-removed-space-ep" },
        }),
    )
    .await
    .expect("bob starts named episode in s_rm");
    let _ = fixture
        .control
        .change_membership(
            s_rm_sc,
            MembershipChange {
                command: CommandKey::from_bytes([
                    0xED, 13, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                expected: add_bob.revision,
                member: bob_rm.id.clone(),
                role: None,
            },
        )
        .await
        .unwrap();
    let bob_auth2 = fixture
        .control
        .resolve(support::evidence(
            AuthEvidenceKind::Session,
            bob_tok.secret.expose(),
        ))
        .await
        .unwrap();
    let bob_acc2 = AccountContext::new(bob_auth2, budget());
    let sys_role = fixture
        .control
        .discover_abilities(
            bob_acc2.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: None,
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.descriptor.enabled && item.descriptor.healthy)
        .expect("enabled system role for bob")
        .descriptor
        .name;
    let bob_reopened = call_mcp(
        &fixture.registry,
        &bob_acc2,
        [0xED, 13, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "start_session",
        json!({
            "session": { "name": "h6a-removed-space-ep" },
            "role": sys_role,
        }),
    )
    .await
    .expect("unnarrowed caller must reopen same-named episode with role after Space removal");
    assert!(bob_reopened.structured_content["session"]["id"].is_string());
    let _ = p_rm;
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_trashed_source_trail_seams(
    fixture: &RuntimeFixture,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let owner_fresh = fresh_owner(fixture).await;
    // (14) Promoted ability trail follows cleanly via follow_ability, resolve_ability(Exact),
    //      get_ability, and MCP get_ability even after its historical source project is trashed.
    let p_src_id = FolderId::from_bytes([0xED, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_src_id.clone(),
            parent: None,
            slug: "h6a-trail-src".into(),
            display_name: "Trail Source Project".into(),
            is_project: true,
            project_slug: Some("h6a-trail-src".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let p_src_rev = fixture
        .canonical
        .resolve_folder_path(s2_sc.clone(), Some(p_src_id.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    let p_src_handle = format!("{}/h6a-trail-src", s2.slug);
    let created_src = call_mcp(
        &fixture.registry,
        &owner_fresh,
        [0xED, 14, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "h6a-promoted-trashed-src",
            "description": "Promoted from trashed project.",
            "instructions": "Trail continuity body.\n",
            "placement": { "home": "project", "project": p_src_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let old_ar1 = created_src["ref"].as_str().unwrap().to_owned();
    let old_ver = created_src["versionToken"].as_str().unwrap().to_owned();
    let old_ref = fixture
        .control
        .discover_abilities(
            owner_fresh.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: Some(FolderRef {
                    space_id: s2.history.space_id.clone(),
                    folder_id: p_src_id.clone(),
                }),
                kind: Some(AbilityKind::Role),
                name: Some("h6a-promoted-trashed-src".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .next()
        .expect("source project skill discovered")
        .descriptor
        .reference;
    let _ = call_mcp(
        &fixture.registry,
        &owner_fresh,
        [0xED, 14, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": old_ar1,
            "versionToken": old_ver,
            "home": { "home": "space" },
            "availability": { "mode": "all-projects" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    // Trash the historical source project `p_src`.
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &p_src_id,
            &p_src_rev,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    let followed_after_trash = fixture
        .control
        .follow_ability(owner_fresh.clone(), old_ref.clone())
        .await
        .expect("follow_ability must succeed after historical source project is trashed");
    assert_eq!(
        followed_after_trash.placement,
        AbilityPlacement::OwnedSpace(s2.history.space_id.clone())
    );
    assert!(matches!(
        fixture
            .control
            .resolve_ability(
                owner_fresh.clone(),
                AbilitySelection::Exact {
                    reference: old_ref.clone(),
                    project: Some(s2_p1.clone()),
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Resolved(_)
    ));
    fixture
        .control
        .get_ability(owner_fresh.clone(), old_ref, Some(s2_p1.clone()))
        .await
        .expect("control.get_ability must succeed after historical source project is trashed");
    let mcp_after_trash = call_mcp(
        &fixture.registry,
        &owner_fresh,
        [0xED, 14, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "get_ability",
        json!({ "ref": old_ar1 }),
    )
    .await
    .expect("MCP get_ability must follow promoted trail after historical source project is trashed")
    .structured_content;
    assert_eq!(mcp_after_trash["name"], "h6a-promoted-trashed-src");
}

#[inline(never)]
async fn hardened_schedule_and_legacy_replay_seams(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    s2: &AccessibleSpace,
    actor: &PrincipalId,
) {
    let owner = &fresh_owner(fixture).await;

    // (15) Schedule mutations: valid 31.5 KiB JSON-escapable `init_prompt` (~63 KiB JSON)
    //      succeeds without overflowing the 64 KiB cap, omits private `title`/`init_prompt`
    //      from `control_commands.safe_result`, and replays legacy `0001` receipts cleanly
    //      (alongside `put_context_set` and `revoke_attachment` legacy `0001` receipts).
    let sys_role = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: None,
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| {
            item.descriptor.reference.placement == AbilityPlacement::System
                && item.descriptor.enabled
                && item.binding_enabled
                && item.preference_enabled
        })
        .expect("enabled system role for large schedule test")
        .descriptor;
    let large_prompt = format!("SECRET-PROMPT-SCHED-{}", "\"".repeat(31_480));
    assert!(large_prompt.len() <= 32_768);
    let sched_id = ScheduleId::from_bytes([0xED, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let next_slot = Timestamp::parse("2030-01-01T09:00:00Z").unwrap();
    let sched_limits = RunLimits {
        max_steps: 4,
        max_tokens: 64_000,
        timeout_ms: 15_000,
    };
    let sched_cmd_id = |idx: u8, rev: ControlRevision| AccountCommandIdentity {
        owner: owner.auth().principal().clone(),
        actor: owner.auth().principal().clone(),
        key: CommandKey::from_bytes([0xED, 15, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, idx]),
        expected: rev,
        hash: ContentDigest::from_bytes([idx; 32]),
    };
    let rev0 = fixture
        .control
        .account(owner.clone(), owner.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    let create_sched_mut = AccountMutation {
        identity: sched_cmd_id(1, rev0),
        input: CreateSchedule {
            id: sched_id.clone(),
            definition: ScheduleDefinition {
                space: s2.history.space_id.clone(),
                project: None,
                title: "SECRET-SCHED-TITLE-HARD".into(),
                init_prompt: large_prompt.clone(),
                cron: "0 0 9 * * * *".into(),
                timezone: "UTC".into(),
                approved_role: sys_role.reference.clone(),
                limits: sched_limits,
            },
            approved_skills: sys_role.attached_skills.clone(),
            next_slot,
            paused: false,
        },
    };
    let created_sched = fixture
        .control
        .create_schedule(owner.clone(), create_sched_mut.clone())
        .await
        .expect("create_schedule with 31.5 KiB JSON-escapable init_prompt must succeed");
    assert_eq!(created_sched.value.definition.init_prompt, large_prompt);
    let replayed_sched = fixture
        .control
        .create_schedule(owner.clone(), create_sched_mut.clone())
        .await
        .expect("create_schedule exact replay must succeed");
    assert_eq!(replayed_sched.value.id, created_sched.value.id);
    assert_eq!(replayed_sched.value.definition.init_prompt, large_prompt);

    let update_prompt = format!("SECRET-PROMPT-UPD-SCHED-{}", "\"".repeat(31_470));
    let update_sched_mut = AccountMutation {
        identity: sched_cmd_id(2, created_sched.revision),
        input: UpdateSchedule {
            schedule: sched_id.clone(),
            expected: created_sched.value.revision,
            definition: ScheduleDefinition {
                space: s2.history.space_id.clone(),
                project: None,
                title: "SECRET-SCHED-TITLE-UPD-HARD".into(),
                init_prompt: update_prompt.clone(),
                cron: "0 0 9 * * * *".into(),
                timezone: "UTC".into(),
                approved_role: sys_role.reference.clone(),
                limits: sched_limits,
            },
            approved_skills: None,
            next_slot: Some(next_slot),
            paused: false,
        },
    };
    let updated_sched = fixture
        .control
        .update_schedule(owner.clone(), update_sched_mut.clone())
        .await
        .expect("update_schedule with 31.5 KiB JSON-escapable init_prompt must succeed");
    assert_eq!(updated_sched.value.definition.init_prompt, update_prompt);

    let leaked_prompt_rows = fixture
        .storage
        .observer
        .count(
            "SELECT COUNT(*) FROM control_commands \
             WHERE safe_result LIKE '%SECRET-SCHED-TITLE-HARD%' \
                OR safe_result LIKE '%SECRET-SCHED-TITLE-UPD-HARD%' \
                OR safe_result LIKE '%SECRET-PROMPT-SCHED%' \
                OR safe_result LIKE '%SECRET-PROMPT-UPD-SCHED%'",
        )
        .await;
    assert_eq!(
        leaked_prompt_rows, 0,
        "control_commands.safe_result must never persist private schedule title or init_prompt"
    );

    // Verify 0001 legacy safe_result replay compatibility for create_schedule, delete_schedule,
    // put_context_set, and revoke_attachment.
    fixture
        .storage
        .observer
        .execute(
            "UPDATE control_commands \
             SET safe_result = '{\"value\":\"' || (SELECT schedule_id FROM agent_schedules WHERE title='SECRET-SCHED-TITLE-UPD-HARD' LIMIT 1) || '\",\"events\":[]}' \
             WHERE target='create-schedule' \
               AND result_revision = (SELECT MAX(result_revision) FROM control_commands WHERE target='create-schedule')",
        )
        .await;
    let legacy_create_replay = fixture
        .control
        .create_schedule(owner.clone(), create_sched_mut)
        .await
        .expect("legacy 0001 create-schedule safe_result must replay cleanly");
    assert_eq!(legacy_create_replay.value.id, sched_id);

    let delete_sched_mut = AccountMutation {
        identity: sched_cmd_id(3, updated_sched.revision),
        input: DeleteSchedule {
            schedule: sched_id.clone(),
            expected: updated_sched.value.revision,
        },
    };
    let del_commit = fixture
        .control
        .delete_schedule(owner.clone(), delete_sched_mut.clone())
        .await
        .unwrap();
    fixture
        .storage
        .observer
        .execute(
            "UPDATE control_commands \
             SET safe_result = '{\"value\":\"' || (SELECT schedule_id FROM agent_schedules WHERE title='SECRET-SCHED-TITLE-UPD-HARD' LIMIT 1) || '\",\"events\":[]}' \
             WHERE target='delete-schedule' \
               AND result_revision = (SELECT MAX(result_revision) FROM control_commands WHERE target='delete-schedule')",
        )
        .await;
    fixture
        .control
        .delete_schedule(owner.clone(), delete_sched_mut)
        .await
        .expect("legacy 0001 delete-schedule safe_result must replay cleanly");

    let cs_id = ContextSetId::from_bytes([0xED, 15, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let cs_mut = AccountMutation {
        identity: sched_cmd_id(4, del_commit.revision),
        input: PutContextSet {
            id: cs_id.clone(),
            expected: None,
            home: s2.history.space_id.clone(),
            name: "Legacy 0001 Replay Set".into(),
            notes: vec![],
        },
    };
    let cs_commit = fixture
        .control
        .put_context_set(owner.clone(), cs_mut.clone())
        .await
        .unwrap();
    fixture
        .storage
        .observer
        .execute(
            "UPDATE control_commands \
             SET safe_result = '{\"value\":\"' || (SELECT set_id FROM context_sets WHERE name='Legacy 0001 Replay Set' LIMIT 1) || '\",\"events\":[]}' \
             WHERE target='put-context-set' \
               AND result_revision = (SELECT MAX(result_revision) FROM control_commands WHERE target='put-context-set')",
        )
        .await;
    let legacy_cs_replay = fixture
        .control
        .put_context_set(owner.clone(), cs_mut)
        .await
        .expect("legacy 0001 put-context-set safe_result must replay cleanly");
    assert_eq!(legacy_cs_replay.value.id, cs_id);

    let tmp_res_commit = local
        .provider
        .create_resource(
            owner.clone(),
            AccountMutation {
                identity: sched_cmd_id(5, cs_commit.revision),
                input: ProviderResourceSpec {
                    id: ProviderResourceId::from_bytes([
                        0xED, 15, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    name: "Legacy Revoke Resource".into(),
                    wire: ProviderWireKind::Ollama,
                    base_url: "https://api.example.com/v1".into(),
                    credential: None,
                    headers: vec![],
                    limits: ProviderLimits::default(),
                    timeout_ms: 5_000,
                },
            },
        )
        .await
        .unwrap();
    let tmp_res = tmp_res_commit.value;
    let tmp_att_commit = local
        .provider
        .request_attachment(
            owner.clone(),
            AccountMutation {
                identity: sched_cmd_id(6, tmp_res_commit.revision),
                input: RequestProviderAttachment {
                    id: RequestId::from_bytes([0xED, 15, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    expected: None,
                    resource: tmp_res.id.clone(),
                    resource_consent_epoch: tmp_res.consent_epoch,
                    credential_consent_epoch: None,
                    target: ProviderAttachmentTarget::Personal {
                        owner: actor.clone(),
                        space: s2.history.space_id.clone(),
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
    let tmp_att = tmp_att_commit.value;
    let revoke_mut = AccountMutation {
        identity: sched_cmd_id(7, tmp_att_commit.revision),
        input: RevokeProviderAttachment {
            id: tmp_att.id.clone(),
            expected: tmp_att.revision,
        },
    };
    local
        .provider
        .revoke_attachment(owner.clone(), revoke_mut.clone())
        .await
        .unwrap();
    fixture
        .storage
        .observer
        .execute(
            "UPDATE control_commands \
             SET safe_result = '{\"value\":null,\"events\":[]}' \
             WHERE target='revoke-provider-attachment' \
               AND result_revision = (SELECT MAX(result_revision) FROM control_commands WHERE target='revoke-provider-attachment')",
        )
        .await;
    local
        .provider
        .revoke_attachment(owner.clone(), revoke_mut)
        .await
        .expect("legacy 0001 revoke-provider-attachment safe_result must replay cleanly");
}

#[inline(never)]
async fn hardened_prefix_strip_crash_replay_seams(
    fixture: &mut RuntimeFixture,
    s2: &AccessibleSpace,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let owner = &fresh_owner(fixture).await;
    // (16) `create_note` and project-pinned `move_note` survive a crash between
    //      `ensure_folder_path` commit and `record_journal_with_key` followed by
    //      project rename (replaying from `stripped_segments` in `{label}_existed`).
    let p_ren_id = FolderId::from_bytes([0xED, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_ren_ref = FolderRef {
        space_id: s2.history.space_id.clone(),
        folder_id: p_ren_id.clone(),
    };
    fixture
        .canonical
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_ren_id.clone(),
            parent: None,
            slug: "h6a-alpha".into(),
            display_name: "Strip Replay Alpha".into(),
            is_project: true,
            project_slug: Some("h6a-alpha".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let alpha_handle = format!("{}/h6a-alpha", s2.slug);
    let cn_key = [0xED, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let cn_args = json!({
        "project": alpha_handle,
        "path": "h6a-alpha/docs-sub",
        "title": "Prefix Strip Create Replay",
        "body": "Body.\n",
    });
    let cn_1 = call_mcp(
        &fixture.registry,
        owner,
        cn_key,
        "create_note",
        cn_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    // Simulate crash right before `record_journal_with_key("create_destination")`:
    // delete ONLY `create_destination`, keeping `create_destination_existed` and `create_project`.
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='create_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    // Rename project `h6a-alpha` -> `h6a-beta`.
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "rename_project",
        json!({
            "project": alpha_handle,
            "slug": "h6a-beta",
        }),
    )
    .await
    .unwrap();
    let cn_2 = call_mcp(&fixture.registry, owner, cn_key, "create_note", cn_args)
        .await
        .expect("create_note must replay cleanly after create_destination loss and project rename")
        .structured_content;
    assert_eq!(cn_2["noteId"], cn_1["noteId"]);

    // Project-pinned `move_note` with the exact same crash + rename window.
    let pinned_acc = AccountContext::new(
        owner
            .auth()
            .restrict_to_space(&s2.history.space_id)
            .unwrap()
            .restrict_to_project(&p_ren_ref)
            .unwrap(),
        budget(),
    );
    let mv_key = [0xED, 16, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let mv_args = json!({
        "ref": cn_1["noteId"],
        "toFolder": "h6a-beta/moved-sub",
    });
    let mv_1 = call_mcp(
        &fixture.registry,
        &pinned_acc,
        mv_key,
        "move_note",
        mv_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='move_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    let beta_handle = format!("{}/h6a-beta", s2.slug);
    let _ = call_mcp(
        &fixture.registry,
        owner,
        [0xED, 16, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "rename_project",
        json!({
            "project": beta_handle,
            "slug": "h6a-gamma",
        }),
    )
    .await
    .unwrap();
    let mv_2 = call_mcp(&fixture.registry, &pinned_acc, mv_key, "move_note", mv_args)
        .await
        .expect("project-pinned move_note must replay cleanly after move_destination loss and project rename")
        .structured_content;
    assert_eq!(mv_2["versionToken"], mv_1["versionToken"]);
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_multi_project_secondary_space_seams(
    fixture: &RuntimeFixture,
    pscope: &HistoryScope,
    s1: &AccessibleSpace,
    s1_p1: &FolderRef,
    s1_p2: &FolderRef,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lp = loopback_provider(fixture, &owner, &listener, 0xEE, true).await;
    // Approve personal + two separate project-only attachments in s1 (NO Space-wide s1 consent):
    // s1_p1 consents [UserDoc], s1_p2 consents [UserDoc, AgentMemory].
    approve_disclosure(
        fixture,
        &owner,
        &lp,
        0x71,
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
        &lp,
        0x72,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: s1.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &lp,
        0x73,
        ProviderAttachmentTarget::Project(s1_p1.clone()),
        [DocClass::UserDoc].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &lp,
        0x74,
        ProviderAttachmentTarget::Project(s1_p2.clone()),
        [DocClass::UserDoc, DocClass::AgentMemory].into(),
    )
    .await;
    // Create unconsented third project s1_p3 in s1, plus test notes in s1_p1, s1_p2, s1_p3.
    let s1_epoch = fixture
        .canonical
        .read_space(&s1.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let s1_p3_id = FolderId::from_bytes([0xEE, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s1.history.clone(),
            active_epoch: s1_epoch,
            folder_id: s1_p3_id.clone(),
            parent: None,
            slug: "h6b-unconsented-p3".into(),
            display_name: "Unconsented Secondary P3".into(),
            is_project: true,
            project_slug: Some("h6b-unconsented-p3".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let s1_sc = SpaceContext::new(owner.auth().clone(), s1.history.clone(), budget()).unwrap();
    let mk_note = |tag: u8, parent: FolderId, slug: &str, class: DocClass| {
        let s1_sc = s1_sc.clone();
        let hist = s1.history.clone();
        let actor = actor.clone();
        let slug = slug.to_owned();
        async move {
            let nid = NoteId::from_bytes([0xEE, 2, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
            fixture
                .canonical
                .create_note(
                    s1_sc,
                    Mutation {
                        identity: CommandIdentity {
                            scope: hist,
                            actor,
                            key: CommandKey::from_bytes([
                                0xEE, 2, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                            ]),
                            hash: ContentDigest::from_bytes([tag; 32]),
                        },
                        preconditions: Preconditions::default(),
                        input: CreateNote {
                            folder_page: false,
                            note: nid.clone(),
                            parent: Some(parent),
                            slug,
                            class,
                            carrier: format!("---\ntitle: h6b-{tag}\n---\nBody {tag}.\n"),
                        },
                    },
                )
                .await
                .unwrap();
            nid
        }
    };
    let n_p1 = mk_note(1, s1_p1.folder_id.clone(), "h6b-p1-doc", DocClass::UserDoc).await;
    let n_p2 = mk_note(2, s1_p2.folder_id.clone(), "h6b-p2-doc", DocClass::UserDoc).await;
    let n_p1_mem = mk_note(
        3,
        s1_p1.folder_id.clone(),
        "h6b-p1-mem",
        DocClass::AgentMemory,
    )
    .await;
    let n_p3 = mk_note(4, s1_p3_id.clone(), "h6b-p3-doc", DocClass::UserDoc).await;

    let run_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEE, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let projects_res = lp
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(run_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: lp.resource.id.clone(),
                    model: lp.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xEE, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "get_my_projects",
            json!({}),
        )
        .await
        .unwrap();
    let proj_ids: Vec<&str> = projects_res.structured_content["projects"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["projectId"].as_str())
        .collect();
    assert!(proj_ids.contains(&s1_p1.folder_id.as_str()));
    assert!(proj_ids.contains(&s1_p2.folder_id.as_str()));
    assert!(!proj_ids.contains(&s1_p3_id.as_str()));
    assert!(projects_res.provenance.projects.contains(s1_p1));
    assert!(projects_res.provenance.projects.contains(s1_p2));

    let primary_ctx = SpaceContext::new(run_auth.clone(), pscope.clone(), budget()).unwrap();
    let primary_sel = lp
        .provider
        .select_provider(
            primary_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(lp.resource.id.clone()),
                model: Some(lp.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let s1_run_ctx = SpaceContext::new(run_auth.clone(), s1.history.clone(), budget()).unwrap();
    let sel_p1 = lp
        .provider
        .select_provider(
            s1_run_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(lp.resource.id.clone()),
                model: Some(lp.model.clone()),
                project: Some(s1_p1.clone()),
            },
        )
        .await
        .unwrap();
    let sel_p2 = lp
        .provider
        .select_provider(
            s1_run_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(lp.resource.id.clone()),
                model: Some(lp.model.clone()),
                project: Some(s1_p2.clone()),
            },
        )
        .await
        .unwrap();
    let read_doc = |nid: &NoteId| {
        let s1_run_ctx = s1_run_ctx.clone();
        let nid = nid.clone();
        async move {
            fixture
                .canonical
                .get_note(
                    s1_run_ctx,
                    GetNote {
                        note: nid,
                        revision: None,
                        causal: CausalBasis::Exact(notarium_core::receipt::ReceiptSet::default()),
                    },
                )
                .await
                .unwrap()
                .document
        }
    };
    let doc_p1 = read_doc(&n_p1).await;
    let doc_p2 = read_doc(&n_p2).await;
    let doc_p1_mem = read_doc(&n_p1_mem).await;
    let doc_p3 = read_doc(&n_p3).await;
    let msg_p1 = notarium_core::classes::ProviderMessage::Document(
        notarium_core::classes::ClassEgressFence::provider(
            doc_p1,
            s1_run_ctx.auth(),
            &sel_p1.policy,
        )
        .unwrap(),
    );
    let msg_p2 = notarium_core::classes::ProviderMessage::Document(
        notarium_core::classes::ClassEgressFence::provider(
            doc_p2,
            s1_run_ctx.auth(),
            &sel_p2.policy,
        )
        .unwrap(),
    );
    let sec_both = vec![s1_p1.clone(), s1_p2.clone()];

    // Positive: combined dispatch across BOTH consented projects in secondary Space s1 succeeds.
    let ok_req = CompletionRequest {
        intent: CommandKey::from_bytes([0xEE, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        selection: primary_sel.clone(),
        secondary_projects: sec_both.clone(),
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: None,
            parts: vec![msg_p1, msg_p2],
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
    let wire_task = tokio::spawn(async move {
        let (mut wire, _prompt) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .expect("multi-project secondary Space dispatch must reach provider");
        send_ollama(
            &mut wire,
            json!({"role": "assistant", "content": "Multi-project ok."}),
            "stop",
        )
        .await;
        listener
    });
    let mut stream = lp
        .provider
        .complete(primary_ctx.clone(), ok_req)
        .await
        .expect("multi-project secondary Space completion must be admitted");
    let mut got_done = false;
    while let Some(ev) = stream.next().await.unwrap() {
        got_done |= matches!(ev, CompletionEvent::Finished(CompletionFinish::Stop));
    }
    assert!(got_done);
    let listener = wire_task.await.unwrap();

    // Negative 1: AgentMemory note in s1_p1 (which only consented UserDoc) cannot borrow
    // s1_p2's AgentMemory consent.
    let msg_p1_mem = notarium_core::classes::ProviderMessage::Document(
        notarium_core::classes::ClassEgressFence::provider(
            doc_p1_mem,
            s1_run_ctx.auth(),
            &sel_p2.policy,
        )
        .unwrap(),
    );
    let mem_err = match lp
        .provider
        .complete(
            primary_ctx.clone(),
            CompletionRequest {
                intent: CommandKey::from_bytes([0xEE, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                selection: primary_sel.clone(),
                secondary_projects: sec_both.clone(),
                messages: vec![CompletionMessage {
                    role: CompletionRole::User,
                    instruction: None,
                    parts: vec![msg_p1_mem],
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
        )
        .await
    {
        Ok(mut stream) => stream
            .next()
            .await
            .expect_err("AgentMemory note in s1_p1 must not borrow s1_p2's AgentMemory consent"),
        Err(err) => err,
    };
    assert!(
        matches!(
            mem_err,
            PortError::Domain(DomainError::ValidationFailed { .. } | DomainError::AccessDenied)
        ),
        "AgentMemory note in s1_p1 must not borrow s1_p2's AgentMemory consent: {mem_err:?}"
    );

    // Negative 2: note in unconsented third project s1_p3 must fail closed with AccessDenied.
    let msg_p3 = notarium_core::classes::ProviderMessage::Document(
        notarium_core::classes::ClassEgressFence::provider(
            doc_p3,
            s1_run_ctx.auth(),
            &sel_p1.policy,
        )
        .unwrap(),
    );
    let p3_err = match lp
        .provider
        .complete(
            primary_ctx.clone(),
            CompletionRequest {
                intent: CommandKey::from_bytes([0xEE, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
                selection: primary_sel.clone(),
                secondary_projects: sec_both.clone(),
                messages: vec![CompletionMessage {
                    role: CompletionRole::User,
                    instruction: None,
                    parts: vec![msg_p3],
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
        )
        .await
    {
        Ok(mut stream) => stream
            .next()
            .await
            .expect_err("note in unconsented s1_p3 must fail with AccessDenied"),
        Err(err) => err,
    };
    assert!(
        matches!(p3_err, PortError::Domain(DomainError::AccessDenied)),
        "note in unconsented s1_p3 must fail with AccessDenied, got {p3_err:?}"
    );

    // Negative 3: Space-level metadata disclosure in s1 (no Space-wide consent) must fail closed.
    let space_meta = fixture
        .canonical
        .disclosure(
            AccountContext::new(run_auth.clone(), budget()),
            CatalogDisclosure::Space(s1.history.clone()),
        )
        .await
        .unwrap();
    let msg_space = notarium_core::classes::ProviderMessage::Metadata(
        notarium_core::classes::ClassEgressFence::provider_metadata(
            space_meta,
            s1_run_ctx.auth(),
            &sel_p1.policy,
        )
        .unwrap(),
    );
    let space_err = match lp
        .provider
        .complete(
            primary_ctx,
            CompletionRequest {
                intent: CommandKey::from_bytes([0xEE, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
                selection: primary_sel,
                secondary_projects: sec_both,
                messages: vec![CompletionMessage {
                    role: CompletionRole::User,
                    instruction: None,
                    parts: vec![msg_space],
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
        )
        .await
    {
        Ok(mut stream) => stream
            .next()
            .await
            .expect_err("Space-level metadata must not pass under project-only secondary consents"),
        Err(err) => err,
    };
    assert!(
        matches!(space_err, PortError::Domain(DomainError::AccessDenied)),
        "Space-level metadata must not pass under project-only secondary consents, got {space_err:?}"
    );
    assert!(
        timeout(Duration::from_millis(80), listener.accept())
            .await
            .is_err(),
        "denied secondary Space dispatches must never hit the provider socket"
    );
}

#[inline(never)]
async fn hardened_retrieval_error_and_taint_oracle_seams(
    fixture: &RuntimeFixture,
    local: &LoopbackProvider,
    pscope: &HistoryScope,
    s2: &AccessibleSpace,
) {
    let owner = fresh_owner(fixture).await;
    let existing = format!("{}/h-s2-p1", s2.slug);
    let nonexistent = format!("{}/no-such-h6b-project", s2.slug);
    let long_query = "a".repeat(4097);
    let probes = [
        ("recall", json!({ "query": "probe", "depth": 4 })),
        ("recall", json!({ "query": "probe", "budgetTokens": 0 })),
        ("recall", json!({ "query": "probe", "budgetTokens": 1 })),
        ("search", json!({ "query": long_query })),
    ];
    for (p_idx, (tool, base_args)) in probes.into_iter().enumerate() {
        for (t_idx, proj) in [&existing, &nonexistent].into_iter().enumerate() {
            let mut args = base_args.clone();
            args["project"] = json!(proj);
            let run_auth = owner
                .auth()
                .for_agent_run(
                    AgentRunId::from_bytes([
                        0xEF,
                        1,
                        p_idx as u8,
                        t_idx as u8,
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
                    pscope.space_id.clone(),
                    ChatAudience::Personal,
                    owner.auth().spaces().clone(),
                )
                .unwrap();
            let err = local
                .registry
                .call_tool(
                    McpInvocationContext {
                        account: AccountContext::new(run_auth.clone(), budget()),
                        target: EgressTarget::InAppProvider {
                            provider: local.resource.id.clone(),
                            model: local.model.clone(),
                            primary_project: None,
                        },
                        request_key: CommandKey::from_bytes([
                            0xEF,
                            1,
                            p_idx as u8,
                            t_idx as u8,
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
                            2,
                        ]),
                    },
                    tool,
                    args,
                )
                .await;
            assert!(
                matches!(
                    err,
                    Err(PortError::Domain(DomainError::ValidationFailed { .. }))
                ),
                "{tool} invalid probe #{p_idx} for {proj} must fail ValidationFailed before target resolution, got {:?}",
                err.err()
            );
            assert!(
                !run_auth.taint().is_tainted(),
                "{tool} pre-target validation error #{p_idx} must not flip taint"
            );
        }
    }

    // Post-crossing search query error (>64 clauses) against consented foreign project
    // MUST commit staged BranchTaint onto caller_taint so errors cannot be a zero-taint oracle.
    let over_clause_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xEF, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let over_clause_err = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(over_clause_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xEF, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "search",
            json!({
                "project": existing,
                "query": "w ".repeat(65),
            }),
        )
        .await;
    assert!(
        matches!(
            over_clause_err,
            Err(PortError::Domain(DomainError::ValidationFailed { .. }))
        ),
        "over-clause search query must fail ValidationFailed, got {:?}",
        over_clause_err.err()
    );
    assert!(
        over_clause_auth.taint().is_tainted(),
        "post-crossing search ValidationFailed on foreign consented project MUST commit BranchTaint"
    );
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_legacy_precheck_and_trail_write_seams(
    fixture: &mut RuntimeFixture,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    // Part A: Pre-upgrade `DestinationPrecheck::Legacy(bool)` rows in `mcp_dedup` must replay
    // `create_note` and project-pinned `move_note` with prefix stripping (never duplicating
    // `alpha/alpha/sub` or failing `IdempotencyKeyReused`).
    let p_leg_id = FolderId::from_bytes([0xEF, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_leg_ref = FolderRef {
        space_id: s2.history.space_id.clone(),
        folder_id: p_leg_id.clone(),
    };
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_leg_id.clone(),
            parent: None,
            slug: "h6b-legacy-alpha".into(),
            display_name: "Legacy Precheck Alpha".into(),
            is_project: true,
            project_slug: Some("h6b-legacy-alpha".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let leg_handle = format!("{}/h6b-legacy-alpha", s2.slug);
    let cn_key = [0xEF, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let cn_args = json!({
        "project": leg_handle,
        "path": "h6b-legacy-alpha/leg-sub",
        "title": "Legacy Precheck Create",
        "body": "Body.\n",
    });
    let cn_1 = call_mcp(
        &fixture.registry,
        &owner,
        cn_key,
        "create_note",
        cn_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='create_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    fixture
        .storage
        .observer
        .execute("UPDATE mcp_dedup SET safe_result='false' WHERE operation='create_note' AND safe_result LIKE '%\"stripped_segments\":%'")
        .await;
    let cn_2 = call_mcp(&fixture.registry, &owner, cn_key, "create_note", cn_args)
        .await
        .expect("legacy bare-bool create_destination_existed must replay create_note cleanly")
        .structured_content;
    assert_eq!(cn_2["noteId"], cn_1["noteId"]);
    assert!(
        fixture
            .canonical
            .resolve_folder_path(
                s2_sc.clone(),
                Some(p_leg_id.clone()),
                "h6b-legacy-alpha/leg-sub".into(),
            )
            .await
            .unwrap()
            .is_none(),
        "legacy precheck replay must not create duplicated h6b-legacy-alpha/h6b-legacy-alpha/leg-sub"
    );

    let pinned_acc = AccountContext::new(
        owner
            .auth()
            .restrict_to_space(&s2.history.space_id)
            .unwrap()
            .restrict_to_project(&p_leg_ref)
            .unwrap(),
        budget(),
    );
    let mv_key = [0xEF, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let mv_args = json!({
        "ref": cn_1["noteId"],
        "toFolder": "h6b-legacy-alpha/leg-moved",
    });
    let mv_1 = call_mcp(
        &fixture.registry,
        &pinned_acc,
        mv_key,
        "move_note",
        mv_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='move_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    fixture
        .storage
        .observer
        .execute("UPDATE mcp_dedup SET safe_result='false' WHERE operation='move_note' AND safe_result LIKE '%\"stripped_segments\":%'")
        .await;
    let mv_2 = call_mcp(&fixture.registry, &pinned_acc, mv_key, "move_note", mv_args)
        .await
        .expect("legacy bare-bool move_destination_existed must replay project-pinned move_note cleanly")
        .structured_content;
    assert_eq!(mv_2["versionToken"], mv_1["versionToken"]);

    // Part B: `set_ability_trail` onto a chain whose intermediate historical hop lived in a
    // now-trashed project must succeed (validating only the terminal target's live placement).
    let p_hop_id = FolderId::from_bytes([0xEF, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_hop_id.clone(),
            parent: None,
            slug: "h6b-trail-hop-src".into(),
            display_name: "Trail Hop Source".into(),
            is_project: true,
            project_slug: Some("h6b-trail-hop-src".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let p_hop_rev = fixture
        .canonical
        .resolve_folder_path(s2_sc.clone(), Some(p_hop_id.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    let hop_handle = format!("{}/h6b-trail-hop-src", s2.slug);
    let hop_created = call_mcp(
        &fixture.registry,
        &owner,
        [0xEF, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "h6b-hop-role",
            "description": "Promoted intermediate hop.",
            "instructions": "Body.\n",
            "placement": { "home": "project", "project": hop_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let hop_old_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: Some(FolderRef {
                    space_id: s2.history.space_id.clone(),
                    folder_id: p_hop_id.clone(),
                }),
                kind: Some(AbilityKind::Role),
                name: Some("h6b-hop-role".into()),
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
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0xEF, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": hop_created["ref"],
            "versionToken": hop_created["versionToken"],
            "home": { "home": "space" },
            "availability": { "mode": "all-projects" },
            "enabled": true,
        }),
    )
    .await
    .unwrap();
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &p_hop_id,
            &p_hop_rev,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    let front_created = call_mcp(
        &fixture.registry,
        &owner,
        [0xEF, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "create_ability",
        json!({
            "kind": "role",
            "name": "h6b-front-role",
            "description": "Front trail role.",
            "instructions": "Body.\n",
            "placement": { "home": "project", "project": leg_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _ = front_created;
    let front_ref = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(20, None).unwrap(),
                project: Some(p_leg_ref),
                kind: Some(AbilityKind::Role),
                name: Some("h6b-front-role".into()),
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
    fixture
        .control
        .set_ability_trail(
            owner.clone(),
            AccountMutation {
                identity: identity(fixture, &owner, 0xF5).await,
                input: AbilityTrailMutation::Set(AbilityTrailUpdate {
                    source: front_ref,
                    expected_destination: None,
                    destination: Some(hop_old_ref),
                }),
            },
        )
        .await
        .expect(
            "set_ability_trail must succeed across a trashed historical intermediate project hop",
        );
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_ability_dispatch_shadow_and_replay_seams(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    pscope: &HistoryScope,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;
    let s2_p1_handle = format!("{}/h-s2-p1", s2.slug);

    // Part A: Cross-Space shadowing oracle in `use_role` — a disabled foreign `OwnedSpace(s2)`
    // role shadowing a local `OwnedPersonal` role of the same name must fail ResourceNotFound
    // AND commit BranchTaint onto `caller_taint`.
    let _local_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "shadow-oracle-role",
            "description": "Local personal role.",
            "instructions": "Local personal instructions.\n",
            "placement": { "home": "personal" },
        }),
    )
    .await
    .unwrap();
    let foreign_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "create_ability",
        json!({
            "kind": "role",
            "name": "shadow-oracle-role",
            "description": "Foreign space role (disabled).",
            "instructions": "Foreign space instructions.\n",
            "placement": { "home": "space", "space": s2.slug },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "edit_ability",
        json!({
            "ref": foreign_role["ref"],
            "versionToken": foreign_role["versionToken"],
            "enabled": false,
        }),
    )
    .await
    .unwrap();
    let shadow_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let shadow_err = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(shadow_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xF0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "use_role",
            json!({ "role": "shadow-oracle-role", "project": s2_p1_handle }),
        )
        .await;
    assert!(
        matches!(
            shadow_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "foreign disabled role shadowing local personal role must fail ResourceNotFound, got {:?}",
        shadow_err.err()
    );
    assert!(
        shadow_auth.taint().is_tainted(),
        "shadowed local ability rejected by foreign candidate MUST commit BranchTaint"
    );

    // Part B: Promoted `OwnedSpace(s2)` `selected-projects` role dispatched via
    // `ProviderService::complete` in a Personal chat under Space-wide consent on `s2`:
    // succeeds WITH `secondary_projects: [s2_p1]` and fails `ResourceNotFound` without it.
    let prom_role = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "space-wide-promoted-role",
            "description": "Promoted role from s2_p1.",
            "instructions": "Promoted role instructions.\n",
            "placement": { "home": "project", "project": s2_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "edit_ability",
        json!({
            "ref": prom_role["ref"],
            "versionToken": prom_role["versionToken"],
            "home": { "home": "space" },
        }),
    )
    .await
    .unwrap();
    let prom_desc = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: Some(s2_p1.clone()),
                kind: Some(AbilityKind::Role),
                name: Some("space-wide-promoted-role".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .into_iter()
        .next()
        .unwrap()
        .descriptor;
    let disp_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let pers_ctx = SpaceContext::new(disp_auth.clone(), pscope.clone(), budget()).unwrap();
    let s2_disp_ctx = SpaceContext::new(disp_auth.clone(), s2.history.clone(), budget()).unwrap();
    let pers_sel = local
        .provider
        .select_provider(
            pers_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let s2_sel = local
        .provider
        .select_provider(
            s2_disp_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(local.resource.id.clone()),
                model: Some(local.model.clone()),
                project: Some(s2_p1.clone()),
            },
        )
        .await
        .unwrap();
    assert!(
        s2_sel.project_only.is_none(),
        "s2 must be under Space-wide consent to exercise matched secondary project propagation"
    );
    let prom_body = fixture
        .canonical
        .read_ability_resource(
            s2_disp_ctx.clone(),
            ReadAbilityResource {
                ability: prom_desc.reference.id.clone(),
                package_revision: prom_desc.reference.revision.clone(),
                resource: notarium_core::model::AbilityResourceName::Entrypoint,
            },
        )
        .await
        .unwrap();
    let prom_msg = notarium_core::classes::ProviderMessage::Ability(Box::new(
        notarium_core::classes::ClassEgressFence::ability(
            prom_body,
            s2_disp_ctx.auth(),
            &s2_sel.policy,
        )
        .unwrap(),
    ));
    let req_without_witness = CompletionRequest {
        intent: CommandKey::from_bytes([0xF0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        selection: pers_sel.clone(),
        secondary_projects: vec![],
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: None,
            parts: vec![prom_msg.clone()],
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
    let denied_without = match local
        .provider
        .complete(pers_ctx.clone(), req_without_witness)
        .await
    {
        Ok(mut stream) => stream.next().await,
        Err(err) => Err(err),
    };
    assert!(
        matches!(
            denied_without,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "promoted selected-projects role without secondary_projects witness must fail ResourceNotFound, got {denied_without:?}"
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lp_widened = loopback_provider(fixture, &owner, &listener, 0x82, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &lp_widened,
        0x86,
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
        &lp_widened,
        0x87,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: s2.history.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory, DocClass::Skill].into(),
    )
    .await;
    approve_disclosure(
        fixture,
        &owner,
        &lp_widened,
        0x88,
        ProviderAttachmentTarget::Space(s2.history.space_id.clone()),
        [DocClass::UserDoc, DocClass::AgentMemory, DocClass::Skill].into(),
    )
    .await;
    let p_sel_w = lp_widened
        .provider
        .select_provider(
            pers_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(lp_widened.resource.id.clone()),
                model: Some(lp_widened.model.clone()),
                project: None,
            },
        )
        .await
        .unwrap();
    let s2_sel_w = lp_widened
        .provider
        .select_provider(
            s2_disp_ctx.clone(),
            SelectProvider {
                kind: PreferenceModelKind::Completion,
                resource: Some(lp_widened.resource.id.clone()),
                model: Some(lp_widened.model.clone()),
                project: Some(s2_p1.clone()),
            },
        )
        .await
        .unwrap();
    let prom_body_w = fixture
        .canonical
        .read_ability_resource(
            s2_disp_ctx.clone(),
            ReadAbilityResource {
                ability: prom_desc.reference.id.clone(),
                package_revision: prom_desc.reference.revision.clone(),
                resource: notarium_core::model::AbilityResourceName::Entrypoint,
            },
        )
        .await
        .unwrap();
    let prom_msg_w = notarium_core::classes::ProviderMessage::Ability(Box::new(
        notarium_core::classes::ClassEgressFence::ability(
            prom_body_w,
            s2_disp_ctx.auth(),
            &s2_sel_w.policy,
        )
        .unwrap(),
    ));
    let req_with_witness = CompletionRequest {
        intent: CommandKey::from_bytes([0xF0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        selection: p_sel_w,
        secondary_projects: vec![s2_p1.clone()],
        messages: vec![CompletionMessage {
            role: CompletionRole::User,
            instruction: None,
            parts: vec![prom_msg_w],
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
    let wire_task = tokio::spawn(async move {
        let (mut wire, _prompt) = timeout(Duration::from_secs(15), read_request(&listener))
            .await
            .expect("promoted selected-projects role with secondary witness must reach provider");
        send_ollama(
            &mut wire,
            json!({"role": "assistant", "content": "Promoted role admitted."}),
            "stop",
        )
        .await;
    });
    let mut stream = lp_widened
        .provider
        .complete(pers_ctx, req_with_witness)
        .await
        .expect("promoted selected-projects role must succeed under Space-wide consent with secondary witness");
    let mut done = false;
    while let Some(ev) = stream.next().await.unwrap() {
        done |= matches!(ev, CompletionEvent::Finished(CompletionFinish::Stop));
    }
    assert!(done);
    wire_task.await.unwrap();

    // Part C: Legacy bare-bool `DestinationPrecheck::Legacy(false)` replay survives BOTH
    // project rename and project trash for `create_note` and project-pinned `move_note`.
    let p_ren_id = FolderId::from_bytes([0xF0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_ren_ref = FolderRef {
        space_id: s2.history.space_id.clone(),
        folder_id: p_ren_id.clone(),
    };
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_ren_id.clone(),
            parent: None,
            slug: "leg-rename-orig".into(),
            display_name: "Legacy Rename Orig".into(),
            is_project: true,
            project_slug: Some("leg-rename-orig".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let ren_handle = format!("{}/leg-rename-orig", s2.slug);
    let r_cn_key = [0xF0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let r_cn_args = json!({
        "project": ren_handle,
        "path": "leg-rename-orig/sub-ren",
        "title": "Legacy Rename Create",
        "body": "Body.\n",
    });
    let r_cn_1 = call_mcp(
        &fixture.registry,
        &owner,
        r_cn_key,
        "create_note",
        r_cn_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let pinned_ren = AccountContext::new(
        owner
            .auth()
            .restrict_to_space(&s2.history.space_id)
            .unwrap()
            .restrict_to_project(&p_ren_ref)
            .unwrap(),
        budget(),
    );
    let r_mv_key = [0xF0, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let r_mv_args = json!({
        "ref": r_cn_1["noteId"],
        "toFolder": "leg-rename-orig/moved-ren",
    });
    let r_mv_1 = call_mcp(
        &fixture.registry,
        &pinned_ren,
        r_mv_key,
        "move_note",
        r_mv_args.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    // Rename the project slug from `leg-rename-orig` -> `leg-rename-new` and rewrite
    // `mcp_dedup` rows to Legacy(false).
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "rename_project",
        json!({
            "project": ren_handle,
            "slug": "leg-rename-new",
        }),
    )
    .await
    .unwrap();
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation IN ('create_note','move_note') AND safe_result LIKE '%\"folder\":%'")
        .await;
    fixture
        .storage
        .observer
        .execute("UPDATE mcp_dedup SET safe_result='false' WHERE operation IN ('create_note','move_note') AND safe_result LIKE '%\"stripped_segments\":%'")
        .await;
    let r_cn_2 = call_mcp(
        &fixture.registry,
        &owner,
        r_cn_key,
        "create_note",
        r_cn_args,
    )
    .await
    .expect("legacy precheck replay of create_note must survive project rename")
    .structured_content;
    assert_eq!(r_cn_2["noteId"], r_cn_1["noteId"]);
    let r_mv_2 = call_mcp(
        &fixture.registry,
        &pinned_ren,
        r_mv_key,
        "move_note",
        r_mv_args.clone(),
    )
    .await
    .expect("legacy precheck replay of project-pinned move_note must survive project rename")
    .structured_content;
    assert_eq!(r_mv_2["versionToken"], r_mv_1["versionToken"]);
    // Now trash the renamed project and verify project-pinned move_note legacy replay STILL works.
    let p_ren_rev2 = fixture
        .canonical
        .resolve_folder_path(s2_sc.clone(), Some(p_ren_id.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    fixture
        .canonical
        .set_folder_lifecycle(
            &s2.history,
            s2_epoch,
            &p_ren_id,
            &p_ren_rev2,
            notarium_core::model::Lifecycle::Trashed,
            actor,
            None,
        )
        .await
        .unwrap();
    let r_mv_3 = call_mcp(
        &fixture.registry,
        &pinned_ren,
        r_mv_key,
        "move_note",
        r_mv_args,
    )
    .await
    .expect("legacy precheck replay of project-pinned move_note must survive project trash")
    .structured_content;
    assert_eq!(r_mv_3["versionToken"], r_mv_1["versionToken"]);

    // Part E: `edit_ability` post-publish promotion replay (`already_published.is_some()`)
    // reports `"home": "failed"` (never `"skipped"`) when `set_ability_trail` fails.
    let prom_fail = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "post-publish-home-phase",
            "description": "Tests post-publish phase on promotion retry.",
            "instructions": "Body.\n",
            "placement": { "home": "project", "project": s2_p1_handle },
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let prom_key = [0xF0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    let prom_args = json!({
        "ref": prom_fail["ref"],
        "versionToken": prom_fail["versionToken"],
        "instructions": "Updated body for promote.\n",
        "home": { "home": "space" },
    });
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        prom_key,
        "edit_ability",
        prom_args.clone(),
    )
    .await
    .unwrap();
    // Simulate a post-publish promotion retry where `edit-ability-package-outcome` was
    // journaled (`already_published.is_some()` and `authored == true`), the trail adoption
    // command had not committed, and a competing trail is now present (causing `set_ability_trail`
    // to fail with InvalidState). `phase` must advance to `"home"` so `"home"` reports `"failed"`.
    fixture
        .storage
        .observer
        .execute("DELETE FROM control_commands WHERE target='adopt-authored-ability-promotion'")
        .await;
    let partial = call_mcp(
        &fixture.registry,
        &owner,
        prom_key,
        "edit_ability",
        prom_args,
    )
    .await
    .expect("post-publish promotion trail failure must return structured partial edit result")
    .structured_content;
    let home_step = partial["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["step"] == "home")
        .expect("steps must include home");
    assert_eq!(
        home_step["outcome"],
        json!("failed"),
        "post-publish promotion retry failure must report home=failed (not skipped): {partial}"
    );
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
async fn hardened_retry_legacy_and_recent_eviction_seams(
    fixture: &mut RuntimeFixture,
    local: &LoopbackProvider,
    pscope: &HistoryScope,
    s2_sc: &SpaceContext,
    s2: &AccessibleSpace,
    s2_p1: &FolderRef,
    s2_epoch: notarium_core::ids::LeaseEpoch,
    actor: &PrincipalId,
) {
    let owner = fresh_owner(fixture).await;

    // Part D: Non-vacuous retry escalation across `existed_replayed && !existed` for BOTH
    // `ensure_ability_folder_journaled` (`create_ability`) and `ensure_destination` (`create_note`):
    // attempt #1 creates the folder and records `*-existed = false`; we then delete ONLY the
    // saved folder-plan row (simulating crash between folder commit and plan journaling) and
    // arm `fail_next_ensure_folder_path_not_committed()` so attempt #2 genuinely traverses
    // `existed_replayed && !existed` and escalates `NotCommitted` -> `CommitEffect::Unknown`.
    let p_unk_id = FolderId::from_bytes([0xF0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_unk_id,
            parent: None,
            slug: "retry-unknown-proj".into(),
            display_name: "Retry Unknown Proj".into(),
            is_project: true,
            project_slug: Some("retry-unknown-proj".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let unk_handle = format!("{}/retry-unknown-proj", s2.slug);
    let unk_key = [0xF0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let unk_args = json!({
        "kind": "role",
        "name": "retry-unknown-role",
        "description": "Retry after folder creation.",
        "instructions": "Body.\n",
        "placement": { "home": "project", "project": unk_handle },
    });
    fixture.projections.fail_next_create_note_not_committed();
    let err1 = call_mcp(
        &fixture.registry,
        &owner,
        unk_key,
        "create_ability",
        unk_args.clone(),
    )
    .await;
    assert!(
        matches!(
            err1,
            Err(PortError::DeadlineExceeded(ref f))
                if f.effect() == CommitEffect::Unknown
        ),
        "create_ability attempt #1 after folder creation must return CommitEffect::Unknown, got {:?}",
        err1.err()
    );
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='create_ability' AND safe_result LIKE '%\"created\":true%'")
        .await;
    fixture
        .projections
        .fail_next_ensure_folder_path_not_committed();
    let err2 = call_mcp(
        &fixture.registry,
        &owner,
        unk_key,
        "create_ability",
        unk_args,
    )
    .await;
    assert!(
        matches!(
            err2,
            Err(PortError::DeadlineExceeded(ref f))
                if f.effect() == CommitEffect::Unknown
        ),
        "create_ability attempt #2 traversing existed_replayed && !existed must escalate ensure_folder_path NotCommitted to CommitEffect::Unknown, got {:?}",
        err2.err()
    );

    let cn_unk_key = [0xF0, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let cn_unk_args = json!({
        "project": unk_handle,
        "path": "fresh-retry-sub",
        "title": "Retry Unknown Note",
        "body": "Body.\n",
    });
    fixture.projections.fail_next_create_note_not_committed();
    let cn_err1 = call_mcp(
        &fixture.registry,
        &owner,
        cn_unk_key,
        "create_note",
        cn_unk_args.clone(),
    )
    .await;
    assert!(matches!(
        cn_err1,
        Err(PortError::DeadlineExceeded(ref f)) if f.effect() == CommitEffect::Unknown
    ));
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='create_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    fixture
        .projections
        .fail_next_ensure_folder_path_not_committed();
    let cn_err2 = call_mcp(
        &fixture.registry,
        &owner,
        cn_unk_key,
        "create_note",
        cn_unk_args,
    )
    .await;
    assert!(
        matches!(
            cn_err2,
            Err(PortError::DeadlineExceeded(ref f))
                if f.effect() == CommitEffect::Unknown
        ),
        "create_note attempt #2 traversing existed_replayed && !existed must escalate ensure_folder_path NotCommitted to CommitEffect::Unknown, got {:?}",
        cn_err2.err()
    );

    // Part F: `DestinationPrecheck::Legacy(true)` replay on an existing subfolder after
    // `rename_project` must strip the old project slug via `folder_aliases` instead of
    // creating a duplicated `<new>/<old>/existing-sub` directory.
    let p_ex_id = FolderId::from_bytes([0xF0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let p_ex_sub = FolderId::from_bytes([0xF0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_ex_id.clone(),
            parent: None,
            slug: "leg-ex-orig".into(),
            display_name: "Legacy Existing Orig".into(),
            is_project: true,
            project_slug: Some("leg-ex-orig".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: p_ex_sub.clone(),
            parent: Some(p_ex_id.clone()),
            slug: "existing-sub".into(),
            display_name: "Existing Sub".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let ex_handle = format!("{}/leg-ex-orig", s2.slug);
    let ex_key = [0xF0, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    let ex_args = json!({
        "project": ex_handle,
        "path": "leg-ex-orig/existing-sub",
        "title": "Legacy Existing Replay",
        "body": "Body.\n",
    });
    // Fail create_note on attempt #1 so `create_destination_existed` is recorded (`existed = true`),
    // then rewrite it to bare-bool `true` (`Legacy(true)`), drop `create_destination`, rename the
    // project, and replay!
    fixture.projections.fail_next_create_note_not_committed();
    let attempt1 = call_mcp(
        &fixture.registry,
        &owner,
        ex_key,
        "create_note",
        ex_args.clone(),
    )
    .await;
    assert!(
        matches!(attempt1, Err(PortError::DeadlineExceeded(_))),
        "Legacy(true) attempt #1 must fail with DeadlineExceeded, got {:?}",
        attempt1.err()
    );
    fixture
        .storage
        .observer
        .execute("DELETE FROM mcp_dedup WHERE operation='create_note' AND safe_result LIKE '%\"folder\":%'")
        .await;
    fixture
        .storage
        .observer
        .execute("UPDATE mcp_dedup SET safe_result='true' WHERE operation='create_note' AND safe_result LIKE '%\"existed\":true%'")
        .await;
    let _ = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "rename_project",
        json!({ "project": ex_handle, "slug": "leg-ex-new" }),
    )
    .await
    .unwrap();
    let ex_res = call_mcp(&fixture.registry, &owner, ex_key, "create_note", ex_args)
        .await
        .expect("Legacy(true) replay after project rename must succeed")
        .structured_content;
    let ex_note_id = NoteId::parse(ex_res["noteId"].as_str().expect("noteId")).unwrap();
    let ex_meta = fixture
        .canonical
        .get_note_metadata(
            s2_sc.clone(),
            GetNote {
                note: ex_note_id.clone(),
                revision: None,
                causal: CausalBasis::Await(Default::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        ex_meta.parent,
        Some(p_ex_sub),
        "Legacy(true) replay after project rename must land inside existing subfolder p_ex_sub"
    );
    assert!(
        fixture
            .canonical
            .resolve_folder_path(
                s2_sc.clone(),
                Some(p_ex_id),
                "leg-ex-orig/existing-sub".into(),
            )
            .await
            .unwrap()
            .is_none(),
        "Legacy(true) replay after project rename must not create duplicated leg-ex-orig/existing-sub folder"
    );

    // Part G: Cross-space `MAX_CANDIDATES` eviction protection in `recent_activity`:
    // 200 trashed-note revisions in consented foreign `s2` newer than an active note in
    // pinned `pscope` must neither evict the local active note nor flip taint.
    let p_sc = SpaceContext::new(owner.auth().clone(), pscope.clone(), budget()).unwrap();
    let local_note = fixture
        .canonical
        .create_note(
            p_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: pscope.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xF6; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes([0xF0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    parent: None,
                    slug: "pinned-space-recent-survivor".into(),
                    class: DocClass::UserDoc,
                    carrier:
                        "# Pinned Space Recent Survivor\nMust survive foreign trashed flood.\n"
                            .into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let local_note_id = local_note.note.to_string();
    // Ensure wall-clock timestamps for all 200 foreign trashed revisions are strictly newer.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let flood_note = fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xF7; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes([0xF0, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    parent: Some(s2_p1.folder_id.clone()),
                    slug: "recent-trashed-flood".into(),
                    class: DocClass::UserDoc,
                    carrier: "flood-0".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let mut prev_text = "flood-0".to_owned();
    let mut prev_rev = flood_note.revision;
    for i in 1u16..=200 {
        let next_text = format!("flood-{i}");
        let span = notarium_syntax::frontmatter::analyze(&prev_text, DocClass::UserDoc)
            .unwrap()
            .carrier
            .body;
        let plan = notarium_syntax::patch::plan(
            &prev_text,
            span,
            vec![(
                notarium_core::patch::CarrierEditOrigin::Body,
                span,
                next_text.clone(),
            )],
        )
        .unwrap();
        let mut key_bytes = [0xF0, 7, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        key_bytes[14..16].copy_from_slice(&i.to_be_bytes());
        let edited = fixture
            .canonical
            .edit_note(
                s2_sc.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: s2.history.clone(),
                        actor: actor.clone(),
                        key: CommandKey::from_bytes(key_bytes),
                        hash: ContentDigest::from_bytes([0xF8; 32]),
                    },
                    preconditions: Preconditions {
                        revision: Some(prev_rev),
                        ..Preconditions::default()
                    },
                    input: EditNote {
                        note: flood_note.note.clone(),
                        plan,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        prev_text = next_text;
        prev_rev = edited.revision;
    }
    fixture
        .canonical
        .delete_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 7, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xF9; 32]),
                },
                preconditions: Preconditions::default(),
                input: DeleteNote {
                    note: flood_note.note,
                    disposition: DeleteDisposition::Trash,
                },
            },
        )
        .await
        .unwrap();
    let recent_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let recent_res = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(recent_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xF0, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "recent_activity",
            json!({ "limit": 1 }),
        )
        .await
        .unwrap()
        .structured_content;
    let recent_items = recent_res["items"].as_array().unwrap();
    assert_eq!(
        recent_items.len(),
        1,
        "limit=1 must return the newest active local note after skipping 200 newer foreign trashed revisions: {recent_res}"
    );
    assert_eq!(
        recent_items[0]["noteId"].as_str(),
        Some(local_note_id.as_str()),
        "200 trashed foreign revisions must not evict pinned-Space active note from recent_activity: {recent_res}"
    );
    assert!(
        !recent_auth.taint().is_tainted(),
        "skipped foreign trashed revisions must not falsely taint untainted local recent_activity"
    );
    // Wider limit must also reach older active foreign notes past the 200 trashed revisions
    // without cross-target eviction, properly marking BranchTaint when foreign active items return.
    let recent_auth_wide = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let recent_wide = local
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(recent_auth_wide.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: local.resource.id.clone(),
                    model: local.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xF0, 7, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                ]),
            },
            "recent_activity",
            json!({ "limit": 20 }),
        )
        .await
        .unwrap()
        .structured_content;
    let wide_items = recent_wide["items"].as_array().unwrap();
    assert!(
        wide_items
            .iter()
            .any(|item| item["noteId"].as_str() == Some(local_note_id.as_str()))
            && wide_items.iter().any(|item| {
                item["spaceId"].as_str().is_some_and(|sid| {
                    sid != pscope.space_id.as_str() && sid != s2.history.space_id.as_str()
                })
            }),
        "200 trashed revisions in foreign Space F1 (s2) must not evict either local_note (P) or active notes in a second foreign Space F2: {recent_wide}"
    );
    assert!(
        recent_auth_wide.taint().is_tainted(),
        "returning active notes from second foreign Space F2 past F1's 200 trashed revisions must mark cross-space BranchTaint"
    );

    // Part H: `list_abilities(view: "authoring")` under `InAppProvider` with `project: None`
    // must restrict discovery to consented Spaces only (excluding unconsented `s2` without
    // scanning or leaking its abilities and without tainting the pinned Space).
    fn scope_space_id(item: &Value) -> Option<&str> {
        item["scope"]["OwnedSpace"]
            .as_str()
            .or_else(|| item["scope"]["OwnedProject"]["space_id"].as_str())
    }
    // Positive control via ExternalMcp: confirm `s2` actually holds an active ability.
    let external_list = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "list_abilities",
        json!({ "view": "authoring", "limit": 50 }),
    )
    .await
    .unwrap()
    .structured_content;
    let external_items = external_list["items"].as_array().unwrap();
    assert!(
        external_items
            .iter()
            .any(|item| scope_space_id(item) == Some(s2.history.space_id.as_str())),
        "positive control: ExternalMcp must see active s2 ability in list_abilities(view: authoring): {external_list}"
    );
    let auth_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lp_local_only = loopback_provider(fixture, &owner, &auth_listener, 0x20, true).await;
    approve_disclosure(
        fixture,
        &owner,
        &lp_local_only,
        0x22,
        ProviderAttachmentTarget::Personal {
            owner: actor.clone(),
            space: pscope.space_id.clone(),
        },
        [DocClass::UserDoc, DocClass::AgentMemory, DocClass::Skill].into(),
    )
    .await;
    let authoring_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            pscope.space_id.clone(),
            ChatAudience::Personal,
            owner.auth().spaces().clone(),
        )
        .unwrap();
    let authoring_list = lp_local_only
        .registry
        .call_tool(
            McpInvocationContext {
                account: AccountContext::new(authoring_auth.clone(), budget()),
                target: EgressTarget::InAppProvider {
                    provider: lp_local_only.resource.id.clone(),
                    model: lp_local_only.model.clone(),
                    primary_project: None,
                },
                request_key: CommandKey::from_bytes([
                    0xF0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
            },
            "list_abilities",
            json!({ "view": "authoring", "limit": 50 }),
        )
        .await
        .unwrap()
        .structured_content;
    let items = authoring_list["items"].as_array().unwrap();
    assert!(
        !items.is_empty() && items.iter().all(|item| !item["scope"].is_null()),
        "positive control: consented abilities must be returned with non-null scope: {authoring_list}"
    );
    assert!(
        items
            .iter()
            .all(|item| scope_space_id(item) != Some(s2.history.space_id.as_str())),
        "unconsented foreign Space s2 must be excluded from list_abilities(view: authoring): {authoring_list}"
    );
    assert!(
        !authoring_auth.taint().is_tainted(),
        "list_abilities(view: authoring) skipping unconsented Space s2 must not taint pinned Space"
    );

    // Part I: Pre-lookup path syntax validation on `move_folder`/`rename_folder`/`create_note`,
    // aligned 4096-byte `search`/`recall` schema validation, and `move_folder`/`rename_folder`/
    // `rename_project` subtree authorization for `write_locked`, `EncryptedNote`, and `Skill` descendants.
    for (tag, tool, args) in [
        (
            1u8,
            "move_folder",
            json!({ "project": "no-such/proj", "folder": "bad/../seg", "toFolder": "x" }),
        ),
        (
            2u8,
            "rename_folder",
            json!({ "project": "no-such/proj", "folder": "bad/../seg", "name": "ok" }),
        ),
        (
            3u8,
            "create_note",
            json!({ "project": "no-such/proj", "title": "Index", "body": "reserved generated slug" }),
        ),
    ] {
        let err = call_mcp(
            &fixture.registry,
            &owner,
            [0xF0, 9, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            tool,
            args,
        )
        .await;
        assert!(
            matches!(
                err,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if diagnostic.reason == ValidationReason::InvalidPathComponent
            ),
            "{tool} must reject malformed/reserved path before project lookup, got {:?}",
            err.err()
        );
    }
    let long_utf8_query = "é".repeat(2049); // 2049 chars, 4098 bytes > 4096
    let exact_utf8_query = "é".repeat(2048); // 2048 chars, 4096 bytes == 4096
    // Combine `search` with `class: "encrypted-note"` so `retrieval.rs:115` would return
    // `ClassEgressForbidden`; receiving `InvalidQuery` proves `schema.rs` rejected >4096B first.
    let search_too_long = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "search",
        json!({ "query": long_utf8_query, "class": "encrypted-note" }),
    )
    .await;
    assert!(
        matches!(
            search_too_long,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidQuery
        ),
        "search must reject >4096-byte UTF-8 query upfront in schema validation before handler class check, got {:?}",
        search_too_long.err()
    );
    let search_at_limit = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "search",
        json!({ "query": exact_utf8_query, "class": "encrypted-note" }),
    )
    .await;
    assert!(
        matches!(
            search_at_limit,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::ClassEgressForbidden
        ),
        "search must accept exact 4096-byte UTF-8 query in schema validation and reach handler check, got {:?}",
        search_at_limit.err()
    );
    // Combine `recall` with missing `project: "no-such/proj"` so >4096B returns `InvalidQuery`
    // before project lookup while exact 4096B passes schema validation and hits `ResourceNotFound`.
    let recall_too_long = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "recall",
        json!({ "query": long_utf8_query, "project": "no-such/proj" }),
    )
    .await;
    assert!(
        matches!(
            recall_too_long,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidQuery
        ),
        "recall must reject >4096-byte UTF-8 query upfront in schema validation before project lookup, got {:?}",
        recall_too_long.err()
    );
    let recall_at_limit = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        "recall",
        json!({ "query": exact_utf8_query, "project": "no-such/proj" }),
    )
    .await;
    assert!(
        matches!(
            recall_at_limit,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "recall must accept exact 4096-byte UTF-8 query in schema validation and reach project lookup, got {:?}",
        recall_at_limit.err()
    );

    let mv_dest = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let mv_lock_parent = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let mv_lock_child = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    let mv_enc_parent = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    let mv_skill_parent = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    let mv_ok_parent = FolderId::from_bytes([0xF0, 9, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
    for (fid, parent, slug) in [
        (&mv_dest, s2_p1.folder_id.clone(), "mv-dest"),
        (&mv_lock_parent, s2_p1.folder_id.clone(), "mv-lock-parent"),
        (&mv_lock_child, mv_lock_parent.clone(), "mv-lock-child"),
        (&mv_enc_parent, s2_p1.folder_id.clone(), "mv-enc-parent"),
        (&mv_skill_parent, s2_p1.folder_id.clone(), "mv-skill-parent"),
        (&mv_ok_parent, s2_p1.folder_id.clone(), "mv-ok-parent"),
    ] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: s2.history.clone(),
                active_epoch: s2_epoch,
                folder_id: fid.clone(),
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
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_lock_child, true)
        .await
        .unwrap();
    fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xFA; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes([0xF0, 9, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    parent: Some(mv_enc_parent.clone()),
                    slug: "secret-enc".into(),
                    class: DocClass::EncryptedNote,
                    carrier: concat!(
                        "---\nclass: encrypted-note\ntitle: Secret Enc\n---\n# Secret Enc\n\n```age\n",
                        "-----BEGIN AGE ENCRYPTED FILE-----\n",
                        "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBURWlGMHlwcXIrYnB2Y3FY\n",
                        "TnlDVkpwTDdPdXdQZFZ3UEw3S1FFYkZET0NjCmhqYWJHWHdTTFE5YzNTNkx3Mmkr\n",
                        "UzJUdTJmaXdRSEhzbGJCTjZCNDFGTEUKLS0tIFd5SnA5Ri85Rk9aaDdnSmRoZXEy\n",
                        "V0lKY3dIZ1ljOE5JVmgzZGR3aHJjTmcK7s9ix86RtDMnTmjU8vkTTLdMW/73vqpS\n",
                        "yPC8DpksHoMx+2Y=\n",
                        "-----END AGE ENCRYPTED FILE-----\n```\n",
                    )
                    .into(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xFB; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes([0xF0, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
                    parent: Some(mv_skill_parent.clone()),
                    slug: "unpublished-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: Unpublished Skill\n---\n# Skill\n".into(),
                },
            },
        )
        .await
        .unwrap();
    fixture
        .canonical
        .create_note(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xF9; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes([0xF0, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
                    parent: Some(mv_ok_parent.clone()),
                    slug: "unlocked-doc".into(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Unlocked Doc\n---\n# Unlocked\n".into(),
                },
            },
        )
        .await
        .unwrap();
    // 1. Moving or renaming an unlocked parent of a write_locked child (or its project) fails SpaceReadOnly.
    let lock_mv = fixture
        .canonical
        .move_folder(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xFC; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: mv_lock_parent.clone(),
                    new_parent: Some(mv_dest.clone()),
                },
            },
        )
        .await;
    assert!(
        matches!(lock_mv, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "moving parent of write_locked descendant must fail SpaceReadOnly, got {lock_mv:?}"
    );
    let lock_ren = fixture
        .canonical
        .rename_folder(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xF8; 32]),
                },
                preconditions: Preconditions::default(),
                input: RenameFolder {
                    folder: mv_lock_parent,
                    name: "mv-lock-parent-renamed".into(),
                },
            },
        )
        .await;
    assert!(
        matches!(lock_ren, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "renaming parent of write_locked descendant must fail SpaceReadOnly, got {lock_ren:?}"
    );
    let lock_proj_ren = fixture
        .canonical
        .rename_project(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xF7; 32]),
                },
                preconditions: Preconditions::default(),
                input: RenameProject {
                    folder: s2_p1.folder_id.clone(),
                    name: "s2-p1-renamed".into(),
                    display_name: None,
                },
            },
        )
        .await;
    assert!(
        matches!(
            lock_proj_ren,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "renaming project containing write_locked descendant must fail SpaceReadOnly, got {lock_proj_ren:?}"
    );
    // 2. AgentRun (no EncryptedNote write class) moving or renaming folder containing EncryptedNote fails SpaceReadOnly.
    let mut s2_agent_grants = owner.auth().spaces().clone();
    if let Some(g) = s2_agent_grants.get_mut(&s2.history.space_id) {
        g.read_classes.remove(&DocClass::EncryptedNote);
        g.write_classes.remove(&DocClass::EncryptedNote);
    }
    let s2_agent_auth = owner
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([0xF0, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            s2.history.space_id.clone(),
            ChatAudience::Personal,
            s2_agent_grants,
        )
        .unwrap();
    let s2_agent_sc = SpaceContext::new(s2_agent_auth, s2.history.clone(), budget()).unwrap();
    let enc_mv = fixture
        .canonical
        .move_folder(
            s2_agent_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xFD; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: mv_enc_parent.clone(),
                    new_parent: Some(mv_dest.clone()),
                },
            },
        )
        .await;
    assert!(
        matches!(enc_mv, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "AgentRun moving folder containing EncryptedNote must fail SpaceReadOnly, got {enc_mv:?}"
    );
    let enc_ren = fixture
        .canonical
        .rename_folder(
            s2_agent_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xF6; 32]),
                },
                preconditions: Preconditions::default(),
                input: RenameFolder {
                    folder: mv_enc_parent.clone(),
                    name: "mv-enc-parent-renamed".into(),
                },
            },
        )
        .await;
    assert!(
        matches!(enc_ren, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "AgentRun renaming folder containing EncryptedNote must fail SpaceReadOnly, got {enc_ren:?}"
    );
    // 3. AgentRun (no AbilityWrite) moving or renaming folder containing Skill note fails AbilityWriteForbidden.
    let skill_mv = fixture
        .canonical
        .move_folder(
            s2_agent_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xFE; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: mv_skill_parent.clone(),
                    new_parent: Some(mv_dest.clone()),
                },
            },
        )
        .await;
    assert!(
        matches!(
            skill_mv,
            Err(PortError::Domain(DomainError::AbilityWriteForbidden))
        ),
        "AgentRun moving folder containing Skill note within same project must fail AbilityWriteForbidden, got {skill_mv:?}"
    );
    let skill_ren = fixture
        .canonical
        .rename_folder(
            s2_agent_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xF5; 32]),
                },
                preconditions: Preconditions::default(),
                input: RenameFolder {
                    folder: mv_skill_parent.clone(),
                    name: "mv-skill-parent-renamed".into(),
                },
            },
        )
        .await;
    assert!(
        matches!(
            skill_ren,
            Err(PortError::Domain(DomainError::AbilityWriteForbidden))
        ),
        "AgentRun renaming folder containing Skill note must fail AbilityWriteForbidden, got {skill_ren:?}"
    );
    // 4. Positive control: AgentRun moving and renaming an unlocked UserDoc-only folder succeeds,
    //    and WriteFolderSubtree replay rejects replaying that rename once a descendant lock appears.
    fixture
        .canonical
        .move_folder(
            s2_agent_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
                    ]),
                    hash: ContentDigest::from_bytes([0xF4; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: mv_ok_parent.clone(),
                    new_parent: Some(mv_dest),
                },
            },
        )
        .await
        .expect("AgentRun moving unlocked UserDoc-only folder must succeed");
    let ok_rename_cmd = Mutation {
        identity: CommandIdentity {
            scope: s2.history.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes([0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
            hash: ContentDigest::from_bytes([0xF3; 32]),
        },
        preconditions: Preconditions::default(),
        input: RenameFolder {
            folder: mv_ok_parent.clone(),
            name: "mv-ok-parent-renamed".into(),
        },
    };
    fixture
        .canonical
        .rename_folder(s2_agent_sc.clone(), ok_rename_cmd.clone())
        .await
        .expect("AgentRun renaming unlocked UserDoc-only folder must succeed");
    let mv_ok_child = FolderId::from_bytes([0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: mv_ok_child.clone(),
            parent: Some(mv_ok_parent.clone()),
            slug: "mv-ok-child".into(),
            display_name: "mv-ok-child".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_child.clone(), true)
        .await
        .unwrap();
    let replay_after_lock = fixture
        .canonical
        .rename_folder(s2_agent_sc.clone(), ok_rename_cmd)
        .await;
    assert!(
        matches!(
            replay_after_lock,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "replaying rename_folder after descendant write lock must fail SpaceReadOnly, got {replay_after_lock:?}"
    );
    // 5. set_folder_write_lock enforces strict-ancestor lock, strict-descendant lock, and subtree class/ability authority.
    let lock_under_locked_parent = fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_parent.clone(), true)
        .await;
    assert!(
        matches!(
            lock_under_locked_parent,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "locking folder with write-locked strict descendant must fail SpaceReadOnly, got {lock_under_locked_parent:?}"
    );
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_child.clone(), false)
        .await
        .expect("unlocking locked leaf with unlocked strict ancestors/descendants must succeed");
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_parent.clone(), true)
        .await
        .expect("locking mv_ok_parent after unlocking child must succeed");
    let child_lock_under_locked_anc = fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_child, true)
        .await;
    assert!(
        matches!(
            child_lock_under_locked_anc,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "modifying write lock under a write-locked strict ancestor must fail SpaceReadOnly, got {child_lock_under_locked_anc:?}"
    );
    fixture
        .canonical
        .set_folder_write_lock(s2_sc.clone(), mv_ok_parent.clone(), false)
        .await
        .expect("unlocking mv_ok_parent must succeed");
    // Project-pinned move_folder must reject out-of-project source or destination as ResourceNotFound.
    let s2_p2 = FolderId::from_bytes([0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
    let s2_p2_child = FolderId::from_bytes([0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: s2_p2.clone(),
            parent: None,
            slug: "s2-p2".into(),
            display_name: "s2-p2".into(),
            is_project: true,
            project_slug: Some("s2-p2".into()),
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: s2.history.clone(),
            active_epoch: s2_epoch,
            folder_id: s2_p2_child.clone(),
            parent: Some(s2_p2.clone()),
            slug: "s2-p2-child".into(),
            display_name: "s2-p2-child".into(),
            is_project: false,
            project_slug: None,
            actor: actor.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let mut s2_pinned_grants = owner.auth().spaces().clone();
    if let Some(g) = s2_pinned_grants.get_mut(&s2.history.space_id) {
        g.project_root = Some(s2_p2.clone());
    }
    let s2_pinned_sc = SpaceContext::new(
        notarium_core::auth::EngineAuthContext::for_human(
            notarium_core::auth::VerifiedHuman::attest(
                actor.clone(),
                GrantId::from_bytes([0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]),
                s2_pinned_grants,
                true,
            ),
        ),
        s2.history.clone(),
        budget(),
    )
    .unwrap();
    let pinned_out_of_proj_src = fixture
        .canonical
        .move_folder(
            s2_pinned_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
                    ]),
                    hash: ContentDigest::from_bytes([0xF1; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: mv_ok_parent,
                    new_parent: Some(s2_p2),
                },
            },
        )
        .await;
    assert!(
        matches!(
            pinned_out_of_proj_src,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "project-pinned move_folder on out-of-project source must fail ResourceNotFound, got {pinned_out_of_proj_src:?}"
    );
    let pinned_out_of_proj_dst = fixture
        .canonical
        .move_folder(
            s2_pinned_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8,
                    ]),
                    hash: ContentDigest::from_bytes([0xEF; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveFolder {
                    folder: s2_p2_child,
                    new_parent: Some(s2_p1.folder_id.clone()),
                },
            },
        )
        .await;
    assert!(
        matches!(
            pinned_out_of_proj_dst,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "project-pinned move_folder to out-of-project destination must fail ResourceNotFound, got {pinned_out_of_proj_dst:?}"
    );
    let agent_lock_enc = fixture
        .canonical
        .set_folder_write_lock(s2_agent_sc.clone(), mv_enc_parent, true)
        .await;
    assert!(
        matches!(
            agent_lock_enc,
            Err(PortError::Domain(DomainError::SpaceReadOnly))
        ),
        "AgentRun without EncryptedNote write class must not lock folder containing EncryptedNote, got {agent_lock_enc:?}"
    );
    let agent_lock_skill = fixture
        .canonical
        .set_folder_write_lock(s2_agent_sc.clone(), mv_skill_parent, true)
        .await;
    assert!(
        matches!(
            agent_lock_skill,
            Err(PortError::Domain(DomainError::AbilityWriteForbidden))
        ),
        "AgentRun without AbilityWrite must not lock folder containing Skill note, got {agent_lock_skill:?}"
    );
    // 6. Pre-lookup validation on create_ability ("Index"), link syntax/self-link,
    //    link rejection on published ability entrypoints, and rollback duplicate expectations.
    // Pass an unresolvable project placement so skipping author.rs:422 would yield ResourceNotFound.
    let index_ability = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "role",
            "name": "Index",
            "description": "reserved slug",
            "instructions": "should fail before project lookup or folder creation",
            "placement": { "home": "project", "project": "no-such/proj" }
        }),
    )
    .await;
    assert!(
        matches!(
            index_ability,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidPathComponent
        ),
        "create_ability with name 'Index' must fail upfront with InvalidPathComponent before project lookup, got {:?}",
        index_ability.err()
    );
    let missing_note = NoteId::from_bytes([0xF0, 9, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    for (tag, expected_reason, args) in [
        (
            2u8,
            ValidationReason::InvalidPathComponent,
            json!({ "from": missing_note, "relation": "bad:rel", "to": NoteId::from_bytes([0xF0, 9, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]) }),
        ),
        (
            3u8,
            ValidationReason::InvalidQuery,
            json!({ "from": missing_note, "relation": "rel", "to": missing_note }),
        ),
    ] {
        let link_err = call_mcp(
            &fixture.registry,
            &owner,
            [0xF0, 9, 11, tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            "link",
            args,
        )
        .await;
        assert!(
            matches!(
                link_err,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if diagnostic.reason == expected_reason
            ),
            "link must reject {expected_reason:?} before note lookup, got {:?}",
            link_err.err()
        );
    }
    let ab_created = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 11, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        "create_ability",
        json!({
            "kind": "skill",
            "name": "link-guard-skill",
            "description": "guarded ability",
            "instructions": "must reject direct MCP link",
            "placement": { "home": "personal" }
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let ab_ref = ab_created["ref"].as_str().unwrap().to_owned();
    let personal_sc = SpaceContext::new(owner.auth().clone(), pscope.clone(), budget()).unwrap();
    let ab_folder = fixture
        .canonical
        .resolve_folder_path(personal_sc.clone(), None, ".abilities".to_owned())
        .await
        .unwrap()
        .expect(".abilities folder must exist in personal space")
        .reference
        .folder_id;
    let ab_entry_note = fixture
        .canonical
        .resolve_note_target(personal_sc, Some(ab_folder), "link-guard-skill".to_owned())
        .await
        .unwrap()
        .expect("published ability entrypoint note must exist")
        .note_id;
    let link_ability_err = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 11, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
        "link",
        json!({ "from": ab_entry_note, "relation": "references", "toTitle": "Some Note" }),
    )
    .await;
    assert!(
        matches!(
            link_ability_err,
            Err(PortError::Domain(DomainError::AbilityWriteForbidden))
        ),
        "direct MCP link against published ability entrypoint must fail AbilityWriteForbidden, got {:?}",
        link_ability_err.err()
    );
    let ab_after = call_mcp(
        &fixture.registry,
        &owner,
        [0xF0, 9, 11, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4],
        "get_ability",
        json!({ "ref": ab_ref }),
    )
    .await
    .unwrap()
    .structured_content;
    assert_eq!(
        ab_after["healthy"],
        json!(true),
        "rejected MCP link must leave published ability healthy: {ab_after}"
    );
    let dup_note = NoteId::from_bytes([0xF0, 9, 11, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    let dup_rev = RevisionId::from_bytes([0xF0, 9, 11, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    let dup_rb_err = fixture
        .canonical
        .rollback_agent_run(
            s2_sc.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 11, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
                    ]),
                    hash: ContentDigest::from_bytes([0xF2; 32]),
                },
                preconditions: Preconditions::default(),
                input: RollbackAgentRun {
                    run: AgentRunId::from_bytes([
                        0xF0, 9, 11, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    expected_run_revision: dup_rev.clone(),
                    expected_entities: vec![
                        NoteRevision {
                            note: dup_note.clone(),
                            revision: dup_rev.clone(),
                        },
                        NoteRevision {
                            note: dup_note,
                            revision: dup_rev,
                        },
                    ],
                    associated_board_expectations: Vec::new(),
                },
            },
        )
        .await;
    assert!(
        matches!(
            dup_rb_err,
            Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                if diagnostic.reason == ValidationReason::InvalidState
        ),
        "duplicate expected_entities on nonexistent run must reject InvalidState before lookup, got {dup_rb_err:?}"
    );
    // 7. Write-only caller without read permission on touched notes cannot roll back a note-only run.
    let rb_view_note = NoteId::from_bytes([0xF0, 9, 11, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    fixture
        .canonical
        .create_note(
            s2_agent_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 11, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                    ]),
                    hash: ContentDigest::from_bytes([0xF1; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: rb_view_note,
                    parent: None,
                    slug: "rb-view-guard".into(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Rollback View Guard\n---\n# Body\n".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .expect("agent run creating root UserDoc for rollback view check must succeed");
    let mut write_only_grants = owner.auth().spaces().clone();
    if let Some(g) = write_only_grants.get_mut(&s2.history.space_id) {
        g.read_classes.clear();
    }
    let write_only_sc = SpaceContext::new(
        notarium_core::auth::EngineAuthContext::for_human(
            notarium_core::auth::VerifiedHuman::attest(
                actor.clone(),
                GrantId::from_bytes([0xF0, 9, 11, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
                write_only_grants,
                true,
            ),
        ),
        s2.history.clone(),
        budget(),
    )
    .unwrap();
    let rb_view_err = fixture
        .canonical
        .rollback_agent_run_by_id(
            write_only_sc,
            Mutation {
                identity: CommandIdentity {
                    scope: s2.history.clone(),
                    actor: actor.clone(),
                    key: CommandKey::from_bytes([
                        0xF0, 9, 11, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
                    ]),
                    hash: ContentDigest::from_bytes([0xF0; 32]),
                },
                preconditions: Preconditions::default(),
                input: AgentRunId::from_bytes([0xF0, 9, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
            },
        )
        .await;
    assert!(
        matches!(
            rb_view_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "write-only caller without read permission must not roll back note-only run, got {rb_view_err:?}"
    );
}

#[allow(clippy::too_many_arguments)]
async fn verify_out_of_project_schedule_update_not_found(
    fixture: &RuntimeFixture,
    owner: &AccountContext,
    owner_p1_only: &AccountContext,
    schedule_id: &ScheduleId,
    expected_rev: ControlRevision,
    sched_def: &ScheduleDefinition,
    s1_p1: &FolderRef,
    next_slot: Timestamp,
) {
    let mut p1_def = sched_def.clone();
    p1_def.project = Some(s1_p1.clone());
    for (tag, target_sched) in [
        (46u8, schedule_id.clone()),
        (47u8, ScheduleId::from_bytes([0xE4; 16])),
    ] {
        assert!(matches!(
            fixture
                .control
                .update_schedule(
                    owner_p1_only.clone(),
                    AccountMutation {
                        identity: identity(fixture, owner, tag).await,
                        input: UpdateSchedule {
                            schedule: target_sched,
                            expected: expected_rev,
                            definition: p1_def.clone(),
                            approved_skills: None,
                            next_slot: Some(next_slot),
                            paused: true,
                        },
                    },
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }
}

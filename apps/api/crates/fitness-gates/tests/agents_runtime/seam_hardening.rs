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
    receipt::{CausalBasis, CommandIdentity},
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

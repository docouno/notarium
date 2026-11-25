#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    DomainError,
    auth::*,
    classes::AbilityKind,
    error::{PortError, ValidationReason},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::{AccountCommandIdentity, ChangeCursor},
};
use std::{collections::BTreeSet, sync::atomic::Ordering};
use support::*;

async fn identity(
    service: &ControlService,
    ctx: &AccountContext,
    key: u8,
) -> AccountCommandIdentity {
    let owner = ctx.auth().principal();
    command(
        owner,
        owner,
        key,
        service
            .account(ctx.clone(), owner.clone())
            .await
            .unwrap()
            .revision,
    )
}
fn result(value: EpisodeStartResult) -> AgentEpisode {
    match value {
        EpisodeStartResult::New(value)
        | EpisodeStartResult::Resumed(value)
        | EpisodeStartResult::Forked(value) => value,
        other => panic!("expected episode, got {other:?}"),
    }
}
fn not_found<T: std::fmt::Debug>(result: Result<T, PortError>) {
    assert!(
        matches!(
            result,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "{result:?}"
    );
}
async fn update(
    service: &ControlService,
    ctx: &AccountContext,
    episode: &AgentEpisode,
    key: u8,
    state: EpisodeLifecycle,
) -> AgentEpisode {
    service
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, key).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: episode.id.clone(),
                    expected: episode.revision,
                    name: episode.name.clone(),
                    active_role: episode.active_role.clone(),
                    project_hint: episode.project_hint.clone(),
                    lifecycle: state,
                }),
            },
        )
        .await
        .unwrap_or_else(|error| panic!("episode update {key}: {error:?}"))
        .value
}
async fn exercise(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "episodes").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("episode test password".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let auth = service
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    let ctx = AccountContext::new(auth.clone(), budget());
    let personal = bootstrap.account.personal_space.unwrap();
    let history = {
        let mut entries = fixture.catalog.entries.lock().unwrap();
        let value = &mut entries.get_mut(&personal).unwrap().2;
        value.last_seq = SpaceSeq::new(20).unwrap();
        value.history.clone()
    };
    let project = FolderRef {
        space_id: personal.clone(),
        folder_id: FolderId::from_bytes([3; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (personal.clone(), project.folder_id.clone()),
        ProjectInfo {
            project_slug: "project".into(),
            folder: project.clone(),
            name: "Project".into(),
        },
    );
    let request = AccountMutation {
        identity: identity(&service, &ctx, 1).await,
        input: StartEpisode {
            selector: EpisodeSelector::New {
                requested: EpisodeId::parse("ses_A0b1C2d3E4_-").unwrap(),
                name: Some("working".into()),
            },
            project_hint: Some(project.clone()),
            guard: EpisodeRevisionGuard::Account,
        },
    };
    let (one, replay) = tokio::join!(
        service.start_or_resume_episode(ctx.clone(), request.clone()),
        service.start_or_resume_episode(ctx.clone(), request.clone())
    );
    let one = one.unwrap();
    let replay = replay.unwrap();
    assert_eq!(one.revision, replay.revision);
    let mut original = result(one.value);
    assert_eq!(original.id.as_str(), "ses_A0b1C2d3E4_-");
    assert_eq!(original.id, result(replay.value).id);
    assert_eq!(original.project_hint, Some(project.clone()));
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM agent_episodes")
            .await,
        1
    );
    let mut changed = request.clone();
    changed.input.project_hint = None;
    assert!(matches!(
        service.start_or_resume_episode(ctx.clone(), changed).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));

    // MAX acknowledgements commute even when both callers observed one owner revision.
    let first = identity(&service, &ctx, 10).await;
    let mut second = first.clone();
    second.key = CommandKey::from_bytes([11; 16]);
    let ack = |identity, seq| AccountMutation {
        identity,
        input: AcknowledgeDelta {
            owner: AckOwner::Episode(original.id.clone()),
            delivered: ChangeCursor {
                scope: history.clone(),
                after: SpaceSeq::new(seq).unwrap(),
            },
        },
    };
    let (a, b) = tokio::join!(
        service.acknowledge_delta(ctx.clone(), ack(first, 13)),
        service.acknowledge_delta(ctx.clone(), ack(second, 19))
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        service
            .get_episode(ctx.clone(), original.id.clone())
            .await
            .unwrap()
            .acknowledgements[&personal]
            .seq
            .get(),
        19
    );
    let future = ack(identity(&service, &ctx, 12).await, 21);
    assert!(
        matches!(service.acknowledge_delta(ctx.clone(), future).await, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::InvalidQuery)
    );
    let mut wrong_history = ack(identity(&service, &ctx, 13).await, 10);
    wrong_history.input.delivered.scope.incarnation = HistoryIncarnation::from_bytes([99; 16]);
    assert!(
        matches!(service.acknowledge_delta(ctx.clone(), wrong_history).await, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::HistoryIncarnationMismatch)
    );

    let fork_request = AccountMutation {
        identity: identity(&service, &ctx, 20).await,
        input: StartEpisode {
            selector: EpisodeSelector::Id(original.id.clone()),
            project_hint: None,
            guard: EpisodeRevisionGuard::Account,
        },
    };
    let forked = service
        .start_or_resume_episode(ctx.clone(), fork_request.clone())
        .await
        .unwrap();
    assert!(matches!(forked.value, EpisodeStartResult::Forked(_)));
    let mut fork = result(forked.value);
    assert_ne!(fork.id, original.id);
    assert_eq!(fork.parent, Some(original.id.clone()));
    assert_eq!(fork.acknowledgements[&personal].seq.get(), 19);
    service
        .acknowledge_delta(ctx.clone(), ack(identity(&service, &ctx, 21).await, 20))
        .await
        .unwrap();
    assert_eq!(
        service
            .get_episode(ctx.clone(), fork.id.clone())
            .await
            .unwrap()
            .acknowledgements[&personal]
            .seq
            .get(),
        19
    );
    let same_fork = service
        .start_or_resume_episode(ctx.clone(), fork_request)
        .await
        .unwrap();
    assert_eq!(result(same_fork.value).id, fork.id);
    fork = update(&service, &ctx, &fork, 22, EpisodeLifecycle::Sleeping).await;
    let resumed = service
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 23).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Id(fork.id.clone()),
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(resumed.value, EpisodeStartResult::Resumed(_)));
    fork = result(resumed.value);
    assert!(fork.revision.get() > 1);
    let ambiguous = service
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 24).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Name("working".into()),
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    match ambiguous.value {
        EpisodeStartResult::Ambiguous(choices) => assert_eq!(choices.len(), 2),
        other => panic!("{other:?}"),
    }

    // Saved role metadata must remain pinned to its current revision.
    let role = AbilityRef {
        id: AbilityId::from_bytes([4; 16]),
        placement: AbilityPlacement::System,
        revision: RevisionId::from_bytes([5; 16]),
    };
    let descriptor = AbilityDescriptor {
        attached_skills: vec![],
        promoted_from: None,
        requires_explicit_binding: false,
        reference: role.clone(),
        kind: AbilityKind::Role,
        name: "fixture-role".into(),
        description: None,
        enabled: true,
        healthy: true,
        lifecycle: Lifecycle::Active,
        entrypoint: None,
        auxiliary_files: vec![],
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(descriptor.clone());
    original.active_role = Some(role.clone());
    original = update(&service, &ctx, &original, 30, EpisodeLifecycle::Active).await;
    assert_eq!(original.active_role, Some(role.clone()));
    let mut tip = descriptor.clone();
    tip.reference.revision = RevisionId::from_bytes([7; 16]);
    fixture.catalog.ability_entries.lock().unwrap().push(tip);
    let projected = service
        .get_episode(ctx.clone(), original.id.clone())
        .await
        .unwrap();
    assert!(projected.active_role.is_none());
    assert_eq!(
        projected.diagnostics,
        vec![EpisodeDiagnostic::RoleUnavailable]
    );
    fixture.catalog.project_entries.lock().unwrap().clear();
    let projected = result(
        service
            .start_or_resume_episode(ctx.clone(), request)
            .await
            .unwrap()
            .value,
    );
    assert!(projected.project_hint.is_none());
    assert!(
        projected
            .diagnostics
            .contains(&EpisodeDiagnostic::ProjectUnavailable)
    );
    assert!(projected.active_role.is_none());

    // An owned episode does not broaden a narrowed credential's read authority.
    let mut grants = auth.spaces().clone();
    grants.get_mut(&personal).unwrap().read_classes = BTreeSet::new();
    let narrowed = auth
        .for_agent_run(
            AgentRunId::from_bytes([8; 16]),
            personal.clone(),
            ChatAudience::Personal,
            grants,
        )
        .unwrap();
    let projected = service
        .get_episode(AccountContext::new(narrowed, budget()), original.id.clone())
        .await
        .unwrap();
    assert!(projected.acknowledgements.is_empty());
    assert!(projected.project_hint.is_none());

    let other = service
        .create_account(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 40).await,
                input: NewAccount {
                    username: "other".into(),
                    email: None,
                    display_name: "Other".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    service
        .change_password(
            ctx.clone(),
            ChangePassword {
                account: other.id.clone(),
                current: None,
                replacement: SecretString::new("other episode password".into()),
                expected: other.revision,
            },
        )
        .await
        .unwrap();
    let other_session = service
        .login(
            budget(),
            PasswordLogin {
                identifier: other.username,
                password: SecretString::new("other episode password".into()),
            },
        )
        .await
        .unwrap();
    let other_ctx = AccountContext::new(
        service
            .resolve(evidence(
                AuthEvidenceKind::Session,
                other_session.token.expose(),
            ))
            .await
            .unwrap(),
        budget(),
    );
    not_found(service.get_episode(other_ctx, original.id.clone()).await);
    // Closing explicitly clears the project that was removed above.
    fork.project_hint = None;
    fork = update(&service, &ctx, &fork, 41, EpisodeLifecycle::Closed).await;
    assert_eq!(fork.lifecycle, EpisodeLifecycle::Closed);
    assert!(
        service
            .start_or_resume_episode(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, 42).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::Id(fork.id.clone()),
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Account,
                    }
                }
            )
            .await
            .is_err()
    );
    // Idle resume does not fork or overwrite saved acknowledgement rows.
    fixture.clock.0.fetch_add(31 * 60 * 1000, Ordering::SeqCst);
    let resumed = service
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 43).await,
                input: StartEpisode {
                    selector: EpisodeSelector::Id(original.id.clone()),
                    project_hint: None,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(resumed.value, EpisodeStartResult::Resumed(_)));
    assert_eq!(
        result(resumed.value).acknowledgements[&personal].seq.get(),
        20
    );

    // Space-narrowed replay of Started::Ambiguous must not disclose episodes
    // from excluded Spaces, and acknowledge_delta replay must survive episode close.
    let amb_space = service
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 44).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([0x7A; 16]),
                    kind: SpaceKind::Shared,
                    name: "Ambiguous Shared".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let amb_ctx = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let amb_proj = FolderRef {
        space_id: amb_space.space.id.clone(),
        folder_id: FolderId::from_bytes([0x7B; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (amb_space.space.id.clone(), amb_proj.folder_id.clone()),
        ProjectInfo {
            project_slug: "amb-proj".into(),
            folder: amb_proj.clone(),
            name: "Ambiguous Project".into(),
        },
    );
    let e_personal = result(
        service
            .start_or_resume_episode(
                amb_ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &amb_ctx, 45).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: EpisodeId::parse("ses_AmbPers00001").unwrap(),
                            name: Some("dup-name".into()),
                        },
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await
            .unwrap()
            .value,
    );
    let _e_shared = result(
        service
            .start_or_resume_episode(
                amb_ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &amb_ctx, 46).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: EpisodeId::parse("ses_AmbShar00002").unwrap(),
                            name: Some("dup-name".into()),
                        },
                        project_hint: Some(amb_proj),
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await
            .unwrap()
            .value,
    );
    let amb_mutation = AccountMutation {
        identity: identity(&service, &amb_ctx, 47).await,
        input: StartEpisode {
            selector: EpisodeSelector::Name("dup-name".into()),
            project_hint: None,
            guard: EpisodeRevisionGuard::Account,
        },
    };
    let amb_res = service
        .start_or_resume_episode(amb_ctx.clone(), amb_mutation.clone())
        .await
        .unwrap();
    assert!(matches!(amb_res.value, EpisodeStartResult::Ambiguous(ref v) if v.len() == 2));
    let personal_only_ctx = AccountContext::new(
        amb_ctx.auth().restrict_to_space(&personal).unwrap(),
        budget(),
    );
    not_found(
        service
            .start_or_resume_episode(personal_only_ctx, amb_mutation)
            .await,
    );

    let ack_mut = AccountMutation {
        identity: identity(&service, &amb_ctx, 48).await,
        input: AcknowledgeDelta {
            owner: AckOwner::Episode(e_personal.id.clone()),
            delivered: ChangeCursor {
                scope: fixture.catalog.entries.lock().unwrap()[&personal]
                    .2
                    .history
                    .clone(),
                after: SpaceSeq::new(5).unwrap(),
            },
        },
    };
    let ack_1 = service
        .acknowledge_delta(amb_ctx.clone(), ack_mut.clone())
        .await
        .unwrap();
    let _closed = update(
        &service,
        &amb_ctx,
        &e_personal,
        49,
        EpisodeLifecycle::Closed,
    )
    .await;
    let ack_2 = service
        .acknowledge_delta(amb_ctx, ack_mut)
        .await
        .expect("acknowledge_delta replay must succeed after episode close");
    assert_eq!(ack_2.value.seq, ack_1.value.seq);

    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_episode_state_and_authority() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_episode_state_and_authority() {
    exercise(true).await;
}

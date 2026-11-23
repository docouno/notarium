use super::{runtime_ability_cases::identity, *};
use notarium_core::classes::DocClass;

pub(super) async fn stored_legacy_episodes_and_notes_round_trip_through_mcp(
    fixture: &RuntimeFixture,
    personal: &SpaceContext,
) {
    let owner = &fixture.human;
    let principal = owner.auth().principal();
    let v1 = EpisodeId::from_bytes([250; 16]);
    for (index, spelling) in [
        "ses_abcdefghijkl",
        "ABcdE-123_4Z",
        "0123456789ABCDEF",
        v1.as_str(),
    ]
    .into_iter()
    .enumerate()
    {
        let id: EpisodeId = serde_json::from_value(json!(spelling)).unwrap();
        let tag = 246 + index as u8;
        let seeded = fixture
            .control
            .start_or_resume_episode(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, tag).await,
                    input: StartEpisode {
                        selector: EpisodeSelector::New {
                            requested: id,
                            name: None,
                        },
                        project_hint: None,
                        guard: EpisodeRevisionGuard::Account,
                    },
                },
            )
            .await
            .unwrap();
        let EpisodeStartResult::New(seeded) = seeded.value else {
            panic!("expected a fresh stored episode")
        };
        assert_eq!(seeded.id.as_str(), spelling);
        // An active recent episode deliberately forks. Persist a sleeping
        // episode to verify exact-ID resume rather than the fork contract.
        fixture
            .control
            .update_episode(
                owner.clone(),
                AccountMutation {
                    identity: identity(fixture, owner, 252 + index as u8).await,
                    input: EpisodeMutation::Full(EpisodeUpdate {
                        episode: seeded.id,
                        expected: seeded.revision,
                        name: seeded.name,
                        active_role: seeded.active_role,
                        project_hint: seeded.project_hint,
                        lifecycle: EpisodeLifecycle::Sleeping,
                    }),
                },
            )
            .await
            .unwrap();
        let resumed = call(
            fixture,
            owner,
            tag,
            "start_session",
            json!({"session":{"id":spelling}}),
        )
        .await
        .unwrap();
        assert_eq!(resumed.structured_content["session"]["id"], spelling);
        assert_eq!(resumed.structured_content["session"]["state"], "resumed");
    }

    for (index, spelling) in ["ABcdE-123_4Z", "0123456789ABCDEF"].into_iter().enumerate() {
        let note = NoteId::parse(spelling).unwrap();
        let tag = 250 + index as u8;
        fixture
            .canonical
            .create_note(
                personal.clone(),
                Mutation {
                    identity: CommandIdentity {
                        scope: personal.scope().clone(),
                        actor: principal.clone(),
                        key: CommandKey::from_bytes([tag; 16]),
                        hash: ContentDigest::from_bytes([tag; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note.clone(),
                        parent: None,
                        slug: format!("legacy-fixture-{tag}"),
                        class: DocClass::UserDoc,
                        carrier: "# Legacy note\n\nOriginal content.".into(),
                        folder_page: false,
                    },
                },
            )
            .await
            .unwrap();
        let read = call(
            fixture,
            owner,
            tag,
            "get_note",
            json!({"ref":note,"responseFormat":"concise"}),
        )
        .await
        .unwrap();
        assert_eq!(read.structured_content["noteId"], spelling);
        call(fixture, owner, tag, "edit_note", json!({
            "ref":note, "operation":"append", "content":"Written via the legacy ID.",
            "versionToken":read.structured_content["versionToken"], "session":"ses_abcdefghijkl",
        })).await.unwrap();
        let snapshot = fixture
            .canonical
            .get_note(
                personal.clone(),
                GetNote {
                    note,
                    revision: None,
                    causal: CausalBasis::Await(Default::default()),
                },
            )
            .await
            .unwrap();
        assert!(
            snapshot
                .document
                .explicit_read(owner.auth())
                .unwrap()
                .contains("Written via the legacy ID.")
        );
    }

    assert!(
        call(
            fixture,
            owner,
            253,
            "get_note",
            json!({"ref":"ses_abcdefghijkl"})
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn episode_target_commands_replay_old_receipts_and_survive_account_changes() {
    let fixture = RuntimeFixture::open_named(false, "episode_command_replay").await;
    let human = &fixture.human;
    let plane = &fixture.control_plane;
    let start = AccountMutation {
        identity: identity(&fixture, human, 110).await,
        input: StartEpisode {
            selector: EpisodeSelector::New {
                requested: EpisodeId::from_bytes([110; 16]),
                name: None,
            },
            project_hint: None,
            guard: EpisodeRevisionGuard::Account,
        },
    };
    let saved = fixture
        .control
        .start_or_resume_episode(human.clone(), start.clone())
        .await
        .unwrap();
    let mut replay_target = start.clone();
    replay_target.input.guard = EpisodeRevisionGuard::Target;
    let replayed = plane
        .start_or_resume_episode(human.clone(), replay_target)
        .await
        .unwrap();
    assert_eq!(saved.revision, replayed.revision);
    let EpisodeStartResult::New(ep) = replayed.value else {
        panic!("expected saved episode")
    };

    let mut second = start;
    second.identity.key = CommandKey::from_bytes([111; 16]);
    second.input.selector = EpisodeSelector::New {
        requested: EpisodeId::from_bytes([111; 16]),
        name: None,
    };
    assert!(matches!(
        fixture
            .control
            .start_or_resume_episode(human.clone(), second.clone())
            .await,
        Err(PortError::Domain(
            DomainError::ControlRevisionConflict { .. }
        ))
    ));
    second.input.guard = EpisodeRevisionGuard::Target;
    plane
        .start_or_resume_episode(human.clone(), second)
        .await
        .unwrap();

    let roles = plane
        .discover_abilities(
            human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: None,
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap()
        .items;
    let first_role = roles.iter().find(|entry| entry.name == "research").unwrap();
    let next_role = roles.iter().find(|entry| entry.name == "grooming").unwrap();
    let full_update = AccountMutation {
        identity: identity(&fixture, human, 112).await,
        input: EpisodeMutation::Full(EpisodeUpdate {
            episode: ep.id.clone(),
            expected: ep.revision,
            name: ep.name,
            active_role: Some(first_role.reference.clone()),
            project_hint: None,
            lifecycle: EpisodeLifecycle::Active,
        }),
    };
    let saved = fixture
        .control
        .update_episode(human.clone(), full_update.clone())
        .await
        .unwrap();
    let replay = plane
        .update_episode(human.clone(), full_update)
        .await
        .unwrap();
    assert_eq!(saved.revision, replay.revision);

    let mut binding = AccountMutation {
        identity: notarium_core::receipt::AccountCommandIdentity {
            key: CommandKey::from_bytes([113; 16]),
            ..identity(&fixture, human, 113).await
        },
        input: EpisodeMutation::BindRole(BindEpisodeRole {
            episode: ep.id,
            expected: ep.revision,
            active_role: next_role.reference.clone(),
            project_hint: None,
        }),
    };
    assert!(matches!(
        plane.update_episode(human.clone(), binding.clone()).await,
        Err(PortError::Domain(
            DomainError::ControlRevisionConflict { .. }
        ))
    ));
    if let EpisodeMutation::BindRole(ref mut inner) = binding.input {
        inner.expected = saved.value.revision;
    }
    let rebound = plane.update_episode(human.clone(), binding).await.unwrap();
    assert_eq!(rebound.value.active_role, Some(next_role.reference.clone()));
    fixture.close().await;
}

#[tokio::test]
async fn ordinary_mcp_calls_keep_an_active_episode_forkable() {
    let fixture = RuntimeFixture::open_named(false, "episode_mcp_activity").await;
    let human = &fixture.human;
    let start = call(&fixture, human, 115, "start_session", json!({}))
        .await
        .unwrap();
    let session = start.structured_content["session"]["id"].clone();
    let advance = |minutes: i64| {
        fixture
            .storage
            .clock
            .0
            .fetch_add(minutes * 60_000, std::sync::atomic::Ordering::SeqCst);
    };
    advance(20);
    call(&fixture, human, 116, "whoami", json!({"session":session}))
        .await
        .unwrap();
    advance(20);
    let joined = call(
        &fixture,
        human,
        117,
        "start_session",
        json!({"session":{"id":session}}),
    )
    .await
    .unwrap();
    assert_eq!(joined.structured_content["session"]["state"], "forked");
    assert_eq!(joined.structured_content["session"]["parentId"], session);
    fixture.close().await;
}

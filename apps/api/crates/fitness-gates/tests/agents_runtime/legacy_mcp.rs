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
                    input: EpisodeUpdate {
                        episode: seeded.id,
                        expected: seeded.revision,
                        name: seeded.name,
                        active_role: seeded.active_role,
                        project_hint: seeded.project_hint,
                        lifecycle: EpisodeLifecycle::Sleeping,
                    },
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

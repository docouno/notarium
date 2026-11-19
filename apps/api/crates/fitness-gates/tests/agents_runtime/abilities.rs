use super::*;
use notarium_canonical::CreateFolderSpec;
use notarium_core::{auth::SpaceKind, model::FolderRef, receipt::AccountCommandIdentity};
use std::{future::Future, time::Duration};
use tokio::time::timeout;

#[tokio::test]
async fn sqlite_authoring_settles_exact_overlays() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(authoring_settlement(false)).await;
}

#[tokio::test]
async fn postgres_authoring_settles_exact_overlays() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(authoring_settlement(true)).await;
}

async fn authoring_settlement(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "agents_ability_settlement")).await;
    Box::pin(exercise_authoring_settlement(&fixture)).await;
    Box::pin(fixture.close()).await;
}

async fn concurrent_overlay_during_publication<T>(
    fixture: &RuntimeFixture,
    publication: impl Future<Output = T>,
    concurrent: impl Future<Output = ()>,
) -> T {
    let (entered, release) = fixture.projections.pause_ability_publication();
    let update = async {
        timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        concurrent.await;
        release.send(()).unwrap();
    };
    tokio::join!(publication, update).0
}

async fn exercise_authoring_settlement(fixture: &RuntimeFixture) {
    let owner = &fixture.human;
    let created = call(
        fixture,
        owner,
        1,
        "create_ability",
        json!({
            "kind":"role", "name":"settlement-guide", "description":"Test guide",
            "instructions":"Initial guide", "placement":{"home":"personal"},
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let [ability]: [AbilityDescriptor; 1] = fixture
        .control
        .discover_abilities(
            owner.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: None,
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: Some("settlement-guide".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .try_into()
        .unwrap();
    let identity = ability.reference.identity();
    let inspect = || {
        fixture
            .control
            .inspect_ability(owner.clone(), identity.clone())
    };
    let edit = json!({
        "ref":created["ref"], "versionToken":created["versionToken"],
        "instructions":"Publish while the account changes", "enabled":false,
    });
    let updated = Box::pin(authoring_authority_cases::bump_account_after_publication(
        fixture,
        call(fixture, owner, 2, "edit_ability", edit.clone()),
    ))
    .await
    .unwrap()
    .structured_content;
    assert_eq!(updated["outcome"], "updated", "{updated}");
    assert_eq!(updated["steps"][3]["outcome"], "applied");
    assert_eq!(updated["enabled"], false);
    for _ in 0..10 {
        fixture.pat(BearerScope::Read, false).await;
    }
    let saved = inspect().await.unwrap().overlays.preference_revision;
    let replay = call(fixture, owner, 2, "edit_ability", edit.clone())
        .await
        .unwrap();
    assert_eq!(replay.structured_content, updated);
    assert_eq!(inspect().await.unwrap().overlays.preference_revision, saved);

    let preferences = json!({
        "ref":updated["ref"], "versionToken":updated["versionToken"],
        "instructions":"Publish before a competing preference", "enabled":true,
    });
    let blocked = Box::pin(concurrent_overlay_during_publication(
        fixture,
        call(fixture, owner, 3, "edit_ability", preferences.clone()),
        async {
            let current = inspect().await.unwrap();
            fixture
                .control
                .set_ability_preference(
                    owner.clone(),
                    AccountMutation {
                        identity: runtime_ability_cases::identity(fixture, owner, 4).await,
                        input: AbilityPreferenceUpdate {
                            ability: current.descriptor.reference,
                            enabled: false,
                        },
                    },
                )
                .await
                .unwrap();
        },
    ))
    .await
    .unwrap()
    .structured_content;
    assert_eq!(blocked["outcome"], "partial", "{blocked}");
    assert_eq!(blocked["steps"][0]["outcome"], "applied");
    assert_eq!(
        blocked["steps"][3]["error"]["code"],
        "control_revision_conflict"
    );
    let state = inspect().await.unwrap().overlays;
    assert!(!state.preference_enabled);
    assert_ne!(state.preference_revision, saved);
    let replay = call(fixture, owner, 3, "edit_ability", preferences)
        .await
        .unwrap();
    assert_eq!(replay.structured_content, blocked);
    assert_eq!(
        inspect().await.unwrap().overlays.preference_revision,
        state.preference_revision
    );
    // Exact replay of an earlier authoring edit replays its overlay receipt
    // without mutating state, and fails at the final current-package check
    // rather than returning a partial overlay error or a later package version.
    let earlier_replay = call(fixture, owner, 2, "edit_ability", edit)
        .await
        .err()
        .expect("replaying an older edit after a newer publication must report RevisionConflict");
    assert!(
        matches!(
            earlier_replay,
            PortError::Domain(DomainError::RevisionConflict { .. })
        ),
        "{earlier_replay:?}"
    );
    assert_eq!(
        inspect().await.unwrap().overlays.preference_revision,
        state.preference_revision
    );

    let current = inspect().await.unwrap();
    fixture
        .control
        .update_ability_binding(
            owner.clone(),
            AccountMutation {
                identity: runtime_ability_cases::identity(fixture, owner, 5).await,
                input: AbilityBindingUpdate {
                    ability: current.descriptor.reference,
                    enabled: true,
                    expected: current.binding_revision,
                    projects: AbilityProjects::Selected(vec![]),
                },
            },
        )
        .await
        .unwrap();
    let current = call(
        fixture,
        owner,
        6,
        "get_ability",
        json!({"ref":blocked["ref"]}),
    )
    .await
    .unwrap()
    .structured_content;
    let binding = json!({
        "ref":current["ref"], "versionToken":current["versionToken"],
        "instructions":"Publish before a competing binding", "availability":{"mode":"all-projects"},
    });
    let blocked = Box::pin(concurrent_overlay_during_publication(
        fixture,
        call(fixture, owner, 7, "edit_ability", binding.clone()),
        async {
            let current = inspect().await.unwrap();
            fixture
                .control
                .update_ability_binding(
                    owner.clone(),
                    AccountMutation {
                        identity: runtime_ability_cases::identity(fixture, owner, 8).await,
                        input: AbilityBindingUpdate {
                            ability: current.descriptor.reference,
                            enabled: false,
                            expected: current.binding_revision,
                            projects: AbilityProjects::Selected(vec![]),
                        },
                    },
                )
                .await
                .unwrap();
        },
    ))
    .await
    .unwrap()
    .structured_content;
    assert_eq!(blocked["outcome"], "partial", "{blocked}");
    assert_eq!(blocked["steps"][0]["outcome"], "applied");
    assert_eq!(
        blocked["steps"][2]["error"]["code"],
        "control_revision_conflict"
    );
    let current = inspect().await.unwrap();
    assert!(!current.binding_enabled);
    assert_eq!(current.availability, AbilityProjects::Selected(vec![]));
    let replay = call(fixture, owner, 7, "edit_ability", binding)
        .await
        .unwrap();
    assert_eq!(replay.structured_content, blocked);
    assert_eq!(
        inspect().await.unwrap().binding_revision,
        current.binding_revision
    );
}

pub(super) async fn overrides_and_promotion(fixture: &RuntimeFixture) {
    let owner = fixture.human.auth().principal().clone();
    let revision = fixture
        .control
        .account(fixture.human.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    let identity = |expected, key| AccountCommandIdentity {
        owner: owner.clone(),
        actor: owner.clone(),
        expected,
        key: CommandKey::from_bytes([key; 16]),
        hash: ContentDigest::from_bytes([key; 32]),
    };
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(revision, 88),
                input: CreateSpace {
                    id: SpaceId::from_bytes([88; 16]),
                    kind: SpaceKind::Shared,
                    name: "Authoring".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let storage = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap();
    let human = AccountContext::new(
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
    let project = |byte, slug: &str| {
        (
            FolderRef {
                space_id: shared.history.space_id.clone(),
                folder_id: FolderId::from_bytes([byte; 16]),
            },
            slug.to_owned(),
        )
    };
    let (first, first_slug) = project(91, "first");
    let (second, second_slug) = project(92, "second");
    for (project, slug) in [(&first, &first_slug), (&second, &second_slug)] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: shared.history.clone(),
                active_epoch: storage.active_epoch,
                folder_id: project.folder_id.clone(),
                parent: None,
                slug: slug.clone(),
                display_name: slug.clone(),
                is_project: true,
                project_slug: Some(slug.clone()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let first_handle = format!("{}/{}", shared.slug, first_slug);
    let second_handle = format!("{}/{}", shared.slug, second_slug);
    let layout = |name: &str, instructions: &str, placement: Value| {
        json!({
            "kind":"role","name":name,"description":"Test guide", "instructions":instructions,"placement":placement,
        })
    };
    let initial = layout(
        "override-guide",
        "Space instructions",
        json!({"home":"space","space":shared.slug}),
    );
    let created_space = Box::pin(authoring_authority_cases::bump_account_after_publication(
        fixture,
        call(fixture, &human, 89, "create_ability", initial.clone()),
    ))
    .await
    .unwrap();
    fixture.pat(BearerScope::Read, false).await;
    let replayed_space = call(fixture, &human, 89, "create_ability", initial)
        .await
        .unwrap();
    assert_eq!(
        created_space.structured_content,
        replayed_space.structured_content
    );
    call(
        fixture,
        &human,
        90,
        "create_ability",
        layout(
            "override-guide",
            "Project instructions",
            json!({"home":"project","project":first_handle}),
        ),
    )
    .await
    .unwrap();
    for (key, project, expected) in [
        (91, &first_handle, "Project instructions"),
        (92, &second_handle, "Space instructions"),
    ] {
        let result = call(
            fixture,
            &human,
            key,
            "use_role",
            json!({"name":"override-guide","project":project}),
        )
        .await
        .unwrap();
        assert_eq!(result.structured_content["instructions"], expected);
    }
    let created = call(
        fixture,
        &human,
        93,
        "create_ability",
        layout(
            "promotion-guide",
            "Before promotion",
            json!({"home":"project","project":first_handle}),
        ),
    )
    .await
    .unwrap();
    let reference = created.structured_content["ref"].as_str().unwrap();
    let revision = fixture
        .control
        .account(human.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    let episode = fixture
        .control
        .start_or_resume_episode(
            human.clone(),
            AccountMutation {
                identity: identity(revision, 97),
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::from_bytes([97; 16]),
                        name: None,
                    },
                    project_hint: Some(first.clone()),
                },
            },
        )
        .await
        .unwrap();
    let EpisodeStartResult::New(episode) = episode.value else {
        panic!("expected new episode");
    };
    call(
        fixture,
        &human,
        94,
        "use_role",
        json!({"role":reference,"session":episode.id}),
    )
    .await
    .unwrap();
    call(
        fixture,
        &human,
        95,
        "edit_ability",
        json!({"ref":reference,"enabled":false}),
    )
    .await
    .unwrap();
    let promotion = json!({
        "ref":reference,
        "versionToken":created.structured_content["versionToken"],
        "home":{"home":"space"},
        "instructions":"After promotion",
    });
    let promoted = Box::pin(authoring_authority_cases::bump_account_after_publication(
        fixture,
        call(fixture, &human, 96, "edit_ability", promotion.clone()),
    ))
    .await
    .unwrap();
    assert_eq!(
        promoted.structured_content["steps"][0]["outcome"], "applied",
        "{}",
        promoted.structured_content,
    );
    assert_eq!(
        promoted.structured_content["steps"][1]["outcome"], "applied",
        "{}",
        promoted.structured_content,
    );
    assert_eq!(
        promoted.structured_content["availability"]["mode"],
        "selected-projects"
    );
    assert_eq!(promoted.structured_content["enabled"], false);
    fixture.pat(BearerScope::Read, false).await;
    let replayed_promotion = call(fixture, &human, 96, "edit_ability", promotion)
        .await
        .unwrap();
    assert_eq!(
        promoted.structured_content,
        replayed_promotion.structured_content
    );
    let destination = promoted.structured_content["ref"].as_str().unwrap();
    call(
        fixture,
        &human,
        97,
        "edit_ability",
        json!({"ref":destination,"enabled":true}),
    )
    .await
    .unwrap();
    let resumed = fixture
        .control
        .get_episode(human.clone(), episode.id)
        .await
        .unwrap();
    let active = resumed
        .active_role
        .expect("promotion must preserve the old episode reference");
    assert_eq!(
        active.placement,
        AbilityPlacement::OwnedSpace(shared.history.space_id.clone())
    );
    assert!(
        call(
            fixture,
            &human,
            98,
            "use_role",
            json!({"name":"promotion-guide","project":second_handle})
        )
        .await
        .is_err()
    );
    let scope = SpaceContext::new(human.auth().clone(), shared.history, budget()).unwrap();
    restricted_publication_waits_for_binding(
        fixture,
        &human,
        scope,
        first,
        &first_handle,
        &second_handle,
    )
    .await;
}

async fn restricted_publication_waits_for_binding(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    scope: SpaceContext,
    project: FolderRef,
    selected_handle: &str,
    other_handle: &str,
) {
    use notarium_core::classes::{AbilityKind, DocClass};

    let owner = human.auth().principal();
    let command = |key| CommandIdentity {
        scope: scope.scope().clone(),
        actor: owner.clone(),
        key: CommandKey::from_bytes([key; 16]),
        hash: ContentDigest::from_bytes([key; 32]),
    };
    let note = NoteId::from_bytes([116; 16]);
    let ability = AbilityId::from_bytes([116; 16]);
    let auxiliary = "Exact auxiliary bytes.\n";
    let entry = fixture
        .canonical
        .create_note(
            scope.clone(),
            Mutation {
                identity: command(116),
                preconditions: Default::default(),
                input: CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "restricted-guide".into(),
                    class: DocClass::Skill,
                    carrier: "Restricted instructions".into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let publication = fixture
        .canonical
        .publish_ability_package(
            scope.clone(),
            Mutation {
                identity: command(117),
                preconditions: Default::default(),
                input: PublishAbilityPackage {
                    ability: ability.clone(),
                    kind: AbilityKind::Role,
                    entrypoint: note,
                    files: vec![AbilityFile {
                        path: "references/guide.md".into(),
                        content: auxiliary.into(),
                        digest: notarium_syntax::content_digest(auxiliary),
                    }],
                    attached_skills: vec![],
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(entry.value.revision),
                    requires_explicit_binding: true,
                },
            },
        )
        .await
        .unwrap();
    assert!(
        call(
            fixture,
            human,
            116,
            "use_role",
            json!({"name":"restricted-guide","project":selected_handle})
        )
        .await
        .is_err()
    );
    let account_revision = fixture
        .control
        .account(human.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    fixture
        .control
        .update_ability_binding(
            human.clone(),
            AccountMutation {
                identity: AccountCommandIdentity {
                    owner: owner.clone(),
                    actor: owner.clone(),
                    expected: account_revision,
                    key: CommandKey::from_bytes([117; 16]),
                    hash: ContentDigest::from_bytes([117; 32]),
                },
                input: AbilityBindingUpdate {
                    ability: AbilityRef {
                        id: ability,
                        placement: AbilityPlacement::OwnedSpace(scope.scope().space_id.clone()),
                        revision: publication.value.revision,
                    },
                    enabled: true,
                    expected: ControlRevision::ZERO,
                    projects: AbilityProjects::Selected(vec![project]),
                },
            },
        )
        .await
        .unwrap();
    assert!(
        call(
            fixture,
            human,
            117,
            "use_role",
            json!({"name":"restricted-guide","project":other_handle})
        )
        .await
        .is_err()
    );
    let admitted = call(
        fixture,
        human,
        118,
        "use_role",
        json!({"name":"restricted-guide","project":selected_handle}),
    )
    .await
    .unwrap();
    assert_eq!(
        admitted.structured_content["instructions"],
        "Restricted instructions"
    );
    let reader = fixture.pat(BearerScope::Read, false).await;
    let packaged = call(
        fixture,
        &reader,
        119,
        "get_ability",
        json!({"ref":admitted.structured_content["ref"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        packaged.structured_content["auxiliaryFiles"][0],
        "references/guide.md"
    );
    assert_eq!(
        packaged.structured_content["resources"][0]["content"],
        auxiliary
    );
}

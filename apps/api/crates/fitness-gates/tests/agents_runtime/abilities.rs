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
    let [ability]: [AbilityInspection; 1] = fixture
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
    let identity = ability.descriptor.reference.identity();
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
                        input: AbilityPreferenceChange {
                            preference: AbilityPreferenceUpdate {
                                ability: current.descriptor.reference,
                                enabled: false,
                            },
                            expected: AbilityPreferenceGuard::Account,
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
    // Exact replay of an earlier authoring edit replays its original committed
    // receipt without mutating state or leaking later package/overlay edits.
    let earlier_replay = call(fixture, owner, 2, "edit_ability", edit)
        .await
        .expect("replaying an earlier committed edit must return its exact original receipt");
    assert_eq!(earlier_replay.structured_content, updated);
    assert_eq!(
        inspect().await.unwrap().overlays.preference_revision,
        state.preference_revision
    );

    // Replay of create_ability after later manual package & overlay edits must
    // still return the exact original creation receipt (original versionToken).
    let create_replay = call(
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
    .expect("replaying create_ability after later edits must return exact original receipt");
    assert_eq!(create_replay.structured_content, created);

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
                    expected: AbilityOverlayGuard::Account(current.binding_revision),
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
                            expected: AbilityOverlayGuard::Account(current.binding_revision),
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
                    guard: EpisodeRevisionGuard::Account,
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
    Box::pin(restricted_publication_waits_for_binding(
        fixture,
        &human,
        scope,
        first,
        &first_handle,
        &second_handle,
    ))
    .await;
}

#[tokio::test]
async fn sqlite_promotion_conflicts_and_binding_replay() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(promotion_conflicts_and_binding_replay_case(false)).await;
}

#[tokio::test]
async fn postgres_promotion_conflicts_and_binding_replay() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    Box::pin(promotion_conflicts_and_binding_replay_case(true)).await;
}

async fn promotion_conflicts_and_binding_replay_case(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(
        pg,
        "agents_ability_promo_replay",
    ))
    .await;
    let owner = fixture.human.auth().principal().clone();
    let revision = fixture
        .control
        .account(fixture.human.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: AccountCommandIdentity {
                    owner: owner.clone(),
                    actor: owner.clone(),
                    expected: revision,
                    key: CommandKey::from_bytes([0xdf; 16]),
                    hash: ContentDigest::from_bytes([0xdf; 32]),
                },
                input: CreateSpace {
                    id: SpaceId::from_bytes([0xdf; 16]),
                    kind: SpaceKind::Shared,
                    name: "PromoReplay".into(),
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
    let first = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([0xde; 16]),
    };
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: shared.history.clone(),
            active_epoch: storage.active_epoch,
            folder_id: first.folder_id.clone(),
            parent: None,
            slug: "first".into(),
            display_name: "first".into(),
            is_project: true,
            project_slug: Some("first".into()),
            actor: owner,
            timestamp: None,
        })
        .await
        .unwrap();
    let first_handle = format!("{}/first", shared.slug);
    Box::pin(binding_replay_after_advance_and_trash(
        &fixture,
        &human,
        &shared.slug,
        &first,
        &first_handle,
    ))
    .await;
    Box::pin(promotion_concurrent_source_overlay_conflicts(
        &fixture,
        &human,
        &first,
        &first_handle,
    ))
    .await;
    Box::pin(fixture.close()).await;
}

async fn concurrent_overlay_before_promotion<T>(
    fixture: &RuntimeFixture,
    promotion: impl Future<Output = T>,
    concurrent: impl Future<Output = ()>,
) -> T {
    let (entered, release) = fixture.projections.pause_note_move();
    let update = async {
        timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        Box::pin(concurrent).await;
        release.send(()).unwrap();
    };
    tokio::join!(Box::pin(promotion), Box::pin(update)).0
}

async fn binding_replay_after_advance_and_trash(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    shared_slug: &str,
    first_project: &FolderRef,
    first_handle: &str,
) {
    let owner = human.auth().principal();
    // Exact replay of authored bindings and availability edits after package
    // revision advance (R1 -> R2) and after trash.
    let created = call(
        fixture,
        human,
        0xe0,
        "create_ability",
        json!({
            "kind":"role","name":"binding-replay-guide","description":"Test guide",
            "instructions":"Initial binding guide","placement":{"home":"space","space":shared_slug},
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let [desc]: [AbilityInspection; 1] = fixture
        .control
        .discover_abilities(
            human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: None,
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: Some("binding-replay-guide".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .try_into()
        .unwrap();
    let r1_ref = desc.descriptor.reference.clone();
    let avail_edit = json!({
        "ref":created["ref"],
        "availability":{"mode":"selected-projects","projects":[first_handle]},
    });
    let updated = call(fixture, human, 0xe1, "edit_ability", avail_edit.clone())
        .await
        .unwrap()
        .structured_content;
    assert_eq!(updated["outcome"], "updated", "{updated}");
    let current_binding_rev = fixture
        .control
        .inspect_ability(human.clone(), r1_ref.identity())
        .await
        .unwrap()
        .overlays
        .binding_revision;
    let direct_req = AccountMutation {
        identity: AccountCommandIdentity {
            owner: owner.clone(),
            actor: owner.clone(),
            expected: ControlRevision::ZERO,
            key: CommandKey::from_bytes([0xe2; 16]),
            hash: ContentDigest::from_bytes([0xe2; 32]),
        },
        input: AbilityBindingUpdate {
            ability: r1_ref.clone(),
            enabled: true,
            projects: AbilityProjects::Selected(vec![first_project.clone()]),
            expected: AbilityOverlayGuard::Authored(current_binding_rev),
        },
    };
    let direct_committed = fixture
        .control
        .update_ability_binding(human.clone(), direct_req.clone())
        .await
        .unwrap();
    assert_eq!(direct_committed.value.reference, r1_ref);
    let acc_pref_req = AccountMutation {
        identity: runtime_ability_cases::identity(fixture, human, 0xf2).await,
        input: AbilityPreferenceChange {
            preference: AbilityPreferenceUpdate {
                ability: r1_ref.clone(),
                enabled: false,
            },
            expected: AbilityPreferenceGuard::Account,
        },
    };
    let acc_pref_committed = fixture
        .control
        .set_ability_preference(human.clone(), acc_pref_req.clone())
        .await
        .unwrap();
    assert_eq!(acc_pref_committed.value.ability, r1_ref);
    assert!(!acc_pref_committed.value.enabled);
    // Advance package R1 -> R2.
    let current_view = call(
        fixture,
        human,
        0xe3,
        "get_ability",
        json!({"ref":updated["ref"]}),
    )
    .await
    .unwrap()
    .structured_content;
    let r2_edit = json!({
        "ref":current_view["ref"],
        "versionToken":current_view["versionToken"],
        "instructions":"Second binding guide",
    });
    let r2 = call(fixture, human, 0xe4, "edit_ability", r2_edit.clone())
        .await
        .unwrap()
        .structured_content;
    assert_eq!(r2["outcome"], "updated", "{r2}");
    // Direct update_ability_binding replay returns exact R1 AbilityRef even at R2.
    let replayed_direct_r2 = fixture
        .control
        .update_ability_binding(human.clone(), direct_req.clone())
        .await
        .unwrap();
    assert_eq!(replayed_direct_r2.value.reference, r1_ref);
    assert_eq!(replayed_direct_r2.revision, direct_committed.revision);
    // MCP edit_ability(availability) replay returns the exact original receipt
    // without mutating state or leaking later R2 package/binding revisions.
    let replayed_avail_r2 = call(fixture, human, 0xe1, "edit_ability", avail_edit.clone())
        .await
        .expect("replaying availability edit after R1 -> R2 must return exact original receipt");
    assert_eq!(replayed_avail_r2.structured_content, updated);
    // Trash R2 and verify exact replays still return the exact committed receipt
    // at both ControlPort and MCP (while authored edits fail cleanly on trash).
    call(
        fixture,
        human,
        0xe5,
        "delete_ability",
        json!({"ref":r2["ref"]}),
    )
    .await
    .unwrap();
    let replayed_direct_trashed = fixture
        .control
        .update_ability_binding(human.clone(), direct_req)
        .await
        .unwrap();
    assert_eq!(replayed_direct_trashed.value.reference, r1_ref);
    let replayed_acc_pref_trashed = fixture
        .control
        .set_ability_preference(human.clone(), acc_pref_req)
        .await
        .unwrap();
    assert_eq!(
        replayed_acc_pref_trashed.revision,
        acc_pref_committed.revision
    );
    assert_eq!(replayed_acc_pref_trashed.value.ability, r1_ref);
    // Fresh Account-guarded binding/preference updates targeting a trashed/stale
    // canonical ability must fail cleanly rather than committing orphaned rows.
    let stale_acc_pref = fixture
        .control
        .set_ability_preference(
            human.clone(),
            AccountMutation {
                identity: runtime_ability_cases::identity(fixture, human, 0xf3).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: r1_ref.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await;
    assert!(
        matches!(
            stale_acc_pref,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "fresh Account preference update against trashed ability must reject: {stale_acc_pref:?}"
    );
    let replayed_avail_trashed = call(fixture, human, 0xe1, "edit_ability", avail_edit)
        .await
        .expect("replaying availability edit after trash must return exact original receipt");
    assert_eq!(replayed_avail_trashed.structured_content, updated);
    // Replaying an already-committed authored edit after trash must return the
    // exact original committed receipt (matching availability/ControlPort replays),
    // while a fresh authored edit against the trashed ability must return
    // ResourceNotFound rather than wrapping a zero-step failure as Ok(partial).
    let replayed_authored_trashed = call(fixture, human, 0xe4, "edit_ability", r2_edit)
        .await
        .expect("replaying committed authored edit after trash must return exact original receipt");
    assert_eq!(replayed_authored_trashed.structured_content, r2);
    let fresh_authored_trashed = call(
        fixture,
        human,
        0xe8,
        "edit_ability",
        json!({
            "ref": r2["ref"],
            "versionToken": r2["versionToken"],
            "instructions": "Fresh edit after trash",
        }),
    )
    .await
    .err()
    .expect("fresh authored edit against trashed ability must return ResourceNotFound");
    assert!(
        matches!(
            fresh_authored_trashed,
            PortError::Domain(DomainError::ResourceNotFound)
        ),
        "{fresh_authored_trashed:?}"
    );
}

async fn promotion_concurrent_source_overlay_conflicts(
    fixture: &RuntimeFixture,
    human: &AccountContext,
    first_project: &FolderRef,
    first_handle: &str,
) {
    // Promotion with a concurrent source preference edit targeting the same
    // boolean must report `partial` / `control_revision_conflict` instead of
    // masking the race as `skipped`.
    let pref_src = call(
        fixture,
        human,
        0xe6,
        "create_ability",
        json!({
            "kind":"role","name":"promo-pref-race","description":"Test guide",
            "instructions":"Initial promo pref","placement":{"home":"project","project":first_handle},
        }),
    )
    .await
    .unwrap()
    .structured_content;
    let [pref_desc]: [AbilityInspection; 1] = fixture
        .control
        .discover_abilities(
            human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: Some(first_project.clone()),
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: Some("promo-pref-race".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .try_into()
        .unwrap();
    let pref_promo = json!({
        "ref":pref_src["ref"],
        "versionToken":pref_src["versionToken"],
        "home":{"home":"space"},
        "instructions":"Promoted with pref conflict",
        "enabled":false,
    });
    let pref_blocked = Box::pin(concurrent_overlay_before_promotion(
        fixture,
        call(fixture, human, 0xe7, "edit_ability", pref_promo.clone()),
        async {
            fixture
                .control
                .set_ability_preference(
                    human.clone(),
                    AccountMutation {
                        identity: runtime_ability_cases::identity(fixture, human, 0xe8).await,
                        input: AbilityPreferenceChange {
                            preference: AbilityPreferenceUpdate {
                                ability: pref_desc.descriptor.reference.clone(),
                                enabled: false,
                            },
                            expected: AbilityPreferenceGuard::Account,
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
    assert_eq!(pref_blocked["outcome"], "partial", "{pref_blocked}");
    assert_eq!(pref_blocked["steps"][0]["outcome"], "applied");
    assert_eq!(pref_blocked["steps"][1]["outcome"], "applied");
    assert_eq!(
        pref_blocked["steps"][3]["error"]["code"],
        "control_revision_conflict"
    );
    let pref_replayed = call(fixture, human, 0xe7, "edit_ability", pref_promo)
        .await
        .unwrap()
        .structured_content;
    assert_eq!(pref_replayed, pref_blocked);

    // Promotion with a concurrent source binding edit must report `partial` /
    // `control_revision_conflict`, preserve the competing binding, and replay identically.
    let bind_src_initial = call(
        fixture,
        human,
        0xe9,
        "create_ability",
        json!({
            "kind":"role","name":"promo-bind-race","description":"Test guide",
            "instructions":"Initial promo bind","placement":{"home":"project","project":first_handle},
        }),
    )
    .await
    .unwrap()
    .structured_content;
    // Perform a pre-promotion authored edit so we can later verify that
    // replaying it after promotion fails with ResourceNotFound (never partial).
    let pre_promo_authored_edit = json!({
        "ref":bind_src_initial["ref"],
        "versionToken":bind_src_initial["versionToken"],
        "instructions":"Pre-promotion authored edit",
    });
    let bind_src = call(
        fixture,
        human,
        0xec,
        "edit_ability",
        pre_promo_authored_edit.clone(),
    )
    .await
    .unwrap()
    .structured_content;
    let [bind_desc]: [AbilityInspection; 1] = fixture
        .control
        .discover_abilities(
            human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(10, None).unwrap(),
                project: Some(first_project.clone()),
                kind: Some(notarium_core::classes::AbilityKind::Role),
                name: Some("promo-bind-race".into()),
                authoring: true,
            },
        )
        .await
        .unwrap()
        .items
        .try_into()
        .unwrap();
    let bind_promo = json!({
        "ref":bind_src["ref"],
        "versionToken":bind_src["versionToken"],
        "home":{"home":"space"},
        "instructions":"Promoted with bind conflict",
        "availability":{"mode":"all-projects"},
    });
    let bind_blocked = Box::pin(concurrent_overlay_before_promotion(
        fixture,
        call(fixture, human, 0xea, "edit_ability", bind_promo.clone()),
        async {
            let inspected = fixture
                .control
                .inspect_ability(human.clone(), bind_desc.descriptor.reference.identity())
                .await
                .unwrap();
            fixture
                .control
                .update_ability_binding(
                    human.clone(),
                    AccountMutation {
                        identity: runtime_ability_cases::identity(fixture, human, 0xeb).await,
                        input: AbilityBindingUpdate {
                            ability: inspected.descriptor.reference,
                            enabled: false,
                            expected: AbilityOverlayGuard::Account(inspected.binding_revision),
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
    assert_eq!(bind_blocked["outcome"], "partial", "{bind_blocked}");
    assert_eq!(bind_blocked["steps"][0]["outcome"], "applied");
    assert_eq!(bind_blocked["steps"][1]["outcome"], "applied");
    assert_eq!(
        bind_blocked["steps"][2]["error"]["code"],
        "control_revision_conflict"
    );
    let dst_identity = AbilityIdentity {
        id: bind_desc.descriptor.reference.id.clone(),
        placement: AbilityPlacement::OwnedSpace(first_project.space_id.clone()),
    };
    let dst_state = fixture
        .control
        .inspect_ability(human.clone(), dst_identity)
        .await
        .unwrap();
    assert!(!dst_state.binding_enabled);
    let bind_replayed = call(fixture, human, 0xea, "edit_ability", bind_promo)
        .await
        .unwrap()
        .structured_content;
    assert_eq!(bind_replayed, bind_blocked);
    // Replaying the pre-promotion authored edit after promotion must propagate
    // ResourceNotFound rather than returning Ok(partial).
    let pre_promo_replayed = call(
        fixture,
        human,
        0xec,
        "edit_ability",
        pre_promo_authored_edit,
    )
    .await
    .err()
    .expect("replaying pre-promotion authored edit after promotion must return ResourceNotFound");
    assert!(
        matches!(
            pre_promo_replayed,
            PortError::Domain(DomainError::ResourceNotFound)
        ),
        "{pre_promo_replayed:?}"
    );
    // Revoking the caller's PAT after package republication must propagate
    // AuthenticationFailed on the trailing preference step instead of Ok(partial).
    let revoked_author = fixture.pat(BearerScope::Write, true).await;
    let Some(notarium_core::auth::AuthenticatedCredential::Pat(pat_id)) =
        revoked_author.auth().credential().cloned()
    else {
        panic!("expected write PAT");
    };
    let latest_bind = call(
        fixture,
        human,
        0xed,
        "get_ability",
        json!({"ref":bind_blocked["ref"]}),
    )
    .await
    .unwrap()
    .structured_content;
    let (entered, release) = fixture.projections.pause_ability_publication();
    let edit_with_revocation = call(
        fixture,
        &revoked_author,
        0xee,
        "edit_ability",
        json!({
            "ref":latest_bind["ref"],
            "versionToken":latest_bind["versionToken"],
            "instructions":"Republished right before caller PAT revocation",
            "enabled":false,
        }),
    );
    let revoke_mid_edit = async {
        tokio::time::timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        fixture
            .control
            .revoke_pat(
                human.clone(),
                AccountMutation {
                    identity: runtime_ability_cases::identity(fixture, human, 0xef).await,
                    input: RevokePat {
                        account: human.auth().principal().clone(),
                        token: pat_id,
                    },
                },
            )
            .await
            .unwrap();
        release.send(()).unwrap();
    };
    let (revoked_res, ()) = tokio::join!(Box::pin(edit_with_revocation), Box::pin(revoke_mid_edit));
    let revoked_err = revoked_res
        .err()
        .expect("revoked trailing preference step must propagate error instead of Ok(partial)");
    assert!(
        matches!(
            revoked_err,
            PortError::Domain(DomainError::AuthenticationFailed) | PortError::Cancelled(_)
        ),
        "{revoked_err:?}"
    );
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
                    expected: AbilityOverlayGuard::Account(ControlRevision::ZERO),
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

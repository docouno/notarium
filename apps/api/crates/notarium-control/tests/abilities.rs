#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    DomainError,
    auth::*,
    classes::{AbilityKind, DocClass},
    error::{PortError, ValidationReason},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::{AccountCommandIdentity, ChangeCursor},
};
use std::sync::atomic::Ordering;
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
fn query(continuation: Option<String>, project: Option<FolderRef>, limit: u16) -> AbilityQuery {
    AbilityQuery {
        page: ControlPageRequest::new(limit, continuation).unwrap(),
        project,
        kind: None,
        name: None,
        authoring: false,
    }
}
fn by_name(project: Option<FolderRef>) -> AbilitySelection {
    AbilitySelection::Name {
        kind: AbilityKind::Role,
        name: "guide".into(),
        project,
    }
}
fn resolved(value: AbilityResolution) -> AbilityDescriptor {
    match value {
        AbilityResolution::Resolved(value) => *value,
        other => panic!("expected resolved, got {other:?}"),
    }
}
fn add(
    fixture: &Fixture,
    space: &Space,
    placement: AbilityPlacement,
    id: u8,
    name: &str,
    ancestors: Vec<FolderId>,
) -> AbilityRef {
    let reference = AbilityRef {
        id: AbilityId::from_bytes([id; 16]),
        placement,
        revision: RevisionId::from_bytes([id; 16]),
    };
    let note = NoteRef {
        space_id: space.id.clone(),
        note_id: NoteId::from_bytes([id; 16]),
    };
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            reference: reference.clone(),
            kind: AbilityKind::Role,
            name: name.into(),
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: note.clone(),
            auxiliary_files: vec![],
        });
    fixture.catalog.note_entries.lock().unwrap().insert(
        (space.id.clone(), note.note_id.clone()),
        CatalogNote {
            reference: note,
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: space.clone(),
                class: DocClass::Skill,
                ancestor_folders: ancestors,
                folder_write_locked: false,
                ability_package: Some(reference.id.clone()),
            },
        },
    );
    reference
}
async fn exercise(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "abilities").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("ability test password".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let ctx = AccountContext::new(
        service
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Session, token.expose().into())
                    .with_human_management(),
            })
            .await
            .unwrap(),
        budget(),
    );
    let space = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&bootstrap.account.personal_space.unwrap())
        .unwrap()
        .2
        .space
        .clone();
    let project = FolderRef {
        space_id: space.id.clone(),
        folder_id: FolderId::from_bytes([20; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (space.id.clone(), project.folder_id.clone()),
        ProjectInfo {
            folder: project.clone(),
            name: "Project".into(),
        },
    );
    let system = add(
        &fixture,
        &space,
        AbilityPlacement::System,
        1,
        "guide",
        vec![],
    );
    let personal = add(
        &fixture,
        &space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        2,
        "guide",
        vec![],
    );
    // Ambiguity below the effective winning level must not hide that winner.
    add(
        &fixture,
        &space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        7,
        "guide",
        vec![],
    );
    let scoped = add(
        &fixture,
        &space,
        AbilityPlacement::OwnedSpace(space.id.clone()),
        3,
        "guide",
        vec![],
    );
    let specific = add(
        &fixture,
        &space,
        AbilityPlacement::OwnedProject(project.clone()),
        4,
        "guide",
        vec![project.folder_id.clone()],
    );
    assert_eq!(
        resolved(
            service
                .resolve_ability(ctx.clone(), by_name(None))
                .await
                .unwrap()
        )
        .reference,
        scoped
    );
    assert_eq!(
        resolved(
            service
                .resolve_ability(ctx.clone(), by_name(Some(project.clone())))
                .await
                .unwrap()
        )
        .reference,
        specific
    );
    let first = service
        .discover_abilities(ctx.clone(), query(None, None, 1))
        .await
        .unwrap();
    assert!(first.items.is_empty());
    assert!(first.continuation.is_some());
    let stale = first.continuation.clone();
    let mut cursor = first.continuation;
    let mut found = vec![];
    while let Some(next) = cursor {
        let page = service
            .discover_abilities(ctx.clone(), query(Some(next), None, 1))
            .await
            .unwrap();
        found.extend(page.items.into_iter().map(|v| v.reference));
        cursor = page.continuation;
    }
    assert_eq!(found, vec![scoped.clone()]);
    let disabled = AccountMutation {
        identity: identity(&service, &ctx, 10).await,
        input: AbilityBindingUpdate {
            ability: scoped.clone(),
            enabled: false,
            expected: ControlRevision::ZERO,
            projects: AbilityProjects::All,
        },
    };
    let value = service
        .update_ability_binding(ctx.clone(), disabled.clone())
        .await
        .unwrap();
    assert!(!value.value.enabled);
    assert_eq!(
        service
            .update_ability_binding(ctx.clone(), disabled)
            .await
            .unwrap()
            .revision,
        value.revision
    );
    assert!(matches!(
        service
            .resolve_ability(ctx.clone(), by_name(None))
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert!(
        matches!(service.discover_abilities(ctx.clone(), query(stale, None, 1)).await, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::CursorStale)
    );
    let plain = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    assert!(matches!(
        service
            .update_ability_binding(
                plain.clone(),
                AccountMutation {
                    identity: identity(&service, &plain, 11).await,
                    input: AbilityBindingUpdate {
                        ability: scoped.clone(),
                        enabled: true,
                        expected: ControlRevision::new(1).unwrap(),
                        projects: AbilityProjects::All
                    }
                }
            )
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));
    service
        .update_ability_binding(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 12).await,
                input: AbilityBindingUpdate {
                    ability: scoped.clone(),
                    enabled: true,
                    expected: ControlRevision::new(1).unwrap(),
                    projects: AbilityProjects::Selected(vec![project.clone()]),
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .resolve_ability(ctx.clone(), by_name(None))
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert_eq!(
        resolved(
            service
                .resolve_ability(ctx.clone(), by_name(Some(project.clone())))
                .await
                .unwrap()
        )
        .reference,
        specific
    );
    let selected_episode = service
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 150).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::from_bytes([150; 16]),
                        name: None,
                    },
                    project_hint: Some(project.clone()),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let EpisodeStartResult::New(selected_episode) = selected_episode else {
        panic!("new episode expected")
    };
    let selected_episode = service
        .update_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 151).await,
                input: EpisodeUpdate {
                    episode: selected_episode.id,
                    expected: selected_episode.revision,
                    name: None,
                    active_role: Some(scoped.clone()),
                    project_hint: Some(project.clone()),
                    lifecycle: EpisodeLifecycle::Active,
                },
            },
        )
        .await
        .expect("a role enabled for the selected project must be usable by its episode")
        .value;
    assert_eq!(selected_episode.active_role, Some(scoped.clone()));
    let inventory = service
        .discover_abilities(
            ctx.clone(),
            AbilityQuery {
                authoring: true,
                ..query(None, None, 20)
            },
        )
        .await
        .unwrap();
    assert!(
        inventory
            .items
            .iter()
            .any(|v| v.reference == scoped && !v.enabled)
    );
    assert!(matches!(
        service
            .discover_abilities(
                plain.clone(),
                AbilityQuery {
                    authoring: true,
                    ..query(None, None, 20)
                }
            )
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));

    // A personal preference can only narrow availability, including System packages.
    service
        .set_ability_preference(
            plain.clone(),
            AccountMutation {
                identity: identity(&service, &plain, 13).await,
                input: AbilityPreferenceUpdate {
                    ability: system.clone(),
                    enabled: false,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .resolve_ability(plain.clone(), AbilitySelection::Exact(system.clone()))
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    service
        .set_ability_preference(
            plain.clone(),
            AccountMutation {
                identity: identity(&service, &plain, 14).await,
                input: AbilityPreferenceUpdate {
                    ability: system.clone(),
                    enabled: true,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(plain.clone(), AbilitySelection::Exact(system))
                .await
                .unwrap()
        )
        .reference
        .placement,
        AbilityPlacement::System
    );

    let destination = add(
        &fixture,
        &space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        5,
        "moved",
        vec![],
    );
    service
        .set_ability_trail(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 20).await,
                input: AbilityTrailUpdate {
                    source: personal.clone(),
                    expected_destination: None,
                    destination: Some(destination.clone()),
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(ctx.clone(), AbilitySelection::Exact(personal.clone()))
                .await
                .unwrap()
        )
        .reference,
        destination
    );
    assert!(
        service
            .set_ability_trail(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, 21).await,
                    input: AbilityTrailUpdate {
                        source: destination.clone(),
                        expected_destination: None,
                        destination: Some(personal.clone())
                    }
                }
            )
            .await
            .is_err()
    );
    service
        .set_ability_trail(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 22).await,
                input: AbilityTrailUpdate {
                    source: personal.clone(),
                    expected_destination: Some(destination),
                    destination: None,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(ctx.clone(), AbilitySelection::Exact(personal.clone()))
                .await
                .unwrap()
        )
        .reference,
        personal
    );
    let mut stale_ref = specific.clone();
    stale_ref.revision = RevisionId::from_bytes([99; 16]);
    assert!(matches!(
        service
            .resolve_ability(ctx.clone(), AbilitySelection::Exact(stale_ref))
            .await
            .unwrap(),
        AbilityResolution::Stale
    ));

    // Fixed memory targets are idempotent, scoped and checked before canonical creation.
    let target = MemoryTarget::User {
        owner: ctx.auth().principal().clone(),
    };
    let one = service
        .resolve_memory_target(ctx.clone(), target.clone(), "preferences".into())
        .await
        .unwrap();
    let two = service
        .resolve_memory_target(ctx.clone(), target.clone(), "preferences".into())
        .await
        .unwrap();
    assert_eq!(one.note, two.note);
    let project_memory = service
        .resolve_memory_target(
            ctx.clone(),
            MemoryTarget::Project {
                folder: project.clone(),
            },
            "decisions".into(),
        )
        .await
        .unwrap();
    assert_ne!(one.note, project_memory.note);
    let before = fixture.catalog.memory_calls.load(Ordering::SeqCst);
    assert!(
        service
            .resolve_memory_target(ctx.clone(), target, "../private".into())
            .await
            .is_err()
    );
    assert!(
        service
            .resolve_memory_target(
                ctx.clone(),
                MemoryTarget::User {
                    owner: PrincipalId::from_bytes([254; 16])
                },
                "preferences".into()
            )
            .await
            .is_err()
    );
    let mut grants = ctx.auth().spaces().clone();
    grants.get_mut(&space.id).unwrap().write_classes.clear();
    let narrowed = ctx
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([55; 16]),
            space.id.clone(),
            ChatAudience::Personal,
            grants,
        )
        .unwrap();
    assert!(
        service
            .resolve_memory_target(
                AccountContext::new(narrowed, budget()),
                MemoryTarget::Project {
                    folder: project.clone()
                },
                "decisions".into()
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.catalog.memory_calls.load(Ordering::SeqCst), before);

    fixture.catalog.folder_entries.lock().unwrap().insert(
        (space.id.clone(), project.folder_id.clone()),
        CatalogFolder {
            reference: project.clone(),
            space: space.clone(),
            lifecycle: Lifecycle::Active,
            ancestor_folders: vec![],
            write_locked: false,
        },
    );
    for (key, reference, rank) in [
        (30, FavoriteRef::Folder(project.clone()), 0),
        (31, FavoriteRef::Note(one.note.clone()), 1),
        (32, FavoriteRef::Note(project_memory.note.clone()), 2),
    ] {
        service
            .set_favorite(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, key).await,
                    input: SetFavorite {
                        reference,
                        saved: true,
                        rank,
                    },
                },
            )
            .await
            .unwrap();
    }
    let first = service
        .list_favorites(ctx.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(
        first.items[0].reference,
        FavoriteRef::Folder(project.clone())
    );
    let history = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&space.id)
        .unwrap()
        .2
        .history
        .clone();
    service
        .acknowledge_delta(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 34).await,
                input: AcknowledgeDelta {
                    owner: AckOwner::Account,
                    delivered: ChangeCursor {
                        scope: history,
                        after: SpaceSeq::ZERO,
                    },
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .list_favorites(
                ctx.clone(),
                ControlPageRequest::new(1, first.continuation.clone()).unwrap()
            )
            .await
            .expect("acknowledgements must not invalidate an unchanged preference page")
            .items[0]
            .reference,
        FavoriteRef::Note(one.note.clone())
    );
    fixture
        .catalog
        .note_entries
        .lock()
        .unwrap()
        .get_mut(&(one.note.space_id.clone(), one.note.note_id.clone()))
        .unwrap()
        .lifecycle = Lifecycle::Trashed;
    let skipped = service
        .list_favorites(
            ctx.clone(),
            ControlPageRequest::new(1, first.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert!(skipped.items.is_empty());
    assert!(skipped.continuation.is_some());
    let last = service
        .list_favorites(
            ctx.clone(),
            ControlPageRequest::new(1, skipped.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        last.items[0].reference,
        FavoriteRef::Note(project_memory.note.clone())
    );
    assert!(last.continuation.is_none());
    let mut grants = ctx.auth().spaces().clone();
    let grant = grants.get_mut(&space.id).unwrap();
    grant.project_root = Some(project.folder_id.clone());
    grant.read_classes = [DocClass::AgentMemory].into();
    let narrowed = ctx
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([56; 16]),
            space.id.clone(),
            ChatAudience::Personal,
            grants,
        )
        .unwrap();
    let favorites = service
        .list_favorites(
            AccountContext::new(narrowed, budget()),
            ControlPageRequest::new(20, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(favorites.items.len(), 2);
    assert_eq!(
        favorites.items[0].reference,
        FavoriteRef::Folder(project.clone())
    );
    let old_page = service
        .list_favorites(ctx.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    service
        .set_favorite(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 33).await,
                input: SetFavorite {
                    reference: FavoriteRef::Note(one.note),
                    saved: false,
                    rank: 0,
                },
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(service.list_favorites(ctx.clone(), ControlPageRequest::new(1, old_page.continuation).unwrap()).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::CursorStale)
    );

    // Unhealthy and wrong-kind winners never fall back to a broader package.
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .iter_mut()
        .find(|v| v.reference == specific)
        .unwrap()
        .healthy = false;
    assert!(matches!(
        service
            .resolve_ability(ctx.clone(), by_name(Some(project.clone())))
            .await
            .unwrap(),
        AbilityResolution::Unhealthy
    ));
    {
        let mut entries = fixture.catalog.ability_entries.lock().unwrap();
        let value = entries
            .iter_mut()
            .find(|v| v.reference == specific)
            .unwrap();
        value.healthy = true;
        value.kind = AbilityKind::Skill;
    }
    assert!(matches!(
        service
            .resolve_ability(ctx.clone(), by_name(Some(project.clone())))
            .await
            .unwrap(),
        AbilityResolution::WrongKind
    ));
    add(
        &fixture,
        &space,
        AbilityPlacement::OwnedProject(project.clone()),
        6,
        "guide",
        vec![project.folder_id.clone()],
    );
    assert!(
        matches!(service.resolve_ability(ctx.clone(), by_name(Some(project))).await, Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::InvalidState)
    );
    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_ability_resolution_and_memory() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_ability_resolution_and_memory() {
    exercise(true).await;
}

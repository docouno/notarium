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
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: reference.clone(),
            kind: AbilityKind::Role,
            name: name.into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: (reference.placement != AbilityPlacement::System).then(|| note.clone()),
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
                project: None,
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
                    .with_human_management()
                    .with_ability_write(),
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
            project_slug: "project".into(),
            folder: project.clone(),
            name: "Project".into(),
        },
    );
    let specific = Box::pin(resolution_and_preferences(
        &fixture, &service, &ctx, &space, &project, &token,
    ))
    .await;
    Box::pin(memory_targets_and_favorites(
        &fixture, &service, &ctx, &space, &project,
    ))
    .await;

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

async fn resolution_and_preferences(
    fixture: &Fixture,
    service: &ControlService,
    ctx: &AccountContext,
    space: &Space,
    project: &FolderRef,
    token: &SecretString,
) -> AbilityRef {
    let system = add(fixture, space, AbilityPlacement::System, 1, "guide", vec![]);
    let personal = add(
        fixture,
        space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        2,
        "guide",
        vec![],
    );
    // Ambiguity below the effective winning level must not hide that winner.
    add(
        fixture,
        space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        7,
        "guide",
        vec![],
    );
    let scoped = add(
        fixture,
        space,
        AbilityPlacement::OwnedSpace(space.id.clone()),
        3,
        "guide",
        vec![],
    );
    let specific = add(
        fixture,
        space,
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
        found.extend(page.items.into_iter().map(|v| v.descriptor.reference));
        cursor = page.continuation;
    }
    assert_eq!(found, vec![scoped.clone()]);
    let disabled = AccountMutation {
        identity: identity(service, ctx, 10).await,
        input: AbilityBindingUpdate {
            ability: scoped.clone(),
            enabled: false,
            expected: AbilityOverlayGuard::Account(ControlRevision::ZERO),
            projects: AbilityProjects::All,
        },
    };
    let value = service
        .update_ability_binding(ctx.clone(), disabled.clone())
        .await
        .unwrap();
    assert!(!value.value.descriptor.unwrap().enabled);
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
                    identity: identity(service, &plain, 11).await,
                    input: AbilityBindingUpdate {
                        ability: scoped.clone(),
                        enabled: true,
                        expected: AbilityOverlayGuard::Account(ControlRevision::new(1).unwrap()),
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
                identity: identity(service, ctx, 12).await,
                input: AbilityBindingUpdate {
                    ability: scoped.clone(),
                    enabled: true,
                    expected: AbilityOverlayGuard::Account(ControlRevision::new(1).unwrap()),
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
                identity: identity(service, ctx, 150).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::from_bytes([150; 16]),
                        name: None,
                    },
                    project_hint: Some(project.clone()),
                    guard: EpisodeRevisionGuard::Account,
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
                identity: identity(service, ctx, 151).await,
                input: EpisodeMutation::Full(EpisodeUpdate {
                    episode: selected_episode.id,
                    expected: selected_episode.revision,
                    name: None,
                    active_role: Some(scoped.clone()),
                    project_hint: Some(project.clone()),
                    lifecycle: EpisodeLifecycle::Active,
                }),
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
            .any(|v| v.descriptor.reference == scoped && !v.descriptor.enabled)
    );
    let read_inventory = service
        .discover_abilities(
            plain.clone(),
            AbilityQuery {
                authoring: true,
                ..query(None, None, 20)
            },
        )
        .await
        .unwrap();
    assert!(
        read_inventory
            .items
            .iter()
            .any(|value| value.descriptor.reference == scoped)
    );

    // A personal preference can only narrow availability, including System packages.
    service
        .set_ability_preference(
            plain.clone(),
            AccountMutation {
                identity: identity(service, &plain, 13).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: system.clone(),
                        enabled: false,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .resolve_ability(
                plain.clone(),
                AbilitySelection::Exact {
                    reference: system.clone(),
                    project: None,
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    service
        .set_ability_preference(
            plain.clone(),
            AccountMutation {
                identity: identity(service, &plain, 14).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: system.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(
                    plain.clone(),
                    AbilitySelection::Exact {
                        reference: system,
                        project: None,
                    },
                )
                .await
                .unwrap()
        )
        .reference
        .placement,
        AbilityPlacement::System
    );

    let destination = add(
        fixture,
        space,
        AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone()),
        5,
        "moved",
        vec![],
    );
    service
        .set_ability_trail(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 20).await,
                input: AbilityTrailMutation::Set(AbilityTrailUpdate {
                    source: personal.clone(),
                    expected_destination: None,
                    destination: Some(destination.clone()),
                }),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(
                    ctx.clone(),
                    AbilitySelection::Exact {
                        reference: personal.clone(),
                        project: None,
                    },
                )
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
                    identity: identity(service, ctx, 21).await,
                    input: AbilityTrailMutation::Set(AbilityTrailUpdate {
                        source: destination.clone(),
                        expected_destination: None,
                        destination: Some(personal.clone())
                    })
                }
            )
            .await
            .is_err()
    );
    service
        .set_ability_trail(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 22).await,
                input: AbilityTrailMutation::Set(AbilityTrailUpdate {
                    source: personal.clone(),
                    expected_destination: Some(destination),
                    destination: None,
                }),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        resolved(
            service
                .resolve_ability(
                    ctx.clone(),
                    AbilitySelection::Exact {
                        reference: personal.clone(),
                        project: None,
                    },
                )
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
            .resolve_ability(
                ctx.clone(),
                AbilitySelection::Exact {
                    reference: stale_ref,
                    project: None,
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Stale
    ));
    specific
}

async fn memory_targets_and_favorites(
    fixture: &Fixture,
    service: &ControlService,
    ctx: &AccountContext,
    space: &Space,
    project: &FolderRef,
) {
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
                    identity: identity(service, ctx, key).await,
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
                identity: identity(service, ctx, 34).await,
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
                identity: identity(service, ctx, 33).await,
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
}
#[tokio::test]
async fn sqlite_ability_resolution_and_memory() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_ability_resolution_and_memory() {
    exercise(true).await;
}

async fn bearer_authoring(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "ability_bearer").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("bearer fixture password".into())),
            },
        )
        .await
        .unwrap();
    let session = boot.session.unwrap();
    let human = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, session.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let owner = &boot.account.id;
    let space_id = boot.account.personal_space.unwrap();
    let space = fixture.catalog.entries.lock().unwrap()[&space_id]
        .2
        .space
        .clone();
    let package = add(
        &fixture,
        &space,
        AbilityPlacement::OwnedPersonal(owner.clone()),
        42,
        "workflow",
        vec![],
    );
    for (key, scope, opt_in) in [
        (51, BearerScope::Read, false),
        (52, BearerScope::Write, false),
        (53, BearerScope::Write, true),
    ] {
        let pat = service
            .create_pat(
                human.clone(),
                CreatePat {
                    name: format!("client-{key}"),
                    scope,
                    ability_write: opt_in,
                    selected_spaces: Some(vec![space_id.clone()]),
                    expires_at_ms: None,
                    expected: service
                        .whoami(human.clone())
                        .await
                        .unwrap()
                        .account_revision,
                },
            )
            .await
            .unwrap();
        assert_eq!(pat.value.metadata.ability_write, opt_in);
        let auth = service
            .resolve(evidence(AuthEvidenceKind::Pat, pat.value.token.expose()))
            .await
            .unwrap();
        assert_eq!(auth.bearer_scope(), Some(scope));
        assert!(!auth.human_management());
        assert_eq!(auth.has_cap(Cap::AbilityWrite), opt_in);
        let caller = AccountContext::new(auth, budget());
        let available = service
            .discover_abilities(
                caller.clone(),
                AbilityQuery {
                    authoring: true,
                    ..query(None, None, 20)
                },
            )
            .await
            .unwrap();
        assert!(
            available
                .items
                .iter()
                .any(|card| card.descriptor.reference == package)
        );
        let inspection = service
            .inspect_ability(caller.clone(), package.identity())
            .await
            .unwrap();
        assert_eq!(inspection.descriptor.reference, package);
        assert!(inspection.binding_enabled);
        let request = AccountMutation {
            identity: command(owner, owner, key, pat.revision),
            input: AbilityBindingUpdate {
                ability: package.clone(),
                enabled: false,
                expected: AbilityOverlayGuard::Account(inspection.binding_revision),
                projects: AbilityProjects::All,
            },
        };
        let result = service
            .update_ability_binding(caller.clone(), request.clone())
            .await;
        if opt_in {
            assert!(!result.unwrap().value.descriptor.unwrap().enabled);
            assert!(
                !service
                    .inspect_ability(caller.clone(), package.identity())
                    .await
                    .unwrap()
                    .binding_enabled
            );
            service
                .revoke_pat(
                    human.clone(),
                    AccountMutation {
                        identity: identity(&service, &human, 54).await,
                        input: RevokePat {
                            account: owner.clone(),
                            token: pat.value.metadata.id,
                        },
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                service.update_ability_binding(caller, request).await,
                Err(PortError::Domain(DomainError::AuthenticationFailed))
            ));
        } else {
            assert!(matches!(
                result,
                Err(PortError::Domain(DomainError::AbilityWriteForbidden))
            ));
        }
    }
    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_bearer_can_inspect_and_needs_opt_in_to_author() {
    bearer_authoring(false).await;
}

#[tokio::test]
async fn postgres_bearer_can_inspect_and_needs_opt_in_to_author() {
    bearer_authoring(true).await;
}

async fn selected_project_bindings_and_paged_bulk_discovery(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "abilities_selected_discovery").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let boot = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new(
                    "abilities discovery fixture password".into(),
                )),
            },
        )
        .await
        .unwrap();
    let token = boot.session.unwrap().token;
    let mut aw_ev = evidence(AuthEvidenceKind::Session, token.expose());
    aw_ev.evidence = aw_ev.evidence.with_ability_write();
    let ctx = AccountContext::new(service.resolve(aw_ev).await.unwrap(), budget());

    let shared = service
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 1).await,
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
    let mut aw_ev = evidence(AuthEvidenceKind::Session, token.expose());
    aw_ev.evidence = aw_ev.evidence.with_ability_write();
    let ctx = AccountContext::new(service.resolve(aw_ev).await.unwrap(), budget());

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
                project_slug: "project".into(),
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

    let selected_role = add(
        &fixture,
        &shared.space,
        AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        25,
        "selected-guide",
        vec![],
    );
    service
        .update_ability_binding(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 2).await,
                input: AbilityBindingUpdate {
                    ability: selected_role.clone(),
                    enabled: true,
                    expected: AbilityOverlayGuard::Account(ControlRevision::ZERO),
                    projects: AbilityProjects::Selected(vec![project_ok.clone()]),
                },
            },
        )
        .await
        .unwrap();

    // `AbilityProjects::Selected` enforces project matching on both `AbilitySelection::Exact` and `get_ability`.
    assert!(matches!(
        service
            .resolve_ability(
                ctx.clone(),
                AbilitySelection::Exact {
                    reference: selected_role.clone(),
                    project: None,
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert!(matches!(
        service
            .resolve_ability(
                ctx.clone(),
                AbilitySelection::Exact {
                    reference: selected_role.clone(),
                    project: Some(project_other),
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Disabled
    ));
    assert!(matches!(
        service
            .resolve_ability(
                ctx.clone(),
                AbilitySelection::Exact {
                    reference: selected_role.clone(),
                    project: Some(project_ok.clone()),
                },
            )
            .await
            .unwrap(),
        AbilityResolution::Resolved(_)
    ));
    assert!(matches!(
        service
            .get_ability(ctx.clone(), selected_role.clone(), None)
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(
        service
            .get_ability(ctx.clone(), selected_role, Some(project_ok.clone()))
            .await
            .unwrap()
            .enabled
    );

    // Seed 26 additional abilities (27 total) and verify bulk catalog batching across single-page,
    // multi-page, and kind-filtered runtime discovery.
    add(
        &fixture,
        &shared.space,
        AbilityPlacement::OwnedProject(project_ok.clone()),
        50,
        "role-project-ok",
        vec![project_ok.folder_id.clone()],
    );
    for idx in 0..25_u8 {
        add(
            &fixture,
            &shared.space,
            AbilityPlacement::System,
            60 + idx,
            &format!("sys-role-{idx:02}"),
            vec![],
        );
    }

    fixture.catalog.abilities_calls.store(0, Ordering::SeqCst);
    let single_page = service
        .discover_abilities(ctx.clone(), query(None, Some(project_ok.clone()), 50))
        .await
        .unwrap();
    assert_eq!(single_page.items.len(), 27);
    assert_eq!(
        fixture.catalog.abilities_calls.load(Ordering::SeqCst),
        1,
        "single-page runtime discover_abilities must issue 1 catalog.abilities call"
    );

    fixture.catalog.abilities_calls.store(0, Ordering::SeqCst);
    let page1 = service
        .discover_abilities(ctx.clone(), query(None, Some(project_ok.clone()), 20))
        .await
        .unwrap();
    assert_eq!(page1.items.len(), 20);
    assert!(page1.continuation.is_some());
    assert_eq!(fixture.catalog.abilities_calls.load(Ordering::SeqCst), 2);
    let page2 = service
        .discover_abilities(
            ctx.clone(),
            query(page1.continuation, Some(project_ok.clone()), 20),
        )
        .await
        .unwrap();
    assert_eq!(page2.items.len(), 7);
    assert!(page2.continuation.is_none());
    assert_eq!(fixture.catalog.abilities_calls.load(Ordering::SeqCst), 4);

    // Colliding unrelated Skill names never break `kind: Some(AbilityKind::Role)` discovery.
    for dup_id in [95_u8, 96_u8] {
        let reference = AbilityRef {
            id: AbilityId::from_bytes([dup_id; 16]),
            placement: AbilityPlacement::OwnedSpace(shared.space.id.clone()),
            revision: RevisionId::from_bytes([dup_id; 16]),
        };
        let note = NoteRef {
            space_id: shared.space.id.clone(),
            note_id: NoteId::from_bytes([dup_id; 16]),
        };
        fixture
            .catalog
            .ability_entries
            .lock()
            .unwrap()
            .push(AbilityDescriptor {
                attached_skills: vec![],
                promoted_from: None,
                requires_explicit_binding: false,
                reference: reference.clone(),
                kind: AbilityKind::Skill,
                name: "dup-skill".into(),
                description: None,
                enabled: true,
                healthy: true,
                lifecycle: Lifecycle::Active,
                entrypoint: Some(note.clone()),
                auxiliary_files: vec![],
            });
        fixture.catalog.note_entries.lock().unwrap().insert(
            (shared.space.id.clone(), note.note_id.clone()),
            CatalogNote {
                reference: note,
                lifecycle: Lifecycle::Active,
                facts: ResourceFacts {
                    space: shared.space.clone(),
                    class: DocClass::Skill,
                    project: None,
                    ancestor_folders: vec![],
                    folder_write_locked: false,
                    ability_package: Some(reference.id),
                },
            },
        );
    }
    fixture.catalog.abilities_calls.store(0, Ordering::SeqCst);
    let roles_only = service
        .discover_abilities(
            ctx,
            AbilityQuery {
                page: ControlPageRequest::new(50, None).unwrap(),
                project: Some(project_ok),
                kind: Some(AbilityKind::Role),
                name: None,
                authoring: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(roles_only.items.len(), 27);
    assert_eq!(fixture.catalog.abilities_calls.load(Ordering::SeqCst), 2);

    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_selected_project_bindings_and_paged_bulk_discovery() {
    selected_project_bindings_and_paged_bulk_discovery(false).await;
}
#[tokio::test]
async fn postgres_selected_project_bindings_and_paged_bulk_discovery() {
    selected_project_bindings_and_paged_bulk_discovery(true).await;
}

async fn concurrent_authored_preferences_and_promotion_merge_cas(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "abilities_concurrent_pref_merge").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("owner ability password".into())),
            },
        )
        .await
        .unwrap();
    let owner_token = bootstrap.session.unwrap().token;
    let mut owner_ev = evidence(AuthEvidenceKind::Session, owner_token.expose());
    owner_ev.evidence = owner_ev.evidence.with_ability_write();
    let owner_ctx = AccountContext::new(service.resolve(owner_ev).await.unwrap(), budget());
    let shared = service
        .create_space(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([71; 16]),
                    kind: SpaceKind::Shared,
                    name: "SharedAuth".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let mut owner_ev = evidence(AuthEvidenceKind::Session, owner_token.expose());
    owner_ev.evidence = owner_ev.evidence.with_ability_write();
    let owner_ctx = AccountContext::new(service.resolve(owner_ev).await.unwrap(), budget());

    let editor = service
        .create_account(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 2).await,
                input: NewAccount {
                    username: "editor".into(),
                    email: None,
                    display_name: "Editor".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    service
        .change_password(
            owner_ctx.clone(),
            ChangePassword {
                account: editor.id.clone(),
                current: None,
                replacement: SecretString::new("editor ability password".into()),
                expected: editor.revision,
            },
        )
        .await
        .unwrap();
    let scope_rev = service
        .context_scope(
            owner_ctx.clone(),
            ContextScope::Space(shared.space.id.clone()),
        )
        .await
        .unwrap()
        .revision;
    service
        .change_membership(
            SpaceContext::new(owner_ctx.auth().clone(), shared.history.clone(), budget()).unwrap(),
            MembershipChange {
                command: CommandKey::from_bytes([3; 16]),
                member: editor.id.clone(),
                role: Some(SpaceRole::Editor),
                expected: scope_rev,
            },
        )
        .await
        .unwrap();
    let editor_login = service
        .login(
            budget(),
            PasswordLogin {
                identifier: "editor".into(),
                password: SecretString::new("editor ability password".into()),
            },
        )
        .await
        .unwrap();
    let mut editor_ev = evidence(AuthEvidenceKind::Session, editor_login.token.expose());
    editor_ev.evidence = editor_ev.evidence.with_ability_write();
    let editor_ctx = AccountContext::new(service.resolve(editor_ev).await.unwrap(), budget());

    let shared_ability = add(
        &fixture,
        &shared.space,
        AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        72,
        "shared-guide",
        vec![],
    );

    // Concurrent authored preference updates by two members of the same Shared
    // Space must share a lock order and never deadlock on PostgreSQL.
    let mut owner_pref_rev: Option<ControlRevision> = None;
    let mut editor_pref_rev: Option<ControlRevision> = None;
    for round in 0..8_u8 {
        let enabled = round % 2 == 0;
        let owner_call = service.set_ability_preference(
            owner_ctx.clone(),
            AccountMutation {
                identity: command(
                    owner_ctx.auth().principal(),
                    owner_ctx.auth().principal(),
                    10 + round,
                    ControlRevision::ZERO,
                ),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: shared_ability.clone(),
                        enabled,
                    },
                    expected: AbilityPreferenceGuard::Authored(owner_pref_rev),
                },
            },
        );
        let editor_call = service.set_ability_preference(
            editor_ctx.clone(),
            AccountMutation {
                identity: command(
                    editor_ctx.auth().principal(),
                    editor_ctx.auth().principal(),
                    30 + round,
                    ControlRevision::ZERO,
                ),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: shared_ability.clone(),
                        enabled: !enabled,
                    },
                    expected: AbilityPreferenceGuard::Authored(editor_pref_rev),
                },
            },
        );
        let (owner_res, editor_res) = tokio::join!(owner_call, editor_call);
        owner_pref_rev = Some(owner_res.unwrap().revision);
        editor_pref_rev = Some(editor_res.unwrap().revision);
    }

    // Merging a source preference into an existing destination preference
    // during peer promotion must advance destination preference revision past
    // the owner's account revision, and subsequent preference writes by that
    // owner must remain strictly monotonic under concurrent CAS.
    let project = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([73; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project.space_id.clone(), project.folder_id.clone()),
        ProjectInfo {
            project_slug: "merge-proj".into(),
            folder: project.clone(),
            name: "Merge Project".into(),
        },
    );
    fixture.catalog.folder_entries.lock().unwrap().insert(
        (project.space_id.clone(), project.folder_id.clone()),
        CatalogFolder {
            reference: project.clone(),
            space: shared.space.clone(),
            lifecycle: Lifecycle::Active,
            ancestor_folders: vec![],
            write_locked: false,
        },
    );
    let promo_id = AbilityId::from_bytes([74; 16]);
    let src_ref = AbilityRef {
        id: promo_id.clone(),
        placement: AbilityPlacement::OwnedProject(project.clone()),
        revision: RevisionId::from_bytes([75; 16]),
    };
    let dst_ref = AbilityRef {
        id: promo_id.clone(),
        placement: AbilityPlacement::OwnedSpace(shared.space.id.clone()),
        revision: RevisionId::from_bytes([76; 16]),
    };
    let note_ref = NoteRef {
        space_id: shared.space.id.clone(),
        note_id: NoteId::from_bytes([74; 16]),
    };
    fixture.catalog.note_entries.lock().unwrap().insert(
        (shared.space.id.clone(), note_ref.note_id.clone()),
        CatalogNote {
            reference: note_ref.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: shared.space.clone(),
                class: DocClass::Skill,
                project: Some(project.folder_id.clone()),
                ancestor_folders: vec![project.folder_id.clone()],
                folder_write_locked: false,
                ability_package: Some(promo_id.clone()),
            },
        },
    );
    // Seed an existing destination preference (enabled = true, rev = dst_rev_before)
    // and a source preference (enabled = false, rev = src_rev < dst_rev_before).
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .push(AbilityDescriptor {
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: src_ref.clone(),
            kind: AbilityKind::Role,
            name: "merge-guide".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: Some(note_ref.clone()),
            auxiliary_files: vec![],
        });
    service
        .set_ability_preference(
            owner_ctx.clone(),
            AccountMutation {
                identity: command(
                    owner_ctx.auth().principal(),
                    owner_ctx.auth().principal(),
                    50,
                    ControlRevision::ZERO,
                ),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: src_ref.clone(),
                        enabled: false,
                    },
                    expected: AbilityPreferenceGuard::Authored(None),
                },
            },
        )
        .await
        .unwrap();
    // Seed a higher-revision pre-existing destination preference row before promotion.
    let dst_entry_idx = {
        let mut entries = fixture.catalog.ability_entries.lock().unwrap();
        entries.push(AbilityDescriptor {
            attached_skills: vec![],
            promoted_from: None,
            requires_explicit_binding: false,
            reference: dst_ref.clone(),
            kind: AbilityKind::Role,
            name: "merge-guide".into(),
            description: None,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: Some(note_ref.clone()),
            auxiliary_files: vec![],
        });
        entries.len() - 1
    };
    let dst_pref_commit = service
        .set_ability_preference(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 51).await,
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: dst_ref.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    let stale_dst_rev = dst_pref_commit.revision;
    // Publish promotion metadata and register source revision before destination tip.
    {
        let mut entries = fixture.catalog.ability_entries.lock().unwrap();
        entries[dst_entry_idx].promoted_from = Some(src_ref.clone());
        entries.insert(
            dst_entry_idx,
            AbilityDescriptor {
                attached_skills: vec![],
                promoted_from: None,
                requires_explicit_binding: false,
                reference: AbilityRef {
                    id: promo_id.clone(),
                    placement: dst_ref.placement.clone(),
                    revision: src_ref.revision.clone(),
                },
                kind: AbilityKind::Role,
                name: "merge-guide".into(),
                description: None,
                enabled: true,
                healthy: true,
                lifecycle: Lifecycle::Active,
                entrypoint: Some(note_ref),
                auxiliary_files: vec![],
            },
        );
    }
    // Promote via the peer editor so the owner's account revision stays behind
    // the merged destination preference revision.
    let _promoted = service
        .set_ability_trail(
            editor_ctx.clone(),
            AccountMutation {
                identity: command(
                    editor_ctx.auth().principal(),
                    editor_ctx.auth().principal(),
                    52,
                    ControlRevision::ZERO,
                ),
                input: AbilityTrailMutation::AdoptPromotion(AdoptAbilityPromotion {
                    source: src_ref.clone(),
                    destination: dst_ref.clone(),
                }),
            },
        )
        .await
        .unwrap()
        .value;
    let inspected_dst = service
        .inspect_ability(owner_ctx.clone(), dst_ref.identity())
        .await
        .unwrap();
    assert!(!inspected_dst.overlays.preference_enabled);
    let merged_rev = inspected_dst.overlays.preference_revision.unwrap();
    assert!(
        merged_rev > stale_dst_rev,
        "merged destination preference revision must strictly advance past {stale_dst_rev:?}: {merged_rev:?}",
    );
    let conflict = service
        .set_ability_preference(
            owner_ctx.clone(),
            AccountMutation {
                identity: command(
                    owner_ctx.auth().principal(),
                    owner_ctx.auth().principal(),
                    53,
                    ControlRevision::ZERO,
                ),
                input: AbilityPreferenceChange {
                    preference: AbilityPreferenceUpdate {
                        ability: dst_ref.clone(),
                        enabled: true,
                    },
                    expected: AbilityPreferenceGuard::Authored(Some(stale_dst_rev)),
                },
            },
        )
        .await;
    assert!(
        matches!(
            conflict,
            Err(PortError::Domain(DomainError::ControlRevisionConflict { current }))
                if current == merged_rev
        ),
        "{conflict:?}"
    );
    // Two concurrent CAS writes by the owner against `merged_rev`: exactly one
    // succeeds with a strictly higher revision and the second hits conflict.
    let cas_a = service.set_ability_preference(
        owner_ctx.clone(),
        AccountMutation {
            identity: command(
                owner_ctx.auth().principal(),
                owner_ctx.auth().principal(),
                55,
                ControlRevision::ZERO,
            ),
            input: AbilityPreferenceChange {
                preference: AbilityPreferenceUpdate {
                    ability: dst_ref.clone(),
                    enabled: true,
                },
                expected: AbilityPreferenceGuard::Authored(Some(merged_rev)),
            },
        },
    );
    let cas_b = service.set_ability_preference(
        owner_ctx.clone(),
        AccountMutation {
            identity: command(
                owner_ctx.auth().principal(),
                owner_ctx.auth().principal(),
                56,
                ControlRevision::ZERO,
            ),
            input: AbilityPreferenceChange {
                preference: AbilityPreferenceUpdate {
                    ability: dst_ref,
                    enabled: false,
                },
                expected: AbilityPreferenceGuard::Authored(Some(merged_rev)),
            },
        },
    );
    let (res_a, res_b) = tokio::join!(cas_a, cas_b);
    let (winner, loser) = match (res_a, res_b) {
        (Ok(ok), Err(err)) | (Err(err), Ok(ok)) => (ok, err),
        other => panic!("expected exactly one CAS winner and one conflict, got {other:?}"),
    };
    assert!(
        winner.revision > merged_rev,
        "owner write after peer promotion must strictly advance preference revision past {merged_rev:?}, got {:?}",
        winner.revision
    );
    assert!(
        matches!(
            loser,
            PortError::Domain(DomainError::ControlRevisionConflict { current })
                if current == winner.revision
        ),
        "{loser:?}"
    );
    let owner_account_rev = service
        .account(owner_ctx.clone(), owner_ctx.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    assert!(owner_account_rev >= winner.revision);

    // Exact replay of authored `update_ability_binding` succeeds even after a
    // selected project is removed from the catalog.
    let bind_req = AccountMutation {
        identity: command(
            owner_ctx.auth().principal(),
            owner_ctx.auth().principal(),
            54,
            ControlRevision::ZERO,
        ),
        input: AbilityBindingUpdate {
            ability: shared_ability.clone(),
            enabled: true,
            projects: AbilityProjects::Selected(vec![project.clone()]),
            expected: AbilityOverlayGuard::Authored(None),
        },
    };
    let bind_committed = service
        .update_ability_binding(owner_ctx.clone(), bind_req.clone())
        .await
        .unwrap();
    assert_eq!(bind_committed.value.reference, shared_ability);
    fixture
        .catalog
        .project_entries
        .lock()
        .unwrap()
        .remove(&(project.space_id.clone(), project.folder_id.clone()));
    let bind_replayed = service
        .update_ability_binding(owner_ctx.clone(), bind_req)
        .await
        .unwrap();
    assert_eq!(bind_replayed.revision, bind_committed.revision);
    assert_eq!(bind_replayed.value.reference, shared_ability);

    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_concurrent_authored_preferences_and_promotion_merge_cas() {
    Box::pin(concurrent_authored_preferences_and_promotion_merge_cas(
        false,
    ))
    .await;
}
#[tokio::test]
async fn postgres_concurrent_authored_preferences_and_promotion_merge_cas() {
    Box::pin(concurrent_authored_preferences_and_promotion_merge_cas(
        true,
    ))
    .await;
}

async fn account_preference_replay_enforces_live_placement_authority(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let fixture = Fixture::new(pg, "abilities_account_pref_replay").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("owner ability replay pass".into())),
            },
        )
        .await
        .unwrap();
    let owner_token = bootstrap.session.unwrap().token;
    async fn resolve_owner(service: &ControlService, token: &SecretString) -> AccountContext {
        let mut ev = evidence(AuthEvidenceKind::Session, token.expose());
        ev.evidence = ev.evidence.with_ability_write();
        AccountContext::new(service.resolve(ev).await.unwrap(), budget())
    }
    let owner_ctx = resolve_owner(&service, &owner_token).await;
    let s1 = service
        .create_space(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([81; 16]),
                    kind: SpaceKind::Shared,
                    name: "PrefReplayS1".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner_ctx = resolve_owner(&service, &owner_token).await;
    let s2 = service
        .create_space(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 2).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([82; 16]),
                    kind: SpaceKind::Shared,
                    name: "PrefReplayS2".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    let owner_ctx = resolve_owner(&service, &owner_token).await;

    let sys_ability = add(
        &fixture,
        &s1.space,
        AbilityPlacement::System,
        83,
        "sys-pref",
        vec![],
    );
    let s2_ability = add(
        &fixture,
        &s2.space,
        AbilityPlacement::OwnedSpace(s2.space.id.clone()),
        84,
        "s2-pref",
        vec![],
    );

    // Owner commits Account-guarded preferences on BOTH System and S2 abilities.
    let sys_req = AccountMutation {
        identity: identity(&service, &owner_ctx, 10).await,
        input: AbilityPreferenceChange {
            preference: AbilityPreferenceUpdate {
                ability: sys_ability.clone(),
                enabled: false,
            },
            expected: AbilityPreferenceGuard::Account,
        },
    };
    let sys_committed = service
        .set_ability_preference(owner_ctx.clone(), sys_req.clone())
        .await
        .unwrap();
    let s2_owner_req = AccountMutation {
        identity: identity(&service, &owner_ctx, 11).await,
        input: AbilityPreferenceChange {
            preference: AbilityPreferenceUpdate {
                ability: s2_ability.clone(),
                enabled: false,
            },
            expected: AbilityPreferenceGuard::Account,
        },
    };
    let _ = service
        .set_ability_preference(owner_ctx.clone(), s2_owner_req.clone())
        .await
        .unwrap();

    // Mint a PAT with AbilityWrite scoped ONLY to S1 (NOT S2, NOT human_management).
    let owner_rev = service
        .account(owner_ctx.clone(), owner_ctx.auth().principal().clone())
        .await
        .unwrap()
        .revision;
    let s1_pat = service
        .create_pat(
            owner_ctx.clone(),
            CreatePat {
                name: "s1-only-pat".into(),
                scope: BearerScope::Write,
                ability_write: true,
                selected_spaces: Some(vec![s1.space.id.clone()]),
                expires_at_ms: None,
                expected: owner_rev,
            },
        )
        .await
        .unwrap()
        .value;
    let s1_pat_ctx = AccountContext::new(
        service
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Pat, s1_pat.token.expose().into()),
            })
            .await
            .unwrap(),
        budget(),
    );

    // (1) S1-only PAT replaying the owner's committed System preference MUST fail
    //     AbilityWriteForbidden BEFORE command.replay.
    assert!(matches!(
        service
            .set_ability_preference(s1_pat_ctx.clone(), sys_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));
    // (2) S1-only PAT replaying the owner's committed S2 preference MUST fail
    //     AccessDenied BEFORE command.replay.
    assert!(matches!(
        service
            .set_ability_preference(s1_pat_ctx.clone(), s2_owner_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    // Positive control: Owner can still replay System preference.
    let sys_replayed = service
        .set_ability_preference(owner_ctx.clone(), sys_req.clone())
        .await
        .unwrap();
    assert_eq!(sys_replayed.revision, sys_committed.revision);
    // (2b) Narrowing a DirectHuman (`human_management == true`) by `project_root`
    //      or stripping `DocClass::Skill` from `read_classes` MUST deny Account
    //      preference replay before `command.replay`, including `AbilityPlacement::System`.
    let other_proj = FolderRef {
        space_id: s2.space.id.clone(),
        folder_id: FolderId::from_bytes([0xEE; 16]),
    };
    let owner_project_narrowed = AccountContext::new(
        owner_ctx.auth().restrict_to_project(&other_proj).unwrap(),
        budget(),
    );
    assert!(matches!(
        service
            .set_ability_preference(owner_project_narrowed.clone(), s2_owner_req.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(matches!(
        service
            .set_ability_preference(owner_project_narrowed, sys_req.clone())
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));
    let owner_no_skill = AccountContext::new(
        owner_ctx
            .auth()
            .restrict_read_classes(&s2.space.id, &[DocClass::UserDoc].into())
            .unwrap(),
        budget(),
    );
    assert!(matches!(
        service
            .set_ability_preference(owner_no_skill, s2_owner_req.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let owner_zero_spaces = AccountContext::new(
        owner_ctx
            .auth()
            .restrict_to_spaces(&std::collections::BTreeSet::new()),
        budget(),
    );
    assert!(matches!(
        service
            .set_ability_preference(owner_zero_spaces, sys_req)
            .await,
        Err(PortError::Domain(DomainError::AbilityWriteForbidden))
    ));

    // (3) A PAT with valid S2 write authority commits an S2 preference, then S2
    //     ability is trashed -> legitimate post-trash replay STILL succeeds.
    //     Then after an Editor is demoted to Viewer in S2, their S2 PAT replay MUST fail!
    let editor = service
        .create_account(
            owner_ctx.clone(),
            AccountMutation {
                identity: identity(&service, &owner_ctx, 12).await,
                input: NewAccount {
                    username: "pref-editor".into(),
                    email: None,
                    display_name: "Pref Editor".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    service
        .change_password(
            owner_ctx.clone(),
            ChangePassword {
                account: editor.id.clone(),
                current: None,
                replacement: SecretString::new("pref editor pass".into()),
                expected: editor.revision,
            },
        )
        .await
        .unwrap();
    for (idx, sp) in [(13u8, &s1), (14u8, &s2)] {
        let rev = service
            .context_scope(owner_ctx.clone(), ContextScope::Space(sp.space.id.clone()))
            .await
            .unwrap()
            .revision;
        service
            .change_membership(
                SpaceContext::new(owner_ctx.auth().clone(), sp.history.clone(), budget()).unwrap(),
                MembershipChange {
                    command: CommandKey::from_bytes([idx; 16]),
                    member: editor.id.clone(),
                    role: Some(SpaceRole::Editor),
                    expected: rev,
                },
            )
            .await
            .unwrap();
    }
    let ed_login = service
        .login(
            budget(),
            PasswordLogin {
                identifier: "pref-editor".into(),
                password: SecretString::new("pref editor pass".into()),
            },
        )
        .await
        .unwrap();
    let ed_session = AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, ed_login.token.expose()))
            .await
            .unwrap(),
        budget(),
    );
    let ed_rev = service
        .account(ed_session.clone(), editor.id.clone())
        .await
        .unwrap()
        .revision;
    let ed_pat = service
        .create_pat(
            ed_session.clone(),
            CreatePat {
                name: "ed-s1-s2-pat".into(),
                scope: BearerScope::Write,
                ability_write: true,
                selected_spaces: Some(vec![s1.space.id.clone(), s2.space.id.clone()]),
                expires_at_ms: None,
                expected: ed_rev,
            },
        )
        .await
        .unwrap()
        .value;
    let ed_pat_ctx = AccountContext::new(
        service
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Pat, ed_pat.token.expose().into()),
            })
            .await
            .unwrap(),
        budget(),
    );
    let ed_req = AccountMutation {
        identity: identity(&service, &ed_session, 15).await,
        input: AbilityPreferenceChange {
            preference: AbilityPreferenceUpdate {
                ability: s2_ability.clone(),
                enabled: false,
            },
            expected: AbilityPreferenceGuard::Account,
        },
    };
    let ed_committed = service
        .set_ability_preference(ed_pat_ctx.clone(), ed_req.clone())
        .await
        .unwrap();
    // Trash S2 ability from catalog: while still Editor, exact replay succeeds!
    fixture
        .catalog
        .ability_entries
        .lock()
        .unwrap()
        .retain(|entry| entry.reference != s2_ability);
    let ed_replayed = service
        .set_ability_preference(ed_pat_ctx.clone(), ed_req.clone())
        .await
        .unwrap();
    assert_eq!(ed_replayed.revision, ed_committed.revision);

    // Demote editor to Viewer in S2 (keeping Editor in S1 so PAT still has AbilityWrite!).
    let s2_rev = service
        .context_scope(owner_ctx.clone(), ContextScope::Space(s2.space.id.clone()))
        .await
        .unwrap()
        .revision;
    service
        .change_membership(
            SpaceContext::new(owner_ctx.auth().clone(), s2.history.clone(), budget()).unwrap(),
            MembershipChange {
                command: CommandKey::from_bytes([16; 16]),
                member: editor.id.clone(),
                role: Some(SpaceRole::Viewer),
                expected: s2_rev,
            },
        )
        .await
        .unwrap();
    // Replaying the S2 preference with the now-Viewer PAT MUST fail AccessDenied!
    assert!(matches!(
        service.set_ability_preference(ed_pat_ctx, ed_req).await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));

    drop(service);
    fixture.close().await;
}

#[tokio::test]
async fn sqlite_account_preference_replay_enforces_live_placement_authority() {
    Box::pin(account_preference_replay_enforces_live_placement_authority(
        false,
    ))
    .await;
}
#[tokio::test]
async fn postgres_account_preference_replay_enforces_live_placement_authority() {
    Box::pin(account_preference_replay_enforces_live_placement_authority(
        true,
    ))
    .await;
}

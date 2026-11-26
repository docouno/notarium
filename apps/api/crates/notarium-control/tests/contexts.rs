#[allow(dead_code)]
mod support;
use notarium_control::service::{AuthenticationMode, ControlService};
use notarium_core::{
    DomainError,
    auth::*,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::*,
    model::*,
    ports::{control::*, *},
    receipt::{AccountCommandIdentity, ChangeCursor},
};
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
async fn account(service: &ControlService, token: &str) -> AccountContext {
    AccountContext::new(
        service
            .resolve(evidence(AuthEvidenceKind::Session, token))
            .await
            .unwrap(),
        budget(),
    )
}
fn note(fixture: &Fixture, space: &Space, id: u8, project: Option<FolderId>) -> NoteRef {
    let reference = NoteRef {
        space_id: space.id.clone(),
        note_id: NoteId::from_bytes([id; 16]),
    };
    fixture.catalog.note_entries.lock().unwrap().insert(
        (space.id.clone(), reference.note_id.clone()),
        CatalogNote {
            reference: reference.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: space.clone(),
                class: DocClass::UserDoc,
                project: project.clone(),
                ancestor_folders: project.into_iter().collect(),
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );
    reference
}
async fn scope_revision(
    service: &ControlService,
    ctx: &AccountContext,
    scope: &ContextScope,
) -> ControlRevision {
    service
        .context_scope(ctx.clone(), scope.clone())
        .await
        .unwrap()
        .revision
}
async fn pin(
    service: &ControlService,
    ctx: &AccountContext,
    scope: ContextScope,
    note: NoteRef,
    key: u8,
) {
    service
        .set_context_pin(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, key).await,
                input: SetContextPin {
                    expected: scope_revision(service, ctx, &scope).await,
                    scope,
                    note,
                    pinned: true,
                },
            },
        )
        .await
        .unwrap();
}
async fn attach(
    service: &ControlService,
    ctx: &AccountContext,
    scope: ContextScope,
    set: &ContextSetInfo,
    key: u8,
) {
    service
        .set_context_attachment(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, key).await,
                input: SetContextAttachment {
                    expected: scope_revision(service, ctx, &scope).await,
                    scope,
                    set: set.id.clone(),
                    set_revision: set.revision,
                    attached: true,
                },
            },
        )
        .await
        .unwrap();
}
async fn episode(
    service: &ControlService,
    ctx: &AccountContext,
    project: Option<FolderRef>,
    key: u8,
) -> EpisodeId {
    let result = service
        .start_or_resume_episode(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, key).await,
                input: StartEpisode {
                    selector: EpisodeSelector::New {
                        requested: EpisodeId::from_bytes([key; 16]),
                        name: None,
                    },
                    project_hint: project,
                    guard: EpisodeRevisionGuard::Account,
                },
            },
        )
        .await
        .unwrap();
    match result.value {
        EpisodeStartResult::New(value) => value.id,
        other => panic!("{other:?}"),
    }
}
fn stale<T: std::fmt::Debug>(result: Result<T, PortError>) {
    assert!(
        matches!(result, Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic })) if diagnostic.reason == ValidationReason::CursorStale),
        "{result:?}"
    );
}
async fn collect(
    service: &ControlService,
    ctx: &AccountContext,
    episode: &EpisodeId,
) -> (Vec<NoteRef>, Vec<NoteRef>, u32) {
    let mut cursor = None;
    let mut pinned = vec![];
    let mut favorites = vec![];
    let mut unavailable = 0;
    for _ in 0..30 {
        let page = service
            .bootstrap_context(
                ctx.clone(),
                episode.clone(),
                None,
                ControlPageRequest::new(1, cursor).unwrap(),
            )
            .await
            .unwrap();
        assert!(page.selection.pinned.len() + page.selection.favorites.len() <= 1);
        pinned.extend(page.selection.pinned);
        favorites.extend(page.selection.favorites);
        unavailable += page.selection.unavailable;
        cursor = page.continuation;
        if cursor.is_none() {
            return (pinned, favorites, unavailable);
        }
    }
    panic!("continuation made no bounded progress")
}
async fn exercise(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut fixture = Fixture::new(pg, "contexts").await;
    let service = fixture.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: Some(SecretString::new("context test password".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let mut ctx = account(&service, token.expose()).await;
    let personal = fixture
        .catalog
        .entries
        .lock()
        .unwrap()
        .get(&bootstrap.account.personal_space.unwrap())
        .unwrap()
        .2
        .space
        .clone();
    let shared = service
        .create_space(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 1).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([20; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
    ctx = account(&service, token.expose()).await;
    let project = FolderRef {
        space_id: shared.space.id.clone(),
        folder_id: FolderId::from_bytes([21; 16]),
    };
    fixture.catalog.project_entries.lock().unwrap().insert(
        (project.space_id.clone(), project.folder_id.clone()),
        ProjectInfo {
            project_slug: "project".into(),
            folder: project.clone(),
            name: "Project".into(),
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
    let a = note(&fixture, &shared.space, 30, Some(project.folder_id.clone()));
    let b = note(&fixture, &shared.space, 31, Some(project.folder_id.clone()));
    let c = note(&fixture, &shared.space, 32, Some(project.folder_id.clone()));
    let d = note(&fixture, &shared.space, 33, Some(project.folder_id.clone()));
    let private = note(&fixture, &personal, 34, None);
    let scope = ContextScope::Space(shared.space.id.clone());
    Box::pin(exercise_owner_context(
        &mut fixture,
        &service,
        &ctx,
        &personal,
        &shared,
        &project,
        &scope,
        &a,
        &b,
        &c,
        &d,
        &private,
    ))
    .await;
    Box::pin(exercise_shared_consumer(
        &mut fixture,
        &service,
        &ctx,
        &shared,
        &scope,
        &a,
        &b,
        &c,
        &d,
    ))
    .await;
    drop(service);
    fixture.close().await;
}

#[allow(clippy::too_many_arguments)]
async fn exercise_owner_context(
    fixture: &mut Fixture,
    service: &std::sync::Arc<ControlService>,
    ctx: &AccountContext,
    personal: &Space,
    shared: &AccessibleSpace,
    project: &FolderRef,
    scope: &ContextScope,
    a: &NoteRef,
    b: &NoteRef,
    c: &NoteRef,
    d: &NoteRef,
    private: &NoteRef,
) {
    let creation = AccountMutation {
        identity: identity(service, ctx, 2).await,
        input: PutContextSet {
            id: ContextSetId::from_bytes([40; 16]),
            home: shared.space.id.clone(),
            name: "Bundle".into(),
            notes: vec![b.clone(), private.clone(), a.clone(), b.clone()],
            expected: None,
        },
    };
    let port: &dyn ContextAdminPort = service.as_ref();
    let mut set = port
        .put_context_set(ctx.clone(), creation.clone())
        .await
        .unwrap()
        .value;
    assert_eq!(
        port.put_context_set(ctx.clone(), creation)
            .await
            .unwrap()
            .value
            .id,
        set.id
    );
    attach(
        service,
        ctx,
        ContextScope::Space(shared.space.id.clone()),
        &set,
        3,
    )
    .await;
    pin(
        service,
        ctx,
        ContextScope::Project(project.clone()),
        a.clone(),
        4,
    )
    .await;
    pin(service, ctx, ContextScope::Personal, c.clone(), 5).await;
    for (key, reference) in [
        (6, FavoriteRef::Note(b.clone())),
        (7, FavoriteRef::Note(d.clone())),
        (8, FavoriteRef::Folder(project.clone())),
    ] {
        service
            .set_favorite(
                ctx.clone(),
                AccountMutation {
                    identity: identity(service, ctx, key).await,
                    input: SetFavorite {
                        reference,
                        saved: true,
                        rank: i64::from(key),
                    },
                },
            )
            .await
            .unwrap();
    }
    let id = episode(service, ctx, Some(project.clone()), 9).await;
    let first = service
        .bootstrap_context(
            ctx.clone(),
            id.clone(),
            None,
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.selection.pinned, vec![a.clone()]);
    assert_eq!(first.selection.space, Some(shared.space.id.clone()));
    service
        .acknowledge_delta(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 10).await,
                input: AcknowledgeDelta {
                    owner: AckOwner::Account,
                    delivered: ChangeCursor {
                        scope: shared.history.clone(),
                        after: SpaceSeq::ZERO,
                    },
                },
            },
        )
        .await
        .unwrap();
    let next = service
        .bootstrap_context(
            ctx.clone(),
            id.clone(),
            None,
            ControlPageRequest::new(1, first.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(next.selection.pinned, vec![b.clone()]);
    let (pinned, favorites, unavailable) = collect(service, ctx, &id).await;
    assert_eq!(
        pinned,
        vec![a.clone(), b.clone(), private.clone(), c.clone()]
    );
    assert_eq!(favorites, vec![d.clone()]);
    assert_eq!(unavailable, 0);
    // A shared run filters private references even inside a published bundle.
    let grants = [(
        shared.space.id.clone(),
        ctx.auth().spaces()[&shared.space.id].clone(),
    )]
    .into();
    let narrowed = ctx
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([50; 16]),
            shared.space.id.clone(),
            ChatAudience::Shared,
            grants,
        )
        .unwrap();
    let shared_ctx = AccountContext::new(narrowed, budget());
    let (pinned, favorites, unavailable) = collect(service, &shared_ctx, &id).await;
    assert_eq!(pinned, vec![a.clone(), b.clone()]);
    assert_eq!(favorites, vec![d.clone()]);
    assert_eq!(unavailable, 1);
    let projected = service
        .get_context_set(shared_ctx.clone(), set.id.clone())
        .await
        .unwrap();
    assert_eq!(projected.unavailable, 1);
    assert!(!projected.notes.contains(private));
    assert!(
        service
            .bootstrap_context(
                ctx.clone(),
                id.clone(),
                Some(personal.id.clone()),
                ControlPageRequest::new(5, None).unwrap()
            )
            .await
            .is_err()
    );
    let previous = service
        .bootstrap_context(
            ctx.clone(),
            id.clone(),
            None,
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    set = service
        .put_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 11).await,
                input: PutContextSet {
                    id: set.id.clone(),
                    home: set.home.clone(),
                    name: set.name.clone(),
                    notes: vec![c.clone(), b.clone()],
                    expected: Some(set.revision),
                },
            },
        )
        .await
        .unwrap()
        .value;
    stale(
        service
            .bootstrap_context(
                ctx.clone(),
                id.clone(),
                None,
                ControlPageRequest::new(1, previous.continuation).unwrap(),
            )
            .await,
    );
    pin(
        service,
        ctx,
        ContextScope::Space(shared.space.id.clone()),
        b.clone(),
        12,
    )
    .await;
    service
        .set_context_order(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 13).await,
                input: SetContextOrder {
                    expected: scope_revision(service, ctx, scope).await,
                    scope: scope.clone(),
                    entries: vec![
                        ContextRank {
                            entry: ContextEntry::Set(set.id.clone()),
                            rank: -20,
                        },
                        ContextRank {
                            entry: ContextEntry::Note(b.clone()),
                            rank: -30,
                        },
                    ],
                },
            },
        )
        .await
        .unwrap();
    let entries = service
        .list_context_entries(
            ctx.clone(),
            scope.clone(),
            ControlPageRequest::new(20, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(entries.items[0].entry, ContextEntry::Note(b.clone()));
    assert_eq!(entries.items[1].entry, ContextEntry::Set(set.id.clone()));
    assert_eq!(
        collect(service, ctx, &id).await.0,
        vec![a.clone(), b.clone(), c.clone()]
    );
    let deletion = AccountMutation {
        identity: identity(service, ctx, 14).await,
        input: DeleteContextSet {
            id: set.id.clone(),
            expected: set.revision,
        },
    };
    let deleted = service
        .delete_context_set(ctx.clone(), deletion.clone())
        .await
        .unwrap();
    assert_eq!(
        service
            .delete_context_set(ctx.clone(), deletion)
            .await
            .unwrap()
            .revision,
        deleted.revision
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM context_set_attachments")
            .await,
        0
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM context_order WHERE entry_kind='set'")
            .await,
        0
    );
    assert_eq!(
        collect(service, ctx, &id).await.0,
        vec![a.clone(), b.clone(), c.clone()]
    );
}

#[allow(clippy::too_many_arguments)]
async fn exercise_shared_consumer(
    fixture: &mut Fixture,
    service: &std::sync::Arc<ControlService>,
    ctx: &AccountContext,
    shared: &AccessibleSpace,
    scope: &ContextScope,
    a: &NoteRef,
    b: &NoteRef,
    c: &NoteRef,
    d: &NoteRef,
) {
    // A consumer's personal attachment cannot take editing authority from a
    // shared bundle author, and its cursor must observe that author's changes.
    let other = service
        .create_account(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 20).await,
                input: NewAccount {
                    username: "reader".into(),
                    email: None,
                    display_name: "Reader".into(),
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
                replacement: SecretString::new("reader context password".into()),
                expected: other.revision,
            },
        )
        .await
        .unwrap();
    service
        .change_membership(
            SpaceContext::new(ctx.auth().clone(), shared.history.clone(), budget()).unwrap(),
            MembershipChange {
                command: CommandKey::from_bytes([21; 16]),
                member: other.id.clone(),
                role: Some(SpaceRole::Editor),
                expected: scope_revision(service, ctx, scope).await,
            },
        )
        .await
        .unwrap();
    let login = service
        .login(
            budget(),
            PasswordLogin {
                identifier: "reader".into(),
                password: SecretString::new("reader context password".into()),
            },
        )
        .await
        .unwrap();
    let other_ctx = account(service, login.token.expose()).await;
    assert!(
        !ctx.auth()
            .spaces()
            .contains_key(&other.personal_space.clone().unwrap())
    );
    let mut set = service
        .put_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 22).await,
                input: PutContextSet {
                    id: ContextSetId::from_bytes([60; 16]),
                    home: shared.space.id.clone(),
                    name: "Shared references".into(),
                    notes: vec![a.clone(), b.clone()],
                    expected: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    attach(service, &other_ctx, ContextScope::Personal, &set, 23).await;
    let other_episode = episode(service, &other_ctx, None, 24).await;
    let old = service
        .bootstrap_context(
            other_ctx.clone(),
            other_episode.clone(),
            None,
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(old.selection.pinned, vec![a.clone()]);
    set = service
        .put_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 25).await,
                input: PutContextSet {
                    id: set.id.clone(),
                    home: set.home.clone(),
                    name: set.name.clone(),
                    notes: vec![c.clone(), a.clone()],
                    expected: Some(set.revision),
                },
            },
        )
        .await
        .unwrap()
        .value;
    stale(
        service
            .bootstrap_context(
                other_ctx.clone(),
                other_episode.clone(),
                None,
                ControlPageRequest::new(1, old.continuation).unwrap(),
            )
            .await,
    );
    assert_eq!(
        collect(service, &other_ctx, &other_episode).await.0,
        vec![c.clone(), a.clone()]
    );
    pin(service, &other_ctx, scope.clone(), b.clone(), 26).await;
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM context_scope_pins WHERE target_kind='space'")
            .await,
        1
    );
    let other_scope_before = scope_revision(service, &other_ctx, &ContextScope::Personal).await;
    service
        .delete_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 27).await,
                input: DeleteContextSet {
                    id: set.id,
                    expected: set.revision,
                },
            },
        )
        .await
        .unwrap();
    assert!(
        scope_revision(service, &other_ctx, &ContextScope::Personal).await >= other_scope_before
    );
    assert!(
        collect(service, &other_ctx, &other_episode)
            .await
            .0
            .is_empty()
    );
    // Current membership is checked even when an old context claimed Editor.
    service
        .change_membership(
            SpaceContext::new(ctx.auth().clone(), shared.history.clone(), budget()).unwrap(),
            MembershipChange {
                command: CommandKey::from_bytes([28; 16]),
                member: other.id.clone(),
                role: Some(SpaceRole::Viewer),
                expected: scope_revision(service, ctx, scope).await,
            },
        )
        .await
        .unwrap();
    assert!(
        service
            .set_context_pin(
                other_ctx.clone(),
                AccountMutation {
                    identity: identity(service, &other_ctx, 29).await,
                    input: SetContextPin {
                        scope: scope.clone(),
                        expected: scope_revision(service, ctx, scope).await,
                        note: d.clone(),
                        pinned: true
                    }
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM context_scope_pins WHERE target_kind='space'")
            .await,
        1
    );
    // Bounded bundle input fails before any mutation or implicit truncation.
    assert!(
        service
            .put_context_set(
                ctx.clone(),
                AccountMutation {
                    identity: identity(service, ctx, 30).await,
                    input: PutContextSet {
                        id: ContextSetId::from_bytes([61; 16]),
                        home: shared.space.id.clone(),
                        name: "oversized".into(),
                        notes: vec![a.clone(); 201],
                        expected: None
                    }
                }
            )
            .await
            .is_err()
    );
    // Foreign-home vs missing ContextSetId update attempts must both return
    // ResourceNotFound without exposing foreign revision or attachment state.
    let other_personal_id = other.personal_space.clone().unwrap();
    let other_personal_space = Space {
        id: other_personal_id.clone(),
        kind: SpaceKind::Personal,
        lifecycle: SpaceLifecycle::Active,
    };
    let other_personal_note = note(fixture, &other_personal_space, 79, None);
    let foreign_set = service
        .put_context_set(
            other_ctx.clone(),
            AccountMutation {
                identity: identity(service, &other_ctx, 31).await,
                input: PutContextSet {
                    id: ContextSetId::from_bytes([62; 16]),
                    home: other_personal_id,
                    name: "Foreign bundle".into(),
                    notes: vec![other_personal_note],
                    expected: None,
                },
            },
        )
        .await
        .unwrap()
        .value;
    for (tag, probe_id) in [
        (32u8, foreign_set.id.clone()),
        (33u8, ContextSetId::from_bytes([63; 16])),
    ] {
        let err = service
            .put_context_set(
                ctx.clone(),
                AccountMutation {
                    identity: identity(service, ctx, tag).await,
                    input: PutContextSet {
                        id: probe_id,
                        home: shared.space.id.clone(),
                        name: "Probe".into(),
                        notes: vec![a.clone()],
                        expected: Some(ControlRevision::new(1).unwrap()),
                    },
                },
            )
            .await;
        assert!(
            matches!(err, Err(PortError::Domain(DomainError::ResourceNotFound))),
            "put_context_set update probe must collapse to ResourceNotFound, got {err:?}"
        );
    }
    // Space-narrowed bootstrap_context must exclude favorites from excluded
    // Spaces before pagination so page offsets and counts do not leak them.
    let ctx_personal = service
        .account(ctx.clone(), ctx.auth().principal().clone())
        .await
        .unwrap()
        .personal_space
        .unwrap();
    let ctx_personal_space = Space {
        id: ctx_personal.clone(),
        kind: SpaceKind::Personal,
        lifecycle: SpaceLifecycle::Active,
    };
    let personal_fav_note = note(fixture, &ctx_personal_space, 78, None);
    service
        .set_favorite(
            ctx.clone(),
            AccountMutation {
                identity: identity(service, ctx, 34).await,
                input: SetFavorite {
                    reference: FavoriteRef::Note(personal_fav_note.clone()),
                    saved: true,
                    rank: 100,
                },
            },
        )
        .await
        .unwrap();
    let ep_narrow = episode(service, ctx, None, 35).await;
    let narrow_ctx = AccountContext::new(
        ctx.auth().restrict_to_space(&ctx_personal).unwrap(),
        budget(),
    );
    let page1 = service
        .bootstrap_context(
            narrow_ctx.clone(),
            ep_narrow.clone(),
            None,
            ControlPageRequest::new(1, None).unwrap(),
        )
        .await
        .unwrap();
    // Position 1 is the `ContextScope::Personal` pin `c` (which points into
    // excluded `shared`), so `page1` reports `unavailable == 1` and continues.
    assert_eq!(page1.selection.unavailable, 1);
    assert!(page1.selection.favorites.is_empty());
    let page2 = service
        .bootstrap_context(
            narrow_ctx,
            ep_narrow,
            None,
            ControlPageRequest::new(1, page1.continuation).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        page2.selection.favorites,
        vec![personal_fav_note],
        "excluded-Space favorites (ranks 6 & 7) must not consume page slots in narrowed bootstrap_context: {:?}",
        page2.selection
    );
    assert_eq!(page2.selection.unavailable, 0);
    assert!(
        page2.continuation.is_none(),
        "narrowed bootstrap_context must terminate after the sole allowed favorite"
    );

    // Idempotent replay of set_favorite, put_context_set, and set_context_pin must
    // still succeed after the referenced note becomes unavailable in the catalog.
    let replay_note = note(fixture, &ctx_personal_space, 77, None);
    let fav_mut = AccountMutation {
        identity: identity(service, ctx, 36).await,
        input: SetFavorite {
            reference: FavoriteRef::Note(replay_note.clone()),
            saved: true,
            rank: 101,
        },
    };
    service
        .set_favorite(ctx.clone(), fav_mut.clone())
        .await
        .unwrap();
    let set_mut = AccountMutation {
        identity: identity(service, ctx, 37).await,
        input: PutContextSet {
            id: ContextSetId::from_bytes([64; 16]),
            home: ctx_personal.clone(),
            name: "Replay bundle".into(),
            notes: vec![replay_note.clone()],
            expected: None,
        },
    };
    let set_1 = service
        .put_context_set(ctx.clone(), set_mut.clone())
        .await
        .unwrap()
        .value;
    let p_rev = scope_revision(service, ctx, &ContextScope::Personal).await;
    let pin_mut = AccountMutation {
        identity: identity(service, ctx, 38).await,
        input: SetContextPin {
            scope: ContextScope::Personal,
            expected: p_rev,
            note: replay_note.clone(),
            pinned: true,
        },
    };
    let pin_1 = service
        .set_context_pin(ctx.clone(), pin_mut.clone())
        .await
        .unwrap()
        .value;
    fixture
        .catalog
        .note_entries
        .lock()
        .unwrap()
        .remove(&(replay_note.space_id.clone(), replay_note.note_id.clone()));
    service
        .set_favorite(ctx.clone(), fav_mut)
        .await
        .expect("set_favorite replay must survive target note deletion");
    let set_2 = service
        .put_context_set(ctx.clone(), set_mut)
        .await
        .expect("put_context_set replay must survive target note deletion")
        .value;
    assert_eq!(set_2.id, set_1.id);
    let pin_2 = service
        .set_context_pin(ctx.clone(), pin_mut)
        .await
        .expect("set_context_pin replay must survive target note deletion")
        .value;
    assert_eq!(pin_2.revision, pin_1.revision);

    exercise_project_pinned_bootstrap(fixture, service, ctx, shared, scope).await;
    exercise_hidden_bundle_and_order_isolation(
        fixture,
        service,
        ctx,
        shared,
        scope,
        &ctx_personal,
        &ctx_personal_space,
        &other.id,
        login.token.expose(),
    )
    .await;
    exercise_narrowed_episode_isolation(service, ctx, shared).await;
}

#[inline(never)]
fn exercise_project_pinned_bootstrap<'a>(
    fixture: &'a mut Fixture,
    service: &'a std::sync::Arc<ControlService>,
    ctx: &'a AccountContext,
    shared: &'a AccessibleSpace,
    scope: &'a ContextScope,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
    Box::pin(async move {
        // Project-pinned bootstrap_context must not load Space-level or Personal-level
        // pins/sets or leak out-of-project favorites via `unavailable`, and must reject
        // an explicit `space` selection when the episode has no live `project_hint`.
        let proj_pin_a = FolderRef {
            space_id: shared.space.id.clone(),
            folder_id: FolderId::from_bytes([0x69; 16]),
        };
        let proj_pin_b = FolderRef {
            space_id: shared.space.id.clone(),
            folder_id: FolderId::from_bytes([0x6A; 16]),
        };
        fixture.catalog.project_entries.lock().unwrap().insert(
            (proj_pin_a.space_id.clone(), proj_pin_a.folder_id.clone()),
            ProjectInfo {
                folder: proj_pin_a.clone(),
                name: "Proj Pin A".into(),
                project_slug: "proj-pin-a".into(),
            },
        );
        fixture.catalog.project_entries.lock().unwrap().insert(
            (proj_pin_b.space_id.clone(), proj_pin_b.folder_id.clone()),
            ProjectInfo {
                folder: proj_pin_b.clone(),
                name: "Proj Pin B".into(),
                project_slug: "proj-pin-b".into(),
            },
        );
        let in_proj_note = note(
            fixture,
            &shared.space,
            81,
            Some(proj_pin_a.folder_id.clone()),
        );
        let out_proj_note = note(
            fixture,
            &shared.space,
            82,
            Some(proj_pin_b.folder_id.clone()),
        );
        pin(service, ctx, scope.clone(), in_proj_note.clone(), 41).await;
        pin(service, ctx, scope.clone(), out_proj_note.clone(), 42).await;
        let in_proj_fav = note(
            fixture,
            &shared.space,
            83,
            Some(proj_pin_a.folder_id.clone()),
        );
        let out_proj_fav_1 = note(
            fixture,
            &shared.space,
            84,
            Some(proj_pin_b.folder_id.clone()),
        );
        let out_proj_fav_2 = note(
            fixture,
            &shared.space,
            85,
            Some(proj_pin_b.folder_id.clone()),
        );
        for (idx, (fav_note, rank)) in [
            (out_proj_fav_1, 150i64),
            (out_proj_fav_2, 160i64),
            (out_proj_note.clone(), 200i64),
            (in_proj_fav.clone(), 210i64),
        ]
        .into_iter()
        .enumerate()
        {
            service
                .set_favorite(
                    ctx.clone(),
                    AccountMutation {
                        identity: identity(service, ctx, 43 + idx as u8).await,
                        input: SetFavorite {
                            reference: FavoriteRef::Note(fav_note),
                            saved: true,
                            rank,
                        },
                    },
                )
                .await
                .unwrap();
        }
        let proj_ep = episode(service, ctx, Some(proj_pin_a.clone()), 48).await;
        let pinned_ctx = AccountContext::new(
            ctx.auth().restrict_to_project(&proj_pin_a).unwrap(),
            budget(),
        );
        // Page size 1 must skip out-of-project favorites without emitting empty pages or
        // leaking their count via continuation/unavailable.
        let pinned_boot = service
            .bootstrap_context(
                pinned_ctx.clone(),
                proj_ep.clone(),
                Some(shared.space.id.clone()),
                ControlPageRequest::new(1, None).unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !pinned_boot.selection.pinned.contains(&in_proj_note)
                && !pinned_boot.selection.pinned.contains(&out_proj_note),
            "project-pinned bootstrap_context must not surface Space/Personal pins: {:?}",
            pinned_boot.selection
        );
        assert_eq!(
            pinned_boot.selection.favorites,
            vec![in_proj_fav],
            "project-pinned bootstrap_context(limit=1) must return the in-project favorite directly without empty pages"
        );
        assert_eq!(
            pinned_boot.selection.unavailable, 0,
            "project-pinned bootstrap_context must not leak out-of-project Space pins or favorites via unavailable: {:?}",
            pinned_boot.selection
        );
        assert!(
            pinned_boot.continuation.is_none(),
            "project-pinned bootstrap_context must not emit continuation for trailing out-of-project favorites"
        );

        // Remove proj_pin_a from catalog so episode hits ProjectUnavailable, then verify
        // passing explicit `space: Some(shared)` fails ResourceNotFound for project-pinned caller.
        fixture
            .catalog
            .project_entries
            .lock()
            .unwrap()
            .remove(&(proj_pin_a.space_id.clone(), proj_pin_a.folder_id.clone()));
        let unavail_space_err = service
            .bootstrap_context(
                pinned_ctx,
                proj_ep,
                Some(shared.space.id.clone()),
                ControlPageRequest::new(10, None).unwrap(),
            )
            .await;
        assert!(
            matches!(
                unavail_space_err,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "project-pinned bootstrap_context with explicit space when project is unavailable must fail ResourceNotFound, got {unavail_space_err:?}"
        );
    })
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn exercise_hidden_bundle_and_order_isolation<'a>(
    fixture: &'a mut Fixture,
    service: &'a std::sync::Arc<ControlService>,
    ctx: &'a AccountContext,
    shared: &'a AccessibleSpace,
    scope: &'a ContextScope,
    ctx_personal: &'a SpaceId,
    ctx_personal_space: &'a Space,
    other_id: &'a PrincipalId,
    other_session_token: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
    Box::pin(async move {
        // Owner attaches a Personal-home ContextSet (containing a shared note + a private note)
        // and pins a private Personal note onto Shared Space `shared`. Another member (`other`)
        // must not see those notes or private unavailable counts in `bootstrap_context`, and
        // must receive `ResourceNotFound` from `set_context_order` on hidden pins/sets.
        let priv_note_in_bundle = note(fixture, ctx_personal_space, 86, None);
        let leaked_shared_note = note(fixture, &shared.space, 87, None);
        let personal_bundle = service
            .put_context_set(
                ctx.clone(),
                AccountMutation {
                    identity: identity(service, ctx, 49).await,
                    input: PutContextSet {
                        id: ContextSetId::from_bytes([65; 16]),
                        home: ctx_personal.clone(),
                        name: "Owner private bundle".into(),
                        notes: vec![leaked_shared_note.clone(), priv_note_in_bundle.clone()],
                        expected: None,
                    },
                },
            )
            .await
            .unwrap()
            .value;
        attach(service, ctx, scope.clone(), &personal_bundle, 50).await;
        pin(service, ctx, scope.clone(), priv_note_in_bundle.clone(), 51).await;
        service
            .change_membership(
                SpaceContext::new(ctx.auth().clone(), shared.history.clone(), budget()).unwrap(),
                MembershipChange {
                    command: CommandKey::from_bytes([52; 16]),
                    member: other_id.clone(),
                    role: Some(SpaceRole::Editor),
                    expected: scope_revision(service, ctx, scope).await,
                },
            )
            .await
            .unwrap();
        let other_editor = AccountContext::new(
            service
                .resolve(evidence(AuthEvidenceKind::Session, other_session_token))
                .await
                .unwrap(),
            budget(),
        );
        let other_ep2 = episode(service, &other_editor, None, 53).await;
        let other_boot = service
            .bootstrap_context(
                other_editor.clone(),
                other_ep2,
                Some(shared.space.id.clone()),
                ControlPageRequest::new(50, None).unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !other_boot.selection.pinned.contains(&leaked_shared_note),
            "bootstrap_context must not expand unauthorized Personal ContextSet attached to Shared Space: {:?}",
            other_boot.selection
        );
        let other_entries = service
            .list_context_entries(
                other_editor.clone(),
                scope.clone(),
                ControlPageRequest::new(50, None).unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !other_entries
                .items
                .iter()
                .any(|item| item.entry == ContextEntry::Set(personal_bundle.id.clone())),
            "list_context_entries must hide unauthorized Personal ContextSet attached to Shared Space: {:?}",
            other_entries.items
        );
        let scope_rev_now = scope_revision(service, &other_editor, scope).await;
        let order_hidden_set = service
            .set_context_order(
                other_editor.clone(),
                AccountMutation {
                    identity: identity(service, &other_editor, 54).await,
                    input: SetContextOrder {
                        scope: scope.clone(),
                        expected: scope_rev_now,
                        entries: vec![ContextRank {
                            entry: ContextEntry::Set(personal_bundle.id.clone()),
                            rank: 5,
                        }],
                    },
                },
            )
            .await;
        assert!(
            matches!(
                order_hidden_set,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "set_context_order on hidden Personal ContextSet must fail ResourceNotFound, got {order_hidden_set:?}"
        );
        let order_hidden_pin = service
            .set_context_order(
                other_editor.clone(),
                AccountMutation {
                    identity: identity(service, &other_editor, 55).await,
                    input: SetContextOrder {
                        scope: scope.clone(),
                        expected: scope_rev_now,
                        entries: vec![ContextRank {
                            entry: ContextEntry::Note(priv_note_in_bundle),
                            rank: 6,
                        }],
                    },
                },
            )
            .await;
        assert!(
            matches!(
                order_hidden_pin,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "set_context_order on hidden Personal pinned note must fail ResourceNotFound, got {order_hidden_pin:?}"
        );
    })
}

#[inline(never)]
fn exercise_narrowed_episode_isolation<'a>(
    service: &'a std::sync::Arc<ControlService>,
    ctx: &'a AccountContext,
    shared: &'a AccessibleSpace,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>> {
    Box::pin(async move {
        // Single-Space Shared PAT (excluding Personal Space) must NOT see or mutate
        // projectless Personal episodes, and replaying update_episode under a narrowed
        // scope must return ResourceNotFound rather than CommitEffect::Unknown.
        let personal_ep = episode(service, ctx, None, 56).await;
        let personal_ep_info = service
            .get_episode(ctx.clone(), personal_ep.clone())
            .await
            .unwrap();
        let shared_only_pat = service
            .create_pat(
                ctx.clone(),
                CreatePat {
                    name: "shared-only-ep-check".into(),
                    scope: BearerScope::Write,
                    ability_write: false,
                    selected_spaces: Some(vec![shared.space.id.clone()]),
                    expires_at_ms: None,
                    expected: service
                        .account(ctx.clone(), ctx.auth().principal().clone())
                        .await
                        .unwrap()
                        .revision,
                },
            )
            .await
            .unwrap()
            .value;
        let shared_pat_ctx = AccountContext::new(
            service
                .resolve(evidence(
                    AuthEvidenceKind::Pat,
                    shared_only_pat.token.expose(),
                ))
                .await
                .unwrap(),
            budget(),
        );
        assert!(matches!(
            service
                .get_episode(shared_pat_ctx.clone(), personal_ep.clone())
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        assert!(matches!(
            service
                .bootstrap_context(
                    shared_pat_ctx.clone(),
                    personal_ep.clone(),
                    None,
                    ControlPageRequest::new(10, None).unwrap(),
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        assert!(matches!(
            service
                .touch_episode(shared_pat_ctx.clone(), personal_ep.clone())
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        let update_mut = AccountMutation {
            identity: identity(service, ctx, 57).await,
            input: EpisodeMutation::Full(EpisodeUpdate {
                episode: personal_ep.clone(),
                expected: personal_ep_info.revision,
                name: Some("personal-private-name".into()),
                active_role: None,
                project_hint: None,
                lifecycle: EpisodeLifecycle::Active,
            }),
        };
        service
            .update_episode(ctx.clone(), update_mut.clone())
            .await
            .unwrap();
        let replay_narrow_err = service.update_episode(shared_pat_ctx, update_mut).await;
        assert!(
            matches!(
                replay_narrow_err,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "narrowed update_episode replay on hidden Personal episode must fail ResourceNotFound (never Unknown), got {replay_narrow_err:?}"
        );
    })
}
#[tokio::test]
async fn sqlite_context_references_and_pagination() {
    Box::pin(exercise(false)).await;
}
#[tokio::test]
async fn postgres_context_references_and_pagination() {
    Box::pin(exercise(true)).await;
}

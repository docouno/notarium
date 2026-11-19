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
    let creation = AccountMutation {
        identity: identity(&service, &ctx, 2).await,
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
        &service,
        &ctx,
        ContextScope::Space(shared.space.id.clone()),
        &set,
        3,
    )
    .await;
    pin(
        &service,
        &ctx,
        ContextScope::Project(project.clone()),
        a.clone(),
        4,
    )
    .await;
    pin(&service, &ctx, ContextScope::Personal, c.clone(), 5).await;
    for (key, reference) in [
        (6, FavoriteRef::Note(b.clone())),
        (7, FavoriteRef::Note(d.clone())),
        (8, FavoriteRef::Folder(project.clone())),
    ] {
        service
            .set_favorite(
                ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &ctx, key).await,
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
    let id = episode(&service, &ctx, Some(project.clone()), 9).await;
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
                identity: identity(&service, &ctx, 10).await,
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
    let (pinned, favorites, unavailable) = collect(&service, &ctx, &id).await;
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
    let (pinned, favorites, unavailable) = collect(&service, &shared_ctx, &id).await;
    assert_eq!(pinned, vec![a.clone(), b.clone()]);
    assert_eq!(favorites, vec![d.clone()]);
    assert_eq!(unavailable, 1);
    let projected = service
        .get_context_set(shared_ctx.clone(), set.id.clone())
        .await
        .unwrap();
    assert_eq!(projected.unavailable, 1);
    assert!(!projected.notes.contains(&private));
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
                identity: identity(&service, &ctx, 11).await,
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
        &service,
        &ctx,
        ContextScope::Space(shared.space.id.clone()),
        b.clone(),
        12,
    )
    .await;
    let scope = ContextScope::Space(shared.space.id.clone());
    service
        .set_context_order(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 13).await,
                input: SetContextOrder {
                    expected: scope_revision(&service, &ctx, &scope).await,
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
        collect(&service, &ctx, &id).await.0,
        vec![a.clone(), b.clone(), c.clone()]
    );
    let deletion = AccountMutation {
        identity: identity(&service, &ctx, 14).await,
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
        collect(&service, &ctx, &id).await.0,
        vec![a.clone(), b.clone(), c.clone()]
    );

    // A consumer's personal attachment cannot take editing authority from a
    // shared bundle author, and its cursor must observe that author's changes.
    let other = service
        .create_account(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 20).await,
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
                expected: scope_revision(&service, &ctx, &scope).await,
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
    let other_ctx = account(&service, login.token.expose()).await;
    assert!(
        !ctx.auth()
            .spaces()
            .contains_key(&other.personal_space.clone().unwrap())
    );
    let mut set = service
        .put_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 22).await,
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
    attach(&service, &other_ctx, ContextScope::Personal, &set, 23).await;
    let other_episode = episode(&service, &other_ctx, None, 24).await;
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
                identity: identity(&service, &ctx, 25).await,
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
        collect(&service, &other_ctx, &other_episode).await.0,
        vec![c.clone(), a.clone()]
    );
    pin(&service, &other_ctx, scope.clone(), b.clone(), 26).await;
    assert_eq!(
        fixture
            .observer
            .count("SELECT count(*) FROM context_scope_pins WHERE target_kind='space'")
            .await,
        1
    );
    let other_scope_before = scope_revision(&service, &other_ctx, &ContextScope::Personal).await;
    service
        .delete_context_set(
            ctx.clone(),
            AccountMutation {
                identity: identity(&service, &ctx, 27).await,
                input: DeleteContextSet {
                    id: set.id,
                    expected: set.revision,
                },
            },
        )
        .await
        .unwrap();
    assert!(
        scope_revision(&service, &other_ctx, &ContextScope::Personal).await >= other_scope_before
    );
    assert!(
        collect(&service, &other_ctx, &other_episode)
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
                member: other.id,
                role: Some(SpaceRole::Viewer),
                expected: scope_revision(&service, &ctx, &scope).await,
            },
        )
        .await
        .unwrap();
    assert!(
        service
            .set_context_pin(
                other_ctx.clone(),
                AccountMutation {
                    identity: identity(&service, &other_ctx, 29).await,
                    input: SetContextPin {
                        scope: scope.clone(),
                        expected: scope_revision(&service, &ctx, &scope).await,
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
                    identity: identity(&service, &ctx, 30).await,
                    input: PutContextSet {
                        id: ContextSetId::from_bytes([61; 16]),
                        home: shared.space.id,
                        name: "oversized".into(),
                        notes: vec![a; 201],
                        expected: None
                    }
                }
            )
            .await
            .is_err()
    );
    drop(service);
    fixture.close().await;
}
#[tokio::test]
async fn sqlite_context_references_and_pagination() {
    exercise(false).await;
}
#[tokio::test]
async fn postgres_context_references_and_pagination() {
    exercise(true).await;
}

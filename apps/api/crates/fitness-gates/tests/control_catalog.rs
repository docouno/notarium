//! Exercise the account service with the canonical catalog across the two databases.
#[allow(dead_code)]
#[path = "../../notarium-control/tests/support/mod.rs"]
mod support;
use notarium_agents::abilities::{SystemAbilityCatalog, read_system_ability};
use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, PgConnectConfig,
    PgTransport, SqlBackendConfig,
};
use notarium_control::service::{AuthenticationMode, ControlConfig, ControlService};
use notarium_core::{
    DomainError,
    auth::*,
    classes::{AbilityKind, DocClass, ProviderCurrentContent, ProviderOrigin},
    epoch::DataRoot,
    error::PortError,
    ids::*,
    ports::*,
    receipt::CommandIdentity,
};
use std::{path::PathBuf, sync::Arc};
use support::{Fixture, budget};

async fn service(f: &Fixture, canonical: &CanonicalStore, owner: &PrincipalId) -> ControlService {
    ControlService::open(
        f.store.clone(),
        Arc::new(canonical.clone()),
        f.revoker.clone(),
        f.clock.clone(),
        ControlConfig {
            authentication: AuthenticationMode::TrustedNone {
                owner: owner.clone(),
            },
            resource_uri: "https://resource.example/".into(),
            max_auth_spaces: 100,
            schedule_limits: control::RunLimits::HARD_CEILING,
        },
        budget(),
    )
    .await
    .unwrap()
}
async fn context(control: &ControlService) -> AccountContext {
    AccountContext::new(
        control
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
fn mutation<T>(ctx: &SpaceContext, k: u8, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes([k; 16]),
            hash: ContentDigest::from_bytes([k; 32]),
        },
        preconditions: Default::default(),
        input,
    }
}

async fn exercise(pg: bool) {
    let mut fixture = Fixture::new(pg, "canonical_catalog").await;
    let path = fixture.root.clone().unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap())
            .join("control-tests/pg-catalog-blobs")
    });
    let root = DataRoot::new(&path);
    let mut cfg = CanonicalConfig::local_default(InstallationId::from_bytes([1; 16]), root);
    if pg {
        let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../.artifacts/control-db-fixture/active.json");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(descriptor).unwrap()).unwrap();
        cfg.sql = SqlBackendConfig::postgres_default(
            PgConnectConfig {
                transport: PgTransport::UnixSocket {
                    socket_dir: PathBuf::from(json["socket"].as_str().unwrap()),
                    port: 5432,
                },
                username: "postgres".into(),
                password: String::new(),
                database: "auth_canonical_catalog".into(),
            },
            "v1_canonical",
        );
        cfg.default_backup_budget = notarium_canonical::config::default_postgres_backup_budget();
    }
    let (canonical, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
    let owner = PrincipalId::from_bytes([4; 16]);
    let control = service(&fixture, &canonical, &owner).await;
    if pg {
        fixture.observer.execute("CREATE FUNCTION fail_account_ack() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected lost acknowledgement'; END; $$ LANGUAGE plpgsql").await;
        fixture.observer.execute("CREATE TRIGGER fail_account_commit BEFORE UPDATE ON control_operations FOR EACH ROW WHEN (NEW.state='committed') EXECUTE FUNCTION fail_account_ack()").await;
    } else {
        fixture.observer.execute("CREATE TRIGGER fail_account_commit BEFORE UPDATE ON control_operations WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'injected lost acknowledgement'); END").await;
    }
    let failure = control
        .bootstrap(
            support::empty(),
            budget(),
            BootstrapAccount {
                username: "owner".into(),
                email: None,
                display_name: "Owner".into(),
                password: None,
            },
        )
        .await;
    assert!(failure.is_err());
    let sid = SpaceId::parse(
        &fixture
            .observer
            .text("SELECT personal_space_id FROM users")
            .await,
    )
    .unwrap();
    let first = canonical.read_space(&sid).await.unwrap();
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM control_operations WHERE state='pending'")
            .await,
        1
    );
    drop(control);
    fixture
        .observer
        .execute(if pg {
            "DROP TRIGGER fail_account_commit ON control_operations"
        } else {
            "DROP TRIGGER fail_account_commit"
        })
        .await;
    let control = service(&fixture, &canonical, &owner).await;
    assert_eq!(canonical.read_space(&sid).await.unwrap(), first);
    assert_eq!(
        fixture
            .observer
            .count("SELECT COUNT(*) FROM control_operations WHERE state='committed'")
            .await,
        1
    );
    let account = context(&control).await;
    let target = MemoryTarget::User {
        owner: owner.clone(),
    };
    let absent = control
        .inspect_memory_target(account.clone(), target.clone(), "architecture".into())
        .await
        .unwrap();
    assert!(absent.revision.is_none());
    assert!(matches!(
        canonical
            .note(account.clone(), absent.resolved.note.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let memory = control
        .resolve_memory_target(account.clone(), target.clone(), "architecture".into())
        .await
        .unwrap();
    let present = control
        .inspect_memory_target(account.clone(), target.clone(), "architecture".into())
        .await
        .unwrap();
    assert_eq!(absent.resolved.note, present.resolved.note);
    assert_eq!(present.resolved.note, memory.note);
    assert!(present.revision.is_some());
    assert_eq!(
        control
            .resolve_memory_target(account.clone(), target, "architecture".into())
            .await
            .unwrap()
            .note,
        memory.note
    );
    let scoped = SpaceContext::new(account.auth().clone(), first.scope.clone(), budget()).unwrap();
    for tag in 1..=2 {
        let name = format!("project-{tag}");
        canonical
            .create_folder(CreateFolderSpec {
                scope: first.scope.clone(),
                active_epoch: first.active_epoch,
                folder_id: FolderId::from_bytes([tag; 16]),
                parent: None,
                slug: if tag == 1 {
                    "physical-folder-one".into()
                } else {
                    name.clone()
                },
                display_name: name.clone(),
                is_project: true,
                project_slug: Some(name),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let first_page = control
        .list_projects(account.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(
        first_page.items[0].folder.folder_id,
        FolderId::from_bytes([1; 16])
    );
    let next = first_page.continuation.unwrap();
    let second = control
        .list_projects(
            account.clone(),
            ControlPageRequest::new(1, Some(next.clone())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        second.items[0].folder.folder_id,
        FolderId::from_bytes([2; 16])
    );
    let named = canonical
        .project_by_slug(scoped.clone(), "PROJECT-1".into())
        .await
        .unwrap();
    assert_eq!(named.folder.folder_id, FolderId::from_bytes([1; 16]));
    assert!(
        canonical
            .project_by_slug(scoped.clone(), "physical-folder-one".into())
            .await
            .is_err()
    );
    canonical
        .rename_project(
            scoped.clone(),
            mutation(
                &scoped,
                209,
                RenameProject {
                    folder: FolderId::from_bytes([2; 16]),
                    name: "renamed-project".into(),
                    display_name: Some("Renamed project".into()),
                },
            ),
        )
        .await
        .unwrap();
    let alias = canonical
        .project_by_slug(scoped.clone(), "project-2".into())
        .await
        .unwrap();
    assert_eq!(alias.project_slug, "renamed-project");
    assert_eq!(alias.folder.folder_id, FolderId::from_bytes([2; 16]));
    let latest = canonical.read_space(&sid).await.unwrap();
    let visible = control
        .list_spaces(account.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(visible.items[0].last_seq, latest.last_seq);
    let restricted = account
        .auth()
        .for_pat(std::collections::BTreeMap::from([(
            sid.clone(),
            SpaceGrant {
                role: SpaceRole::Viewer,
                read_classes: DocClass::all(),
                write_classes: Default::default(),
                project_root: Some(FolderId::from_bytes([1; 16])),
            },
        )]))
        .unwrap();
    let limited_space =
        SpaceContext::new(restricted.clone(), first.scope.clone(), budget()).unwrap();
    assert!(matches!(
        canonical
            .project_by_slug(limited_space, "project-2".into())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let private = AccountContext::new(restricted, budget());
    assert!(matches!(
        canonical.note(private, memory.note.clone()).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let entry = NoteId::from_bytes([8; 16]);
    let ability = AbilityId::from_bytes([8; 16]);
    canonical
        .create_note(
            scoped.clone(),
            mutation(
                &scoped,
                51,
                CreateNote {
                    folder_page: false,
                    note: entry.clone(),
                    parent: None,
                    slug: "my-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: Skill\n---\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        control
            .list_projects(
                account.clone(),
                ControlPageRequest::new(1, Some(next)).unwrap()
            )
            .await
            .is_err()
    );
    let files = (0..MAX_ABILITY_AUX_FILES)
        .map(|n| {
            let prefix = format!("asset-{n:03}/");
            let path = format!(
                "{prefix}{}",
                "a".repeat(MAX_ABILITY_AUX_PATH_BYTES - prefix.len())
            );
            AbilityFile {
                path,
                content: "x".into(),
                digest: notarium_syntax::content_digest("x"),
            }
        })
        .collect();
    let published = canonical
        .publish_ability_package(
            scoped.clone(),
            mutation(
                &scoped,
                52,
                PublishAbilityPackage {
                    attached_skills: vec![],
                    ability: ability.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: entry.clone(),
                    files,
                    expected_package_revision: None,
                    expected_entrypoint_revision: None,
                    requires_explicit_binding: false,
                },
            ),
        )
        .await
        .unwrap();
    let value = control
        .get_ability(
            account.clone(),
            AbilityRef {
                id: ability.clone(),
                placement: AbilityPlacement::OwnedPersonal(owner.clone()),
                revision: published.value.revision,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(value.auxiliary_files.len(), MAX_ABILITY_AUX_FILES);
    assert!(
        value
            .auxiliary_files
            .iter()
            .all(|name| name.len() == MAX_ABILITY_AUX_PATH_BYTES)
    );
    builtins_after_owned_page(&canonical, &account, scoped.scope(), &value.reference).await;
    let project = notarium_core::model::FolderRef {
        space_id: sid.clone(),
        folder_id: FolderId::from_bytes([2; 16]),
    };
    let pinned = AccountContext::new(
        account
            .auth()
            .for_pat(std::collections::BTreeMap::from([(
                sid.clone(),
                SpaceGrant {
                    role: SpaceRole::Viewer,
                    read_classes: DocClass::all(),
                    write_classes: Default::default(),
                    project_root: Some(project.folder_id.clone()),
                },
            )]))
            .unwrap(),
        budget(),
    );
    let project_page = control
        .list_projects(pinned.clone(), ControlPageRequest::new(1, None).unwrap())
        .await
        .unwrap();
    assert_eq!(project_page.items.len(), 1);
    assert_eq!(project_page.items[0].folder, project);
    assert!(project_page.continuation.is_none());
    empty_folder_disclosure(&canonical, &account, &scoped, &first, &project).await;

    // The tip still names the manifest published at the personal root.
    let move_entry = |key, parent| {
        canonical.move_note(
            scoped.clone(),
            mutation(
                &scoped,
                key,
                MoveNote {
                    note: entry.clone(),
                    parent,
                    slug: "my-skill".into(),
                },
            ),
        )
    };
    move_entry(54, Some(project.folder_id.clone()))
        .await
        .unwrap();
    let moved = AbilityRef {
        placement: AbilityPlacement::OwnedProject(project.clone()),
        ..value.reference.clone()
    };
    let selection = AbilitySelection::Exact {
        reference: moved.clone(),
        project: Some(project.clone()),
    };
    assert!(matches!(
        control
            .resolve_ability(pinned.clone(), selection)
            .await
            .unwrap(),
        AbilityResolution::Missing
    ));
    assert!(matches!(
        control
            .get_ability(pinned.clone(), moved.clone(), Some(project.clone()))
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert_eq!(
        control
            .get_ability(account.clone(), moved, Some(project.clone()))
            .await
            .unwrap()
            .auxiliary_files,
        value.auxiliary_files
    );

    // Two visible manifests follow an earlier hidden one in package ID order.
    for tag in [9, 10] {
        let new_entry = NoteId::from_bytes([tag; 16]);
        canonical
            .create_note(
                scoped.clone(),
                mutation(
                    &scoped,
                    60 + tag,
                    CreateNote {
                        folder_page: false,
                        note: new_entry.clone(),
                        parent: Some(project.folder_id.clone()),
                        slug: format!("visible-{tag}"),
                        class: DocClass::Skill,
                        carrier: "---\nclass: skill\ntitle: Visible\n---\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        canonical
            .publish_ability_package(
                scoped.clone(),
                mutation(
                    &scoped,
                    80 + tag,
                    PublishAbilityPackage {
                        attached_skills: vec![],
                        ability: AbilityId::from_bytes([tag; 16]),
                        kind: AbilityKind::Skill,
                        entrypoint: new_entry,
                        files: vec![],
                        expected_package_revision: None,
                        expected_entrypoint_revision: None,
                        requires_explicit_binding: false,
                    },
                ),
            )
            .await
            .unwrap();
    }
    let query = |next| AbilityQuery {
        page: ControlPageRequest::new(1, next).unwrap(),
        project: Some(project.clone()),
        kind: Some(AbilityKind::Skill),
        name: None,
        authoring: false,
    };
    let raw_first = canonical
        .abilities(pinned.clone(), query(None))
        .await
        .unwrap();
    assert_eq!(raw_first.items.len(), 1);
    assert_eq!(
        raw_first.items[0].reference.id,
        AbilityId::from_bytes([9; 16])
    );
    let token: serde_json::Value =
        serde_json::from_str(raw_first.continuation.as_ref().unwrap()).unwrap();
    assert!(token["after"][1].is_u64());
    let raw_second = canonical
        .abilities(pinned.clone(), query(raw_first.continuation))
        .await
        .unwrap();
    assert_eq!(raw_second.items.len(), 1);
    assert_eq!(
        raw_second.items[0].reference.id,
        AbilityId::from_bytes([10; 16])
    );
    assert!(raw_second.continuation.is_none());
    let mut cursor = None;
    let mut discovered = Vec::new();
    for _ in 0..3 {
        let page = control
            .discover_abilities(pinned.clone(), query(cursor.take()))
            .await
            .unwrap();
        discovered.extend(
            page.items
                .into_iter()
                .map(|item| item.descriptor.reference.id),
        );
        cursor = page.continuation;
        if cursor.is_none() {
            break;
        }
    }
    assert!(cursor.is_none());
    assert_eq!(
        discovered,
        vec![
            AbilityId::from_bytes([9; 16]),
            AbilityId::from_bytes([10; 16])
        ]
    );
    move_entry(55, None).await.unwrap();
    canonical
        .rename_note(
            scoped.clone(),
            mutation(
                &scoped,
                56,
                RenameNote {
                    note: entry.clone(),
                    slug: "renamed-skill".into(),
                    title: None,
                },
            ),
        )
        .await
        .unwrap();
    let renamed = control
        .get_ability(account.clone(), value.reference.clone(), None)
        .await
        .unwrap();
    assert_eq!(renamed.name, "renamed-skill");
    assert_eq!(renamed.auxiliary_files, value.auxiliary_files);
    let by_name = |name: &str| AbilitySelection::Name {
        name: name.into(),
        kind: AbilityKind::Skill,
        project: None,
    };
    assert!(
        matches!(control.resolve_ability(account.clone(), by_name("renamed-skill")).await.unwrap(), AbilityResolution::Resolved(item) if item.reference == value.reference)
    );
    assert!(matches!(
        control
            .resolve_ability(account.clone(), by_name("my-skill"))
            .await
            .unwrap(),
        AbilityResolution::Missing
    ));
    let previous = value.reference;
    let updated = canonical
        .publish_ability_package(
            scoped.clone(),
            mutation(
                &scoped,
                53,
                PublishAbilityPackage {
                    ability,
                    attached_skills: vec![],
                    kind: AbilityKind::Skill,
                    entrypoint: entry,
                    files: Vec::new(),
                    expected_package_revision: Some(previous.revision.clone()),
                    expected_entrypoint_revision: None,
                    requires_explicit_binding: false,
                },
            ),
        )
        .await
        .unwrap();
    let current = canonical
        .current_ability(account.clone(), previous.identity())
        .await
        .unwrap();
    assert_eq!(current.reference.revision, updated.value.revision);
    assert!(current.auxiliary_files.is_empty());
    let exact = canonical
        .ability(account.clone(), previous.clone())
        .await
        .unwrap();
    assert_eq!(exact.reference, previous);
    assert_eq!(exact.name, "my-skill");
    assert_eq!(exact.auxiliary_files.len(), MAX_ABILITY_AUX_FILES);
    assert!(matches!(
        control
            .resolve_ability(
                account.clone(),
                AbilitySelection::Exact {
                    reference: previous.clone(),
                    project: None,
                }
            )
            .await
            .unwrap(),
        AbilityResolution::Stale
    ));
    assert!(!account.auth().taint().is_tainted());

    let shared = SpaceId::from_bytes([5; 16]);
    let id = support::command(&owner, &owner, 31, ControlRevision::ZERO);
    let create = EnsureCatalogSpace {
        identity: id.clone(),
        owner: owner.clone(),
        space: CreateSpace {
            id: shared.clone(),
            kind: SpaceKind::Shared,
            name: "Another / display name".into(),
        },
    };
    // A cancelled provisioning request queued behind a backup must leave
    // neither a Space nor a receipt. The same command remains usable.
    let mut backup = canonical
        .prepare(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Backup),
                budget: budget(),
            },
            BackupId::from_bytes([0x71; 16]),
            canonical.default_backup_budget(),
        )
        .await
        .unwrap();
    let hold = backup.acquire_hold().await.unwrap();
    let pause = backup.pause_writes().await.unwrap();
    let queued_budget = budget();
    let cancel = queued_budget.cancellation.clone();
    let mut queued = Box::pin(canonical.ensure_space(queued_budget, create.clone()));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut queued)
            .await
            .is_err()
    );
    cancel.cancel();
    assert!(matches!(queued.await, Err(PortError::Cancelled(e))
        if e.effect() == notarium_core::error::CommitEffect::NotCommitted));
    pause.resume().await.unwrap();
    hold.release().await.unwrap();
    drop(backup);
    assert!(matches!(
        canonical.read_space(&shared).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let r = canonical
        .ensure_space(budget(), create.clone())
        .await
        .unwrap();
    assert_eq!(
        canonical
            .ensure_space(budget(), create.clone())
            .await
            .unwrap()
            .history,
        r.history
    );
    let mut changed = create;
    changed.space.name = "Different".into();
    assert!(matches!(
        canonical.ensure_space(budget(), changed).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    let close = support::command(&owner, &owner, 32, ControlRevision::new(1).unwrap());
    for _ in 0..2 {
        let archived = canonical
            .change_lifecycle(
                budget(),
                close.clone(),
                r.history.clone(),
                SpaceLifecycle::Archived,
            )
            .await
            .unwrap();
        assert_eq!(archived.space.lifecycle, SpaceLifecycle::Archived);
    }
    assert_eq!(
        canonical
            .space(budget(), shared)
            .await
            .unwrap()
            .space
            .lifecycle,
        SpaceLifecycle::Archived
    );
    let owner_revision = control
        .account(account.clone(), owner.clone())
        .await
        .unwrap()
        .revision;
    let managed = control
        .create_space(
            account,
            AccountMutation {
                identity: support::command(&owner, &owner, 40, owner_revision),
                input: CreateSpace {
                    id: SpaceId::from_bytes([40; 16]),
                    kind: SpaceKind::Shared,
                    name: "Shared team".into(),
                },
            },
        )
        .await
        .unwrap();
    let mut revision = ControlRevision::ZERO;
    for (key, lifecycle) in [(41, SpaceLifecycle::Archived), (42, SpaceLifecycle::Active)] {
        let management = control
            .admit_space_management(context(&control).await, managed.value.history.clone())
            .await
            .unwrap();
        let committed = control
            .change_space_lifecycle(
                management,
                SpaceLifecycleChange {
                    command: CommandKey::from_bytes([key; 16]),
                    lifecycle,
                    expected: revision,
                },
            )
            .await
            .unwrap();
        assert_eq!(committed.value.space.lifecycle, lifecycle);
        assert_eq!(
            canonical
                .read_space(&managed.value.space.id)
                .await
                .unwrap()
                .space
                .lifecycle,
            lifecycle
        );
        revision = committed.revision;
    }
    drop(control);
    drop(canonical);
    runtime.shutdown().await.unwrap();
    fixture.close().await;
    if pg {
        std::fs::remove_dir_all(path).unwrap();
    }
}

async fn empty_folder_disclosure(
    canonical: &CanonicalStore,
    account: &AccountContext,
    scoped: &SpaceContext,
    space: &notarium_canonical::SpaceRecord,
    project: &notarium_core::model::FolderRef,
) {
    let folder = notarium_core::model::FolderRef {
        space_id: project.space_id.clone(),
        folder_id: FolderId::from_bytes([29; 16]),
    };
    canonical
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: space.active_epoch,
            folder_id: folder.folder_id.clone(),
            parent: Some(project.folder_id.clone()),
            slug: "empty".into(),
            display_name: "Empty folder".into(),
            is_project: false,
            project_slug: None,
            actor: account.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let metadata = canonical
        .disclosure(account.clone(), CatalogDisclosure::Folder(folder.clone()))
        .await
        .unwrap();
    let text =
        notarium_core::classes::ClassEgressFence::mcp_metadata(&metadata, account.auth()).unwrap();
    assert!(text.contains("Empty folder"));
    let origin = metadata.current().origin();
    let request = ProviderEgressRequest {
        origins: vec![origin.clone()],
        primary: space.scope.clone(),
        project: Some(project.clone()),
        secondary_projects: vec![],
        project_folders: Default::default(),
    };
    let mut lease = canonical
        .acquire_egress(account.clone(), request.clone(), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(lease.current()[0].origin(), origin);
    assert!(lease.current()[0].in_project(project));
    let mut second = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        canonical.acquire_egress(account.clone(), request.clone(), Cancellation::default()),
    )
    .await
    .expect("two disclosures can share the same Space")
    .unwrap();
    let mut rename = Box::pin(canonical.rename_folder(
        scoped.clone(),
        mutation(
            scoped,
            96,
            RenameFolder {
                folder: folder.folder_id,
                name: "renamed".into(),
            },
        ),
    ));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut rename)
            .await
            .is_err()
    );
    let owner = account.auth().principal().clone();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        canonical.ensure_space(
            budget(),
            EnsureCatalogSpace {
                identity: support::command(&owner, &owner, 98, ControlRevision::ZERO),
                owner,
                space: CreateSpace {
                    id: SpaceId::from_bytes([98; 16]),
                    kind: SpaceKind::Shared,
                    name: "Concurrent workspace".into(),
                },
            },
        ),
    )
    .await
    .expect("independent Space can commit during disclosure")
    .unwrap();
    lease.mark_dispatched().await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut rename)
            .await
            .is_err()
    );
    second.mark_dispatched().await.unwrap();
    rename.await.unwrap();
    assert!(matches!(
        canonical
            .acquire_egress(account.clone(), request, Cancellation::default())
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::SourceMismatch
    ));
    lease.check().unwrap();
    lease.close().await.unwrap();
    second.close().await.unwrap();
}

async fn builtins_after_owned_page(
    canonical: &CanonicalStore,
    account: &AccountContext,
    space: &notarium_core::model::HistoryScope,
    owned: &AbilityRef,
) {
    let catalog = SystemAbilityCatalog::new(Arc::new(canonical.clone()));
    let query = |continuation| AbilityQuery {
        page: ControlPageRequest::new(1, continuation).unwrap(),
        project: None,
        kind: None,
        name: None,
        authoring: false,
    };
    let page = catalog
        .abilities(account.clone(), query(None))
        .await
        .unwrap();
    assert_eq!(page.items[0].reference, *owned);
    let cursor = page.continuation.unwrap();
    assert!(cursor.len() <= 2048);
    let mut changed = query(Some(cursor.clone()));
    changed.kind = Some(AbilityKind::Role);
    assert!(matches!(
        catalog.abilities(account.clone(), changed).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
    ));

    let mut names = Vec::new();
    let mut next = Some(cursor);
    let mut role = None;
    while let Some(cursor) = next.take() {
        let page = catalog
            .abilities(account.clone(), query(Some(cursor)))
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        assert_eq!(item.reference.placement, AbilityPlacement::System);
        assert!(item.entrypoint.is_none());
        names.push(item.name.clone());
        if item.name == "research" {
            role = Some(item.clone());
        }
        assert!(names.len() <= 4);
        next = page.continuation;
    }
    assert_eq!(
        names,
        [
            "research",
            "research-evidence",
            "grooming",
            "grooming-evidence"
        ]
    );
    let role = role.unwrap();
    let skill = role.attached_skills[0].clone();
    let lease = catalog
        .pin_schedule_abilities(
            account.clone(),
            vec![owned.clone(), role.reference.clone(), skill],
        )
        .await
        .unwrap();
    assert_eq!(lease.abilities().len(), 3);
    drop(lease);

    let body = read_system_ability(account, &role.reference).unwrap();
    assert!(!body.text().is_empty());
    let origin = body.origin();
    let owned_body = canonical
        .read_ability_resource(
            SpaceContext::new(account.auth().clone(), space.clone(), budget()).unwrap(),
            ReadAbilityResource {
                ability: owned.id.clone(),
                package_revision: owned.revision.clone(),
                resource: notarium_core::model::AbilityResourceName::Entrypoint,
            },
        )
        .await
        .unwrap();
    let origins = vec![origin.clone(), owned_body.origin()];
    let request = |origins| ProviderEgressRequest {
        primary: space.clone(),
        origins,
        project: None,
        secondary_projects: vec![],
        project_folders: Default::default(),
    };
    let lease = catalog
        .acquire_egress(
            account.clone(),
            request(origins.clone()),
            Cancellation::default(),
        )
        .await
        .unwrap();
    assert!(matches!(
        lease.current(),
        [
            ProviderCurrentContent::SystemAbility { .. },
            ProviderCurrentContent::Ability { .. }
        ]
    ));
    assert_eq!(
        lease
            .current()
            .iter()
            .map(ProviderCurrentContent::origin)
            .collect::<Vec<_>>(),
        origins
    );
    lease.check().unwrap();
    drop(lease);

    let ProviderOrigin::SystemAbility {
        ability, revision, ..
    } = origin
    else {
        panic!("built-in source");
    };
    let wrong_digest = ProviderOrigin::SystemAbility {
        ability,
        revision,
        digest: ContentDigest::from_bytes([0; 32]),
    };
    assert!(matches!(
        catalog
            .acquire_egress(
                account.clone(),
                request(vec![wrong_digest]),
                Cancellation::default()
            )
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_catalog_account_recovery() {
    exercise(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_catalog_account_recovery() {
    exercise(true).await;
}

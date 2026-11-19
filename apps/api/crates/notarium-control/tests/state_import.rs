#[allow(dead_code)]
mod support;
use notarium_control::{service::AuthenticationMode, store::TargetRecord};
use notarium_core::{
    auth::*,
    classes::DocClass,
    ids::*,
    model::*,
    ports::{control::*, *},
};
use support::*;

fn restore() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Restore),
        budget: budget(),
    }
}

async fn state_import(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let mut f = Fixture::new(pg, "state_import").await;
    let service = f.service(AuthenticationMode::Password).await.unwrap();
    let bootstrap = service
        .bootstrap(
            empty(),
            budget(),
            BootstrapAccount {
                username: "importowner".into(),
                email: None,
                display_name: "Import owner".into(),
                password: Some(SecretString::new("account state import password".into())),
            },
        )
        .await
        .unwrap();
    let token = bootstrap.session.unwrap().token;
    let auth = service
        .resolve(evidence(AuthEvidenceKind::Session, token.expose()))
        .await
        .unwrap();
    let ctx = AccountContext::new(auth, budget());
    let owner = ctx.auth().principal().to_string();
    let space = bootstrap.account.personal_space.unwrap();
    let project = FolderRef {
        space_id: space.clone(),
        folder_id: FolderId::from_bytes([10; 16]),
    };
    let note = NoteRef {
        space_id: space.clone(),
        note_id: NoteId::from_bytes([11; 16]),
    };
    let placement = AbilityPlacement::OwnedPersonal(ctx.auth().principal().clone());
    let role = AbilityRef {
        id: AbilityId::from_bytes([12; 16]),
        placement: placement.clone(),
        revision: RevisionId::from_bytes([12; 16]),
    };
    let destination = AbilityRef {
        id: AbilityId::from_bytes([13; 16]),
        ..role.clone()
    };
    let space_info = f.catalog.entries.lock().unwrap()[&space].2.space.clone();
    f.catalog.project_entries.lock().unwrap().insert(
        (space.clone(), project.folder_id.clone()),
        ProjectInfo {
            project_slug: "project".into(),
            folder: project.clone(),
            name: "Imported project".into(),
        },
    );
    f.catalog.note_entries.lock().unwrap().insert(
        (space.clone(), note.note_id.clone()),
        CatalogNote {
            reference: note.clone(),
            lifecycle: Lifecycle::Active,
            facts: ResourceFacts {
                space: space_info,
                class: DocClass::UserDoc,
                project: Some(project.folder_id.clone()),
                ancestor_folders: vec![project.folder_id.clone()],
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );
    let call_id_str = RequestId::from_bytes([20; 16]).to_string();
    let call = |call_id: String, request_id: String| TargetRecord::AgentCalls {
        call_id,
        owner_id: owner.clone(),
        principal: owner.clone(),
        agent: None,
        transport: "internal".into(),
        request_id,
        episode_id: None,
        tool: "list".into(),
        effect: "read".into(),
        domain: "control".into(),
        started_at: 0,
        finished_at: None,
        duration_ms: None,
        outcome: None,
        reason: None,
        input_bytes: 0,
        output_bytes: None,
        summaries: "null".into(),
        fingerprint: vec![0; 32],
        projection_version: 1,
        redacted: 1,
        truncated: 0,
        detail_capture_failed: 0,
    };
    let episode_id_str = EpisodeId::from_bytes([22; 16]).to_string();
    let episode = |episode_id: String, active_role: Option<String>| TargetRecord::AgentEpisodes {
        episode_id,
        owner_id: owner.clone(),
        name: Some("Imported episode".into()),
        parent_id: None,
        active_role,
        project_space: None,
        project_folder: None,
        lifecycle: "active".into(),
        revision: 1,
        created_at: 0,
        last_seen_at: 0,
        closed_at: None,
        calls: 0,
    };
    let pin = |target_id: String| TargetRecord::ContextScopePins {
        owner_id: owner.clone(),
        target_kind: "project".into(),
        target_id,
        target_space: space.to_string(),
        note_space: space.to_string(),
        note_id: note.note_id.to_string(),
        revision: 1,
        created_at: 0,
    };
    let placement_json = serde_json::to_string(&placement).unwrap();
    let availability = |placement: String| TargetRecord::AbilityAvailability {
        placement,
        ability_id: role.id.to_string(),
        mode: "all-projects".into(),
        enabled: 0,
        revision: 1,
    };
    let trail_manifest =
        serde_json::json!({"source": role, "destination": destination}).to_string();
    let trail = |ability_id: String, manifest_ref: String| TargetRecord::AbilityPlacementTrail {
        source_placement: placement_json.clone(),
        ability_id,
        destination_placement: placement_json.clone(),
        destination_id: destination.id.to_string(),
        manifest_ref,
        created_at: 0,
    };
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='migrating' WHERE singleton=1")
        .await;
    f.store
        .import_target_batch(
            restore(),
            &[
                call(
                    call_id_str.clone(),
                    RequestId::from_bytes([21; 16]).to_string(),
                ),
                episode(
                    episode_id_str.clone(),
                    Some(serde_json::to_string(&role).unwrap()),
                ),
                pin(serde_json::to_string(&project).unwrap()),
                availability(placement_json.clone()),
                trail(role.id.to_string(), trail_manifest.clone()),
                TargetRecord::ProviderCallLog {
                    call_id: RequestId::from_bytes([25; 16]).to_string(),
                    owner_id: owner.clone(),
                    principal: owner.clone(),
                    run_id: None,
                    scope_id: format!("space:{space}"),
                    intent_key: CommandKey::from_bytes([26; 16]).to_string(),
                    request_hash: vec![9; 32],
                    resource_id: ProviderResourceId::from_bytes([27; 16]).to_string(),
                    credential_id: None,
                    policy_epochs: "{}".into(),
                    participating_spaces: "[]".into(),
                    model_id: None,
                    reserved_tokens: 10,
                    bucket_keys: "[]".into(),
                    delivery_state: "settled".into(),
                    outcome: Some("completed".into()),
                    usage_source: "exact".into(),
                    input_tokens: Some(5),
                    output_tokens: Some(5),
                    diagnostic: Some("d".repeat(3_200)),
                    dispatch_owner: None,
                    created_at: 0,
                    settled_at: Some(0),
                },
            ],
        )
        .await
        .unwrap();

    let pretty_order = TargetRecord::ContextOrder {
        owner_id: owner.clone(),
        target_kind: "personal".into(),
        target_id: owner.clone(),
        target_space: space.to_string(),
        entry_kind: "note".into(),
        entry_ref: serde_json::to_string_pretty(&note).unwrap(),
        rank: 0,
        revision: 1,
    };
    let candidates = [
        (
            "request ID",
            call(
                RequestId::from_bytes([30; 16]).to_string(),
                "invalid-request".into(),
            ),
        ),
        (
            "episode role",
            episode(
                EpisodeId::from_bytes([31; 16]).to_string(),
                Some("{}".into()),
            ),
        ),
        ("ability placement", availability("{}".into())),
        (
            "formatted placement key",
            availability(serde_json::to_string_pretty(&placement).unwrap()),
        ),
        (
            "ability trail payload",
            trail(AbilityId::from_bytes([32; 16]).to_string(), "{}".into()),
        ),
        (
            "ability trail identity",
            trail(AbilityId::from_bytes([33; 16]).to_string(), trail_manifest),
        ),
        (
            "formatted project key",
            pin(serde_json::to_string_pretty(&project).unwrap()),
        ),
        ("formatted order key", pretty_order),
    ];
    let mut accepted = Vec::new();
    for (index, (label, invalid)) in candidates.into_iter().enumerate() {
        // A preceding valid page makes rejection prove transaction rollback,
        // including work that already reached the driver.
        let sentinel = TargetRecord::Favorites {
            owner_id: owner.clone(),
            space_id: space.to_string(),
            entity_kind: "note".into(),
            entity_id: NoteId::from_bytes([100 + index as u8; 16]).to_string(),
            rank: 0,
            created_at: 0,
        };
        let mut import = f.store.begin_target_import(restore()).await.unwrap();
        import.append(&[sentinel]).await.unwrap();
        if import.append(&[invalid]).await.is_ok() {
            import.finish().await.unwrap();
            accepted.push(label);
        }
    }
    assert!(
        accepted.is_empty(),
        "unreadable target payloads or keys were committed: {accepted:?}"
    );
    assert_eq!(f.observer.count("SELECT count(*) FROM favorites").await, 0);
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='ready' WHERE singleton=1")
        .await;
    service
        .get_agent_call(ctx.clone(), RequestId::parse(&call_id_str).unwrap())
        .await
        .unwrap();
    assert_eq!(
        service
            .list_agent_calls(ctx.clone(), ControlPageRequest::new(200, None).unwrap())
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    service
        .get_episode(ctx.clone(), EpisodeId::parse(&episode_id_str).unwrap())
        .await
        .unwrap();
    let entries = service
        .list_context_entries(
            ctx,
            ContextScope::Project(project),
            ControlPageRequest::new(200, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(entries.items.len(), 1);
    assert!(entries.continuation.is_none());
    drop(service);
    f.close().await;
}

#[tokio::test]
async fn sqlite_target_state_matches_runtime_contracts() {
    state_import(false).await;
}
#[tokio::test]
async fn postgres_target_state_matches_runtime_contracts() {
    state_import(true).await;
}

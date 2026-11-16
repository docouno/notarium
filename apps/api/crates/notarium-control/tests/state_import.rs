#[allow(dead_code)]
mod support;
use notarium_control::{service::AuthenticationMode, store::target::*};
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
                ancestor_folders: vec![project.folder_id.clone()],
                folder_write_locked: false,
                ability_package: None,
            },
        },
    );
    let call = AgentCallsRow {
        call_id: RequestId::from_bytes([20; 16]).to_string(),
        owner_id: owner.clone(),
        principal: owner.clone(),
        agent: None,
        transport: "internal".into(),
        request_id: RequestId::from_bytes([21; 16]).to_string(),
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
    let episode = AgentEpisodesRow {
        episode_id: EpisodeId::from_bytes([22; 16]).to_string(),
        owner_id: owner.clone(),
        name: Some("Imported episode".into()),
        parent_id: None,
        active_role: Some(serde_json::to_string(&role).unwrap()),
        project_space: None,
        project_folder: None,
        lifecycle: "active".into(),
        revision: 1,
        created_at: 0,
        last_seen_at: 0,
        closed_at: None,
        calls: 0,
    };
    let pin = ContextScopePinsRow {
        owner_id: owner.clone(),
        target_kind: "project".into(),
        target_id: serde_json::to_string(&project).unwrap(),
        target_space: space.to_string(),
        note_space: space.to_string(),
        note_id: note.note_id.to_string(),
        revision: 1,
        created_at: 0,
    };
    let availability = AbilityAvailabilityRow {
        placement: serde_json::to_string(&placement).unwrap(),
        ability_id: role.id.to_string(),
        mode: "all-projects".into(),
        enabled: 0,
        revision: 1,
    };
    let trail = AbilityPlacementTrailRow {
        source_placement: availability.placement.clone(),
        ability_id: role.id.to_string(),
        destination_placement: availability.placement.clone(),
        destination_id: destination.id.to_string(),
        manifest_ref: serde_json::json!({"source": role, "destination": destination}).to_string(),
        created_at: 0,
    };
    f.observer
        .execute("UPDATE v1_storage_epoch SET state='migrating' WHERE singleton=1")
        .await;
    f.store
        .import_target_batch(
            restore(),
            &[
                TargetRecord::AgentCalls(call.clone()),
                TargetRecord::AgentEpisodes(episode.clone()),
                TargetRecord::ContextScopePins(pin.clone()),
                TargetRecord::AbilityAvailability(availability.clone()),
                TargetRecord::AbilityPlacementTrail(trail.clone()),
            ],
        )
        .await
        .unwrap();

    let mut malformed_call = call.clone();
    malformed_call.call_id = RequestId::from_bytes([30; 16]).to_string();
    malformed_call.request_id = "invalid-request".into();
    let mut malformed_episode = episode.clone();
    malformed_episode.episode_id = EpisodeId::from_bytes([31; 16]).to_string();
    malformed_episode.active_role = Some("{}".into());
    let mut malformed_placement = availability.clone();
    malformed_placement.placement = "{}".into();
    let mut pretty_placement = availability.clone();
    pretty_placement.placement = serde_json::to_string_pretty(&placement).unwrap();
    let mut malformed_trail = trail.clone();
    malformed_trail.ability_id = AbilityId::from_bytes([32; 16]).to_string();
    malformed_trail.manifest_ref = "{}".into();
    let mut mismatched_trail = trail.clone();
    mismatched_trail.ability_id = AbilityId::from_bytes([33; 16]).to_string();
    let mut pretty_pin = pin.clone();
    pretty_pin.target_id = serde_json::to_string_pretty(&project).unwrap();
    let pretty_order = ContextOrderRow {
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
        ("request ID", TargetRecord::AgentCalls(malformed_call)),
        (
            "episode role",
            TargetRecord::AgentEpisodes(malformed_episode),
        ),
        (
            "ability placement",
            TargetRecord::AbilityAvailability(malformed_placement),
        ),
        (
            "formatted placement key",
            TargetRecord::AbilityAvailability(pretty_placement),
        ),
        (
            "ability trail payload",
            TargetRecord::AbilityPlacementTrail(malformed_trail),
        ),
        (
            "ability trail identity",
            TargetRecord::AbilityPlacementTrail(mismatched_trail),
        ),
        (
            "formatted project key",
            TargetRecord::ContextScopePins(pretty_pin),
        ),
        (
            "formatted order key",
            TargetRecord::ContextOrder(pretty_order),
        ),
    ];
    let mut accepted = Vec::new();
    for (index, (label, invalid)) in candidates.into_iter().enumerate() {
        // A preceding valid page makes rejection prove transaction rollback,
        // including work that already reached the driver.
        let sentinel = TargetRecord::Favorites(FavoritesRow {
            owner_id: owner.clone(),
            space_id: space.to_string(),
            entity_kind: "note".into(),
            entity_id: NoteId::from_bytes([100 + index as u8; 16]).to_string(),
            rank: 0,
            created_at: 0,
        });
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
        .get_agent_call(ctx.clone(), RequestId::parse(&call.call_id).unwrap())
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
        .get_episode(ctx.clone(), EpisodeId::parse(&episode.episode_id).unwrap())
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

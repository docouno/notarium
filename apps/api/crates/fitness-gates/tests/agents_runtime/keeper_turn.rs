use super::*;
use notarium_agents::{
    chats::{AgentRunSupervisor, ExclusiveDataRoot},
    keepers::KeeperScheduler,
};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::SpaceKind,
    classes::{AbilityKind, ClassEgressFence, DocClass},
    model::FolderRef,
    ports::schedules::*,
    receipt::{CommandIdentity, ReceiptSet},
    value::Timestamp,
};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, time::timeout};

use super::runtime_ability_cases::{
    approve_disclosure, identity, loopback_provider, read_request, send_ollama,
};

const CATEGORIES: [&str; 9] = [
    "progress",
    "scope",
    "owners",
    "risks",
    "dependencies",
    "evidence",
    "decisions",
    "history",
    "followup",
];

#[tokio::test]
async fn sqlite_keeper_turn_reconsent() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(false).await;
}

#[tokio::test]
async fn postgres_keeper_turn_reconsent() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(true).await;
}

async fn exercise(postgres: bool) {
    let mut fixture = RuntimeFixture::open_named(postgres, "keeper_turn").await;
    let hub =
        notarium_collab::CollabHub::new(fixture.canonical.clone(), Default::default()).unwrap();
    hub.register().unwrap();
    Box::pin(keeper_turn_reconsent(&mut fixture)).await;
    hub.shutdown(&budget()).await.unwrap();
    drop(hub);
    fixture.close().await;
}

async fn keeper_turn_reconsent(fixture: &mut RuntimeFixture) {
    let owner = fixture.human.auth().principal().clone();
    let shared = fixture
        .control
        .create_space(
            fixture.human.clone(),
            AccountMutation {
                identity: identity(fixture, &fixture.human, 191).await,
                input: CreateSpace {
                    id: SpaceId::from_bytes([191; 16]),
                    kind: SpaceKind::Shared,
                    name: "Keeper fixture".into(),
                },
            },
        )
        .await
        .unwrap()
        .value;
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
    let scope = SpaceContext::new(human.auth().clone(), shared.history.clone(), budget()).unwrap();
    let active_epoch = fixture
        .canonical
        .read_space(&shared.history.space_id)
        .await
        .unwrap()
        .active_epoch;
    let project = FolderRef {
        space_id: shared.history.space_id.clone(),
        folder_id: FolderId::from_bytes([192; 16]),
    };
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: shared.history.clone(),
            active_epoch,
            folder_id: project.folder_id.clone(),
            parent: None,
            slug: "keepers".into(),
            display_name: "Keeper tasks".into(),
            is_project: true,
            project_slug: Some("keepers".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let project_name = format!("{}/keepers", shared.slug);
    let command = |tag| CommandIdentity {
        scope: shared.history.clone(),
        actor: owner.clone(),
        key: CommandKey::from_bytes([tag; 16]),
        hash: ContentDigest::from_bytes([tag; 32]),
    };
    let inbox = NoteId::from_bytes([190; 16]);
    let inbox_text = "One queued observation for the Keeper to review.";
    let inbox_created = fixture
        .canonical
        .create_note(
            scope.clone(),
            Mutation {
                identity: command(190),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: inbox.clone(),
                    parent: Some(project.folder_id.clone()),
                    class: DocClass::UserDoc,
                    slug: "inbox".into(),
                    carrier: inbox_text.into(),
                    folder_page: false,
                },
            },
        )
        .await
        .unwrap();
    let mut original_memories = Vec::new();
    for (index, category) in CATEGORIES.iter().enumerate() {
        call(fixture, &human, 210 + index as u8, "remember_about_project", json!({
            "project":project_name, "category":category, "observation":"Observation before the Keeper."
        })).await.unwrap();
        let target = fixture
            .control
            .inspect_memory_target(
                human.clone(),
                MemoryTarget::Project {
                    folder: project.clone(),
                },
                (*category).into(),
            )
            .await
            .unwrap();
        let note = get_note(fixture, &scope, target.resolved.note.note_id).await;
        original_memories.push((
            note.document.reference().note_id.clone(),
            note.document.digest(),
        ));
    }
    let skill = call(fixture, &human, 192, "create_ability", json!({
        "kind":"skill", "name":"keeper-test-skill", "description":"Keeper fixture skill", "instructions":"Keeper skill version one.",
        "placement":{"home":"space","space":shared.slug}
    })).await.unwrap();
    call(fixture, &human, 193, "create_ability", json!({
        "kind":"role", "name":"keeper-test-role", "description":"Keeper fixture role", "instructions":"Keeper role instructions.",
        "placement":{"home":"space","space":shared.slug},
        "attachments":[{"ref":skill.structured_content["ref"]}]
    })).await.unwrap();
    let role = fixture
        .control
        .resolve_ability(
            human.clone(),
            AbilitySelection::Name {
                name: "keeper-test-role".into(),
                kind: AbilityKind::Role,
                project: Some(project.clone()),
            },
        )
        .await
        .unwrap();
    let AbilityResolution::Resolved(role) = role else {
        panic!("missing keeper role")
    };
    let approval = ScheduleAbilitySelection {
        space: project.space_id.clone(),
        project: Some(project.clone()),
        role: role.reference.identity(),
    };
    let first_approval = fixture
        .control
        .schedule_ability_candidate(human.clone(), approval.clone())
        .await
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &human, &listener, 194, true).await;
    let classes = [DocClass::Skill, DocClass::AgentMemory, DocClass::UserDoc].into();
    approve_disclosure(
        fixture,
        &human,
        &local,
        196,
        ProviderAttachmentTarget::Personal {
            owner: owner.clone(),
            space: project.space_id.clone(),
        },
        classes,
    )
    .await;
    approve_disclosure(
        fixture,
        &human,
        &local,
        197,
        ProviderAttachmentTarget::Project(project.clone()),
        [DocClass::Skill, DocClass::AgentMemory, DocClass::UserDoc].into(),
    )
    .await;
    local
        .provider
        .set_preference(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, &human, 201).await,
                input: SetProviderPreference {
                    scope: ProviderPreferenceScope::Project(project.clone()),
                    kind: PreferenceModelKind::Completion,
                    resource: local.resource.id.clone(),
                    model: local.model.clone(),
                },
            },
        )
        .await
        .unwrap();

    let clock = fixture.storage.clock.clone();
    let original_clock = clock.0.load(Ordering::SeqCst);
    let first_due = Timestamp::parse("2023-11-12T03:00:00Z").unwrap();
    let overdue_tick = Timestamp::parse("2023-11-27T09:05:00Z").unwrap();
    let next_due = Timestamp::parse("2023-12-03T03:00:00Z").unwrap();
    clock
        .0
        .store(first_due.unix_seconds() * 1000, Ordering::SeqCst);
    let schedule = fixture
        .control
        .create_schedule(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, &human, 202).await,
                input: CreateSchedule {
                    id: ScheduleId::from_bytes([202; 16]),
                    definition: ScheduleDefinition {
                        space: project.space_id.clone(),
                        project: Some(project.clone()),
                        title: "Keeper fixture".into(),
                        init_prompt: format!(
                            "Review inbox {inbox} and record the scheduled observations."
                        ),
                        cron: "0 0 3 * * Sun *".into(),
                        timezone: "UTC".into(),
                        approved_role: first_approval.approved_role,
                        limits: RunLimits {
                            max_steps: 4,
                            max_tokens: 100_000,
                            timeout_ms: 20_000,
                        },
                    },
                    approved_skills: first_approval.approved_skills.clone(),
                    next_slot: first_due,
                    paused: false,
                },
            },
        )
        .await
        .unwrap()
        .value;
    let scheduler = KeeperScheduler::new_local(
        local.registry,
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    clock
        .0
        .store(overdue_tick.unix_seconds() * 1000, Ordering::SeqCst);
    let mut worker = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick(overdue_tick).await.unwrap() }
    });
    let (mut wire, request) = tokio::select! {
        request = timeout(Duration::from_secs(15), read_request(&listener)) => {
            request.expect("initial Keeper provider request")
        }
        outcome = &mut worker => panic!("Keeper stopped before dispatch: {:?}", outcome.unwrap()),
    };
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "system"
                && message["content"]
                    .as_str()
                    .unwrap()
                    .contains("Keeper skill version one."))
    );
    assert!(
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| !matches!(
                tool["function"]["name"].as_str(),
                Some("create_note" | "start_session")
            ))
    );
    let concurrent = scheduler.tick(overdue_tick).await.unwrap();
    assert_eq!(concurrent.claimed, 0, "{concurrent:?}");
    let mut tool_calls = vec![
        json!({"function":{"index":0,"name":"get_note","arguments":{"ref":inbox}}}),
        json!({"function":{"index":1,"name":"whoami","arguments":{}}}),
        json!({"function":{"index":2,"name":"get_my_projects","arguments":{}}}),
    ];
    for (index, category) in CATEGORIES.iter().enumerate() {
        tool_calls.push(json!({"function":{
            "index":index + 3,
            "name":"remember_about_project",
            "arguments":{
                "project":project_name, "category":category, "observation":"An exact scheduled observation."
            }
        }}));
    }
    send_ollama(
        &mut wire,
        json!({"role":"assistant","tool_calls":tool_calls}),
        "tool_calls",
    )
    .await;
    drop(wire);
    let (mut wire, request) = tokio::select! {
        request = timeout(Duration::from_secs(25), read_request(&listener)) => {
            request.expect("Keeper continuation provider request")
        }
        outcome = &mut worker => {
            let runs = fixture.control.list_schedule_runs(
                ScheduleRunContext::Owner(Box::new(human.clone())),
                schedule.id.clone(),
                ControlPageRequest::new(10, None).unwrap(),
            ).await.unwrap();
            let entries = if let Some(log) = runs.items.first().and_then(|run| run.keeper_log.as_ref()) {
                let head = log_branch(fixture, &scope, log, ThreadEntrySeq::ZERO).await.thread.head;
                log_branch(fixture, &scope, log, head).await.entries.into_iter().map(|entry| {
                    let error = match &entry.body {
                        ChatBody::Inline(body) => serde_json::from_str::<Value>(body).ok().and_then(|value| value.get("error").cloned()),
                        _ => None,
                    };
                    (entry.seq, entry.kind, error)
                }).collect::<Vec<_>>()
            } else {
                vec![]
            };
            panic!("Keeper stopped before continuation: {:?}; {entries:?}", outcome.unwrap());
        }
    };
    let tool_results: Vec<_> = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    assert_eq!(tool_results.len(), 12);
    assert_eq!(
        tool_results
            .iter()
            .filter(|message| message["content"].as_str().unwrap().contains(inbox_text))
            .count(),
        1
    );
    assert_eq!(
        tool_results
            .iter()
            .filter(|message| message["content"]
                .as_str()
                .unwrap()
                .contains(r#""outcome": "appended""#))
            .count(),
        9,
        "unexpected memory tool results (ordinal, response): {:?}",
        tool_results
            .iter()
            .enumerate()
            .skip(3)
            .filter_map(|(index, message)| {
                let response = message["content"].as_str().unwrap();
                (!response.contains(r#""outcome": "appended""#)).then_some((index, response))
            })
            .collect::<Vec<_>>()
    );
    let saved_text = "Recorded the planned observation. ".repeat(20);
    send_ollama(
        &mut wire,
        json!({"role":"assistant","content":saved_text}),
        "stop",
    )
    .await;
    drop(wire);
    let summary = worker.await.unwrap();
    assert_eq!((summary.claimed, summary.succeeded), (1, 1), "{summary:?}");

    let first_runs = fixture
        .control
        .list_schedule_runs(
            ScheduleRunContext::Owner(Box::new(human.clone())),
            schedule.id.clone(),
            ControlPageRequest::new(10, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first_runs.items.len(), 1);
    let first_run = &first_runs.items[0];
    assert_eq!(first_run.slot, first_due);
    assert_eq!(first_run.reserved_next_slot, Some(next_due));
    assert_eq!(
        first_run.status,
        ScheduleRunStatus::Terminal(ScheduleOutcome::Succeeded)
    );
    let log = first_run.keeper_log.clone().unwrap();
    let branch = log_branch(fixture, &scope, &log, ThreadEntrySeq::ZERO).await;
    assert_eq!(branch.thread.kind, ChatThreadKind::KeeperLog);
    assert_eq!(
        branch.thread.project_folder.as_ref(),
        Some(&project.folder_id)
    );
    let first_leaf = branch.thread.head;
    let branch = log_branch(fixture, &scope, &log, first_leaf).await;
    let mut entries: Vec<_> = branch.entries.iter().collect();
    entries.sort_by_key(|entry| entry.seq);
    assert_eq!(entries.len(), 14);
    assert!(
        entries
            .iter()
            .all(|entry| entry.run.as_ref() == Some(&first_run.run))
    );
    assert!(matches!(entries[13].body, ChatBody::Blob(_)));
    let item = fixture
        .canonical
        .read_chat_contents(
            scope.clone(),
            ChatContentRead {
                thread: log.clone(),
                leaf: first_leaf,
                entries: vec![first_leaf],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        ClassEgressFence::chat_transcript(&item[0].content, scope.auth()).unwrap(),
        saved_text
    );
    for (id, before) in &original_memories {
        let note = get_note(fixture, &scope, id.clone()).await;
        assert_ne!(note.document.digest(), *before);
        assert_eq!(note.document.class(), DocClass::AgentMemory);
    }
    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let rollback_key = command(206).key;
    let undo = || {
        supervisor.rollback_run(
            human.clone(),
            scope.scope().clone(),
            first_run.run.clone(),
            rollback_key.clone(),
        )
    };
    let run_revision = || async {
        fixture
            .canonical
            .read_entity_revision_at_cutoff(
                scope.scope(),
                "agent_run",
                first_run.run.as_str(),
                None,
            )
            .await
            .unwrap()
            .unwrap()
            .revision_id
    };
    let before = run_revision().await;
    let started = Instant::now();
    let resolved = undo().await.unwrap();
    let elapsed = started.elapsed();
    assert_eq!(resolved.value.restored.len(), original_memories.len());
    assert!(resolved.value.trashed.is_empty());
    let backend = if fixture.storage.root.is_some() {
        "sqlite"
    } else {
        "postgres"
    };
    eprintln!(
        "Product rollback sample ({backend}): {} us for {} restored memories",
        elapsed.as_micros(),
        resolved.value.restored.len()
    );
    assert_ne!(run_revision().await, before);
    let replayed = undo().await.unwrap();
    assert_eq!(replayed.receipt, resolved.receipt);
    assert_eq!(replayed.value, resolved.value);
    let after = fixture
        .canonical
        .read_space(&scope.scope().space_id)
        .await
        .unwrap();
    assert_eq!(after.last_seq, resolved.receipt.seq());
    let revisions = resolved
        .value
        .restored
        .iter()
        .map(|entry| format!("'{}'", entry.revision.as_str()))
        .collect::<Vec<_>>()
        .join(",");
    let refs = fixture.canonical.execute_diagnostic_read_sql_for_test(None, &format!(
        "SELECT COUNT(*) FROM revisions v
         JOIN blob_references b ON b.space_id=v.space_id AND b.owner_id=v.entity_key
           AND b.owner_rev_id=v.rev_id AND b.owner_kind='note_revision' AND b.resource_key='carrier'
           AND b.content_blake3=v.content_blake3
         JOIN blob_catalog c ON c.space_id=b.space_id AND c.content_blake3=b.content_blake3
           AND c.current_publication_id=b.publication_id AND c.admission_state='open' AND c.blob_state='active'
         WHERE v.space_id='{}' AND v.rev_id IN ({revisions}) AND c.ref_count=(
             SELECT COUNT(*) FROM blob_references x WHERE x.space_id=c.space_id AND x.content_blake3=c.content_blake3)",
        scope.scope().space_id.as_str(),
    )).await.unwrap();
    assert_eq!(refs as usize, resolved.value.restored.len());
    let digests = original_memories
        .iter()
        .map(|(_, digest)| *digest)
        .collect::<Vec<_>>();
    let retired = fixture
        .canonical
        .retire_zero_ref_digests(
            scope.scope(),
            after.active_epoch,
            &digests,
            notarium_canonical::blobs::RetirementReason::Gc,
            None,
        )
        .await
        .unwrap();
    assert!(retired.is_empty(), "GC must preserve every rebound carrier");
    Box::pin(authoring_authority_cases::revoked_rollback(
        fixture,
        &supervisor,
        scope.scope(),
        &first_run.run,
        &rollback_key,
    ))
    .await;
    for (id, digest) in original_memories {
        assert_eq!(
            get_note(fixture, &scope, id).await.document.digest(),
            digest
        );
    }
    assert_eq!(
        get_note(fixture, &scope, inbox).await.document.revision(),
        &inbox_created.value.revision
    );

    let edit = call(fixture, &human, 203, "edit_ability", json!({
        "ref":skill.structured_content["ref"],"versionToken":skill.structured_content["versionToken"],
        "instructions":"Keeper skill version two."
    })).await.unwrap();
    assert_eq!(edit.structured_content["outcome"], "updated");
    clock
        .0
        .store(next_due.unix_seconds() * 1000, Ordering::SeqCst);
    let paused = scheduler.tick(next_due).await.unwrap();
    assert_eq!((paused.paused, paused.claimed), (1, 0), "{paused:?}");
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    let definition = fixture
        .control
        .get_schedule(scope.clone(), schedule.id.clone())
        .await
        .unwrap();
    assert_eq!(
        definition.paused_reason,
        Some(SchedulePauseReason::RoleChanged)
    );

    let approved = fixture
        .control
        .schedule_ability_candidate(human.clone(), approval)
        .await
        .unwrap();
    assert_ne!(approved.approved_skills, first_approval.approved_skills);
    fixture
        .control
        .update_schedule(
            human.clone(),
            AccountMutation {
                identity: identity(fixture, &human, 204).await,
                input: UpdateSchedule {
                    schedule: definition.id.clone(),
                    expected: definition.revision,
                    definition: definition.definition,
                    approved_skills: Some(approved.approved_skills),
                    next_slot: definition.next_slot,
                    paused: false,
                },
            },
        )
        .await
        .unwrap();
    let worker = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick(next_due).await.unwrap() }
    });
    let (mut wire, request) = timeout(Duration::from_secs(10), read_request(&listener))
        .await
        .unwrap();
    let sent = request["messages"].to_string();
    assert!(sent.contains("Keeper skill version two."));
    assert!(!sent.contains("Keeper skill version one."));
    assert!(!sent.contains("Recorded the planned observation."));
    send_ollama(
        &mut wire,
        json!({"role":"assistant","content":"Updated schedule completed."}),
        "stop",
    )
    .await;
    drop(wire);
    let summary = worker.await.unwrap();
    assert_eq!((summary.claimed, summary.succeeded), (1, 1), "{summary:?}");
    let next_log = log_branch(fixture, &scope, &log, ThreadEntrySeq::ZERO).await;
    assert!(next_log.thread.head > first_leaf);
    assert_eq!(
        log_branch(fixture, &scope, &log, next_log.thread.head)
            .await
            .entries
            .len(),
        15
    );
    clock.0.store(original_clock, Ordering::SeqCst);
}

async fn log_branch(
    fixture: &RuntimeFixture,
    scope: &SpaceContext,
    log: &ChatThreadId,
    leaf: ThreadEntrySeq,
) -> ChatBranch {
    fixture
        .canonical
        .read_chat(
            scope.clone(),
            ChatRead {
                thread: log.clone(),
                leaf,
                before: None,
                max_entries: PageLimit::new(24).unwrap(),
            },
        )
        .await
        .unwrap()
}

async fn get_note(fixture: &RuntimeFixture, scope: &SpaceContext, note: NoteId) -> NoteSnapshot {
    fixture
        .canonical
        .get_note(
            scope.clone(),
            GetNote {
                note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap()
}

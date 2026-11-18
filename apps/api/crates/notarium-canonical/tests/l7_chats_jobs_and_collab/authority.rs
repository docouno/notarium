use super::*;

pub(super) async fn check(store: &CanonicalStore) {
    let owner = sample_principal_id(224);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(224),
            incarnation: sample_incarnation(224),
            root_folder_id: sample_folder_id(224),
            slug: "export-and-consume-authority".into(),
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let admitted = owner_ctx(&scope, owner.clone());
    let note = sample_note_id(225);
    store
        .create_note(
            admitted.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "export-source".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Export document\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let hidden_export = || {
        next_mutation(
            &scope,
            &owner,
            ContentJobKind::Export {
                notes: vec![note.clone()],
                encrypted: false,
            },
        )
    };
    let hidden = store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap()
        .value;
    let claimed = store
        .claim_next_job(
            &make_budget(),
            &scope,
            "export-worker",
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job.id, hidden.id);
    let artifact = ArtifactId::from_bytes([224; 16]);
    store
        .complete_job(
            &make_budget(),
            &scope,
            &hidden.id,
            "export-worker",
            claimed.job.lease,
            JobCompletionOutcome::Succeeded {
                completed_units: 1,
                total_units: Some(1),
                artifacts: vec![artifact.clone()],
                result_msgpack: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_job(admitted.clone(), hidden.id.clone())
            .await
            .unwrap()
            .artifacts,
        vec![artifact]
    );
    let visible_old = store
        .create_job(
            admitted.clone(),
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await
        .unwrap()
        .value
        .id;
    store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap();
    let visible_new = store
        .create_job(
            admitted.clone(),
            next_mutation(&scope, &owner, ContentJobKind::Reindex),
        )
        .await
        .unwrap()
        .value
        .id;
    store
        .create_job(admitted.clone(), hidden_export())
        .await
        .unwrap();

    let mut grants = admitted.auth().spaces().clone();
    let grant = grants.get_mut(&scope.space_id).unwrap();
    grant.read_classes = [DocClass::AgentMemory].into_iter().collect();
    grant.write_classes.clear();
    grant.role = SpaceRole::Viewer;
    let restricted = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner.clone(),
            GrantId::from_bytes([225; 16]),
            grants,
            false,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    assert!(matches!(
        store.get_job(restricted.clone(), hidden.id).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let page = store
        .list_jobs(
            restricted.clone(),
            ReadRequest::Open {
                query: JobQuery {
                    states: vec![],
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, visible_new);
    let cursor = page.next.unwrap();
    assert_eq!(cursor.last.entity_id, visible_new);
    let page = store
        .list_jobs(restricted, ReadRequest::Continue { cursor })
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, visible_old);
    assert!(page.next.is_none());

    let thread = sample_thread_id(226);
    store
        .create_chat(
            admitted.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::SpaceGroup,
                    owner: owner.clone(),
                    title: "Consume authority".into(),
                    project_folder: None,
                },
            ),
        )
        .await
        .unwrap();
    let message = |text: &str| {
        next_mutation(
            &scope,
            &owner,
            AppendChat {
                thread: thread.clone(),
                parent: ThreadEntrySeq::ZERO,
                kind: ChatEntryKind::Human,
                body: ChatInputBody::Text(text.into()),
                referenced_notes: vec![],
                tainted: false,
            },
        )
    };
    let a = store
        .append_chat(admitted.clone(), message("A"))
        .await
        .unwrap()
        .value
        .seq;
    let b = store
        .append_chat(admitted.clone(), message("B"))
        .await
        .unwrap()
        .value
        .seq;
    let pending = PendingInputId::from_bytes([226; 16]);
    let run = sample_run_id(226);
    store
        .queue_chat_input(
            admitted.clone(),
            next_mutation(
                &scope,
                &owner,
                PendingChatInput {
                    id: pending.clone(),
                    thread: thread.clone(),
                    sender: owner.clone(),
                    body: "pending".into(),
                    queued_base_leaf: a,
                    in_flight_run: run.clone(),
                    mentions_agent: false,
                },
            ),
        )
        .await
        .unwrap();
    let consume = |leaf| {
        next_mutation(
            &scope,
            &owner,
            ConsumePending {
                thread: thread.clone(),
                input: pending.clone(),
                expected_run: run.clone(),
                current_leaf: leaf,
            },
        )
    };
    let tainted = owner_ctx(&scope, owner.clone());
    tainted.auth().taint().mark_external_read();
    for (leaf, already_consumed) in [(b, false), (a, true)] {
        if already_consumed {
            assert!(matches!(
                store
                    .consume_chat_input(admitted.clone(), consume(a))
                    .await
                    .unwrap()
                    .value,
                ConsumedPending::Appended(_)
            ));
        }
        let request = consume(leaf);
        let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
        assert!(matches!(
            store
                .consume_chat_input(tainted.clone(), request.clone())
                .await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            before
        );
        let clean = store
            .consume_chat_input(admitted.clone(), request.clone())
            .await
            .unwrap();
        assert!(matches!(
            (already_consumed, clean.value),
            (true, ConsumedPending::AlreadyConsumed)
                | (false, ConsumedPending::BranchChanged { .. })
        ));
        assert_eq!(
            store
                .consume_chat_input(admitted.clone(), request.clone())
                .await
                .unwrap()
                .receipt,
            clean.receipt
        );
        assert!(matches!(
            store.consume_chat_input(tainted.clone(), request).await,
            Err(PortError::Domain(DomainError::CrossSpaceTainted))
        ));
    }
}

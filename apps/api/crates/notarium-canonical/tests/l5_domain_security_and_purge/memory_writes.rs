use super::*;
use notarium_core::ports::{AccountContext, ControlCatalogPort, MemoryAppendOutcome};

pub(super) async fn check(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    project: FolderId,
) {
    let ctx = owner_ctx(scope, owner.clone(), false, false);
    let account = AccountContext::new(ctx.auth().clone(), make_budget());
    let target = MemoryTarget::Project {
        folder: FolderRef {
            space_id: scope.space_id.clone(),
            folder_id: project,
        },
    };
    let initial = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let snapshot = store
        .inspect_memory_target(account.clone(), target.clone(), "maintenance".into())
        .await
        .unwrap();
    assert!(snapshot.revision.is_none());
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        initial
    );

    let write = |text: &str, summary: Option<&str>, mode| {
        next_mutation(
            scope,
            owner,
            AppendMemory {
                target: snapshot.resolved.clone(),
                text: text.to_owned(),
                summary: summary.map(str::to_owned),
                mode,
            },
        )
    };
    let invalid = store
        .append_memory(
            ctx.clone(),
            write(
                " ",
                Some("Should never appear"),
                MemoryWriteMode::CreateIfMissing,
            ),
        )
        .await;
    assert_validation_err(&invalid, ValidationReason::InvalidState);
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        initial
    );

    let create = write(
        "First durable fact.",
        Some("Current summary"),
        MemoryWriteMode::CreateIfMissing,
    );
    let first = store
        .append_memory(ctx.clone(), create.clone())
        .await
        .unwrap();
    assert_eq!(first.value.outcome, MemoryAppendOutcome::Created);
    assert!(first.value.summary_updated);
    assert_eq!(first.receipt.seq(), initial.checked_next().unwrap());
    let changed = Mutation {
        input: AppendMemory {
            summary: Some("Different request".into()),
            ..create.input.clone()
        },
        ..create
    };
    assert_eq!(
        store.append_memory(ctx.clone(), changed).await.unwrap_err(),
        PortError::Domain(DomainError::IdempotencyKeyReused),
    );
    assert!(matches!(
        store.append_memory(
            ctx.clone(), write("Stale proposal.", None, MemoryWriteMode::RequireAbsent),
        ).await,
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. }))
            if current == first.value.revision.revision,
    ));

    let revise = next_mutation_rev(
        scope,
        owner,
        first.value.revision.revision,
        write(
            "Second durable fact.",
            None,
            MemoryWriteMode::RequireExisting,
        )
        .input,
    );
    let (a, b) = tokio::join!(
        store.append_memory(ctx.clone(), revise.clone()),
        store.append_memory(ctx.clone(), revise),
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.value.revision, b.value.revision);
    assert_eq!(a.receipt, b.receipt);
    assert!(matches!(
        (a.value.outcome, b.value.outcome),
        (MemoryAppendOutcome::Appended, MemoryAppendOutcome::Skipped)
            | (MemoryAppendOutcome::Skipped, MemoryAppendOutcome::Appended)
    ));
    assert!(!a.value.summary_updated);
    let note_id = snapshot.resolved.note.note_id.clone();
    let snapshot = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: note_id,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    let carrier = snapshot.document.explicit_read(ctx.auth()).unwrap();
    let header = notarium_syntax::frontmatter::analyze(carrier, DocClass::AgentMemory).unwrap();
    assert_eq!(
        header.fields.unwrap().get("summary"),
        Some(&YamlValue::String("Current summary".into())),
    );
    assert_eq!(carrier.matches("First durable fact.").count(), 1);
    assert_eq!(carrier.matches("Second durable fact.").count(), 1);
    assert!(!carrier.contains("Stale proposal."));

    Box::pin(rollback_new_category(
        store,
        &ctx,
        &account,
        target.clone(),
        owner,
    ))
    .await;

    let parallel = store
        .inspect_memory_target(account, target, "parallel".into())
        .await
        .unwrap();
    let append = |text: &str| {
        store.append_memory(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                AppendMemory {
                    target: parallel.resolved.clone(),
                    text: text.to_owned(),
                    summary: None,
                    mode: MemoryWriteMode::CreateIfMissing,
                },
            ),
        )
    };
    let (first, second) = tokio::join!(append("Unique first."), append("Unique second."));
    let outcomes = (first.unwrap().value.outcome, second.unwrap().value.outcome);
    assert!(matches!(
        outcomes,
        (MemoryAppendOutcome::Created, MemoryAppendOutcome::Appended)
            | (MemoryAppendOutcome::Appended, MemoryAppendOutcome::Created)
    ));
    let snap = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: parallel.resolved.note.note_id,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    let content = snap.document.explicit_read(ctx.auth()).unwrap();
    assert_eq!(content.matches("Unique first.").count(), 1);
    assert_eq!(content.matches("Unique second.").count(), 1);
}

async fn rollback_new_category(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    account: &AccountContext,
    target: MemoryTarget,
    owner: &PrincipalId,
) {
    let category = "rollback-new";
    let slot = || store.inspect_memory_target(account.clone(), target.clone(), category.into());
    let original = slot().await.unwrap();
    let write = |text: &str, summary: Option<&str>| {
        next_mutation(
            ctx.scope(),
            owner,
            AppendMemory {
                target: original.resolved.clone(),
                text: text.into(),
                summary: summary.map(str::to_owned),
                mode: MemoryWriteMode::CreateIfMissing,
            },
        )
    };
    // Rolling back the second run restores the first tombstone. A subsequent
    // observation must still start from an empty carrier at the same stable ID.
    for n in [237, 238] {
        let run = sample_run_id(n);
        let auth = ctx
            .auth()
            .for_agent_run(
                run.clone(),
                ctx.scope().space_id.clone(),
                ChatAudience::Personal,
                ctx.auth().spaces().clone(),
            )
            .unwrap();
        let agent = SpaceContext::new(auth, ctx.scope().clone(), make_budget()).unwrap();
        let created = store
            .append_memory(agent, write("Undone observation.", Some("Undone summary")))
            .await
            .unwrap();
        assert_eq!(created.value.outcome, MemoryAppendOutcome::Created);
        let undone = store
            .rollback_agent_run_by_id(ctx.clone(), next_mutation(ctx.scope(), owner, run))
            .await
            .unwrap();
        assert_eq!(undone.value.trashed.len() + undone.value.restored.len(), 1);
        assert!(slot().await.unwrap().revision.is_none());
    }
    let new = write("New observation.", None);
    let created = store.append_memory(ctx.clone(), new.clone()).await.unwrap();
    assert_eq!(created.value.outcome, MemoryAppendOutcome::Created);
    let replayed = store.append_memory(ctx.clone(), new).await.unwrap();
    assert_eq!(replayed.receipt, created.receipt);
    let note = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: original.resolved.note.note_id.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    let carrier = note.document.explicit_read(ctx.auth()).unwrap();
    assert_eq!(carrier.matches("New observation.").count(), 1);
    assert!(!carrier.contains("Undone"));

    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                ctx.scope(),
                owner,
                DeleteNote {
                    note: original.resolved.note.note_id.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        slot().await.unwrap_err(),
        PortError::Domain(DomainError::ResourceNotFound)
    );
    assert_eq!(
        store
            .append_memory(ctx.clone(), write("Do not revive.", None))
            .await
            .unwrap_err(),
        PortError::Domain(DomainError::ResourceNotFound)
    );
}

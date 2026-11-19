use super::*;

pub(super) async fn check(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    scope: &HistoryScope,
    owner: &PrincipalId,
    postgres: bool,
) {
    use notarium_canonical::{CloseCollabSession, OpenCollabSession};
    use notarium_core::error::RetryAdvice;

    let note = sample_note_id(0xd8);
    let other = sample_note_id(0xd9);
    let base = "Initial text.\n";
    let create = |note: &NoteId, slug: &str, carrier: &str| {
        next_mutation(
            scope,
            owner,
            BatchItem::Create(CreateNote {
                note: note.clone(),
                slug: slug.into(),
                parent: None,
                class: DocClass::UserDoc,
                carrier: carrier.into(),
            }),
        )
    };
    let edit = |note: &NoteId, carrier: &str, tag: &str| {
        next_mutation(
            scope,
            owner,
            BatchItem::Edit(EditNote {
                note: note.clone(),
                plan: extract::finalize_document(
                    carrier,
                    DocClass::UserDoc,
                    note,
                    &[FieldEdit::Set {
                        key: "tag".into(),
                        value: YamlValue::String(tag.into()),
                    }],
                )
                .unwrap(),
            }),
        )
    };
    let first = create(&note, "batch-source-a", base);
    let mut reused = create(&note, "batch-source-b", "Rejected bytes.");
    reused.identity = first.identity.clone();
    let mixed = AcceptBatch {
        items: vec![first, reused, edit(&note, base, "accepted")],
    };
    let stalled = |request| {
        let mut short = ctx.clone();
        short.budget.remaining = std::time::Duration::from_millis(300);
        async move {
            let hold = store.acquire_writer_safe_point().await.unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                store.accept_batch(short, request),
            )
            .await;
            drop(hold);
            result
                .expect("stalled batch exceeded caller budget")
                .unwrap_err()
        }
    };
    let error = stalled(mixed.clone()).await;
    if postgres {
        // Fresh S3 publications need a write transaction before mailbox admission.
        assert!(
            matches!(error, PortError::DeadlineExceeded(ref f) if f.effect()==CommitEffect::NotCommitted),
            "{error:?}"
        );
    } else {
        assert!(
            matches!(error, PortError::Unavailable(ref f) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
            "{error:?}"
        );
    }
    let replay = AcceptBatch {
        items: vec![mixed.items[0].clone()],
    };
    let initial = store.accept_batch(ctx.clone(), mixed).await.unwrap();
    // Replaying a persisted receipt needs no blob staging on either backend.
    let error = stalled(replay.clone()).await;
    assert!(
        matches!(error, PortError::Unavailable(ref f) if f.effect()==CommitEffect::Unknown && f.retry()==RetryAdvice::RetrySameCommand),
        "{error:?}"
    );
    let acknowledged = store.accept_batch(ctx.clone(), replay).await.unwrap();
    assert_eq!(
        acknowledged.items[0].as_ref().unwrap().receipt.seq(),
        initial.items[0].as_ref().unwrap().receipt.seq()
    );
    assert!(initial.items[0].is_ok());
    assert!(matches!(
        initial.items[1],
        Err(DomainError::IdempotencyKeyReused)
    ));
    let initial_edit = initial.items[2].as_ref().unwrap();
    let read = |note: &NoteId| GetNote {
        note: note.clone(),
        revision: None,
        causal: CausalBasis::Exact(ReceiptSet::default()),
    };
    let initial_doc = store
        .get_note(ctx.clone(), read(&note))
        .await
        .unwrap()
        .document;
    let initial_carrier = initial_doc.explicit_read(ctx.auth()).unwrap();
    let mut stale_edit = edit(&note, initial_carrier, "rejected");
    let stale = initial.items[0].as_ref().unwrap().value.revision.clone();
    stale_edit.preconditions.revision = Some(stale.clone());
    let stale_trash = next_mutation_rev(
        scope,
        owner,
        stale.clone(),
        BatchItem::Delete(DeleteNote {
            note: note.clone(),
            disposition: DeleteDisposition::Trash,
        }),
    );
    let second = store
        .accept_batch(
            ctx.clone(),
            AcceptBatch {
                items: vec![
                    stale_edit,
                    stale_trash,
                    edit(&note, initial_carrier, "second"),
                ],
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        second.items[0],
        Err(DomainError::RevisionConflict { .. })
    ));
    assert!(matches!(
        second.items[1],
        Err(DomainError::RevisionConflict { .. })
    ));
    let current = second.items[2].as_ref().unwrap();
    assert!(current.receipt.seq() > initial_edit.receipt.seq());
    let snapshot = store
        .get_note(ctx.clone(), read(&note))
        .await
        .unwrap()
        .document;
    let carrier = snapshot.explicit_read(ctx.auth()).unwrap();
    assert!(carrier.contains("second"));
    let room = store
        .open_collab_session(
            &ctx.budget,
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "batch-room".into(),
                expected_carrier_rev: current.value.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(room.room_state, notarium_canonical::CollabRoomState::Active);
    assert!(!room.carrier_dirty);
    let assert_effect = |error: PortError, effect: CommitEffect| {
        let PortError::Unavailable(failure) = error else {
            panic!("expected room contention, got {error:?}");
        };
        assert_eq!(failure.effect(), effect);
        if effect == CommitEffect::Unknown {
            assert_eq!(failure.retry(), RetryAdvice::RetrySameCommand);
        }
    };
    let blocked = edit(&note, carrier, "after-close");
    assert_effect(
        store
            .accept_batch(
                ctx.clone(),
                AcceptBatch {
                    items: vec![blocked.clone()],
                },
            )
            .await
            .unwrap_err(),
        CommitEffect::NotCommitted,
    );
    let mixed = AcceptBatch {
        items: vec![blocked, create(&other, "batch-independent", base)],
    };
    assert_effect(
        store
            .accept_batch(ctx.clone(), mixed.clone())
            .await
            .unwrap_err(),
        CommitEffect::Unknown,
    );
    let other_before = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    let link = |source: &NoteId, target| {
        next_mutation(
            scope,
            owner,
            Link {
                source: source.clone(),
                target,
                relation: "related".into(),
            },
        )
    };
    let link_batch = LinkBatch {
        items: vec![
            link(&other, LinkTarget::Note(note.clone())),
            link(&note, LinkTarget::Note(other.clone())),
        ],
    };
    if postgres {
        let mut short = ctx.clone();
        short.budget.remaining = std::time::Duration::from_millis(300);
        let hold = store.acquire_writer_safe_point().await.unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            store.link_many(short, link_batch.clone()),
        )
        .await;
        drop(hold);
        let error = result
            .expect("link staging exceeded caller budget")
            .unwrap_err();
        assert!(
            matches!(error, PortError::DeadlineExceeded(ref f) if f.effect() == CommitEffect::NotCommitted),
            "{error:?}"
        );
    }
    assert_effect(
        store
            .link_many(ctx.clone(), link_batch.clone())
            .await
            .unwrap_err(),
        CommitEffect::Unknown,
    );
    let other_linked = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert_ne!(
        other_before.metadata().revision(),
        other_linked.metadata().revision()
    );
    let closed = store
        .close_collab_session(
            &ctx.budget,
            CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: note.clone(),
                owner_id: Some("batch-room".into()),
                expected_lease: room.lease_epoch,
                expected_lineage: room.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();

    assert_eq!(
        closed.room_state,
        notarium_canonical::CollabRoomState::Closed
    );
    assert!(!closed.carrier_dirty);
    assert_eq!(closed.carrier_rev_id, current.value.revision);

    let accepted = store.accept_batch(ctx.clone(), mixed).await.unwrap();
    assert!(accepted.items[0].is_ok());
    assert_eq!(
        &accepted.items[1].as_ref().unwrap().value.revision,
        other_before.metadata().revision()
    );
    // Existing link-batch receipts included the old base digest. The retry must
    // recover it from the original revision after this source already advanced.
    let identity = &link_batch.items[0].identity;
    let legacy = format!(
        "src={}\0base={}\0line=- related: [[{}]]\n",
        other.as_str(),
        other_before.digest().to_hex(),
        note.as_str()
    );
    let mut hash = blake3::Hasher::new();
    hash.update(b"notarium-cmd-v1:link\0");
    hash.update(identity.hash.as_bytes());
    hash.update(&[0]);
    hash.update(legacy.as_bytes());
    let hash = hash.finalize().to_hex();
    let literal = if postgres {
        format!("decode('{hash}', 'hex')")
    } else {
        format!("X'{hash}'")
    };
    let count = store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND idempotency_key='{}'",
        scope.space_id.as_str(), identity.key.as_str())).await.unwrap();
    assert_eq!(count, 1);
    let linked = store
        .link_many(ctx.clone(), link_batch.clone())
        .await
        .unwrap();
    assert!(linked.items.iter().all(Result::is_ok));
    let repeated = store
        .link_many(ctx.clone(), link_batch.clone())
        .await
        .unwrap();
    assert_eq!(
        linked.committed_high_watermark,
        repeated.committed_high_watermark
    );
    assert_eq!(
        linked.items[0].as_ref().unwrap().receipt,
        repeated.items[0].as_ref().unwrap().receipt
    );
    let after = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert_eq!(
        after.metadata().revision(),
        other_linked.metadata().revision()
    );

    // Batch-era receipts replay through the single endpoint after the head advances.
    let legacy_single = store
        .link(ctx.clone(), link_batch.items[0].clone())
        .await
        .unwrap();
    assert_eq!(
        legacy_single.receipt,
        linked.items[0].as_ref().unwrap().receipt
    );

    let req = link(&other, LinkTarget::Note(note.clone()));
    let single = store.link(ctx.clone(), req.clone()).await.unwrap();
    let once = |item| LinkBatch { items: vec![item] };
    let batch_replay = store
        .link_many(ctx.clone(), once(req.clone()))
        .await
        .unwrap();
    assert_eq!(
        batch_replay.items[0].as_ref().unwrap().receipt,
        single.receipt
    );
    let boundary = batch_replay.committed_high_watermark;

    let untouched = link_batch.items[1].clone();
    let from_batch = store.link(ctx.clone(), untouched).await.unwrap();
    assert_eq!(
        from_batch.receipt,
        linked.items[1].as_ref().unwrap().receipt
    );

    let mut collision = req.clone();
    collision.input.target = LinkTarget::AuthoredName(note.as_str().into());
    for old_single in [false, true] {
        if old_single {
            // Same textual target but an untyped single-link fingerprint from the old writer.
            let mut hash = blake3::Hasher::new();
            hash.update(b"notarium-cmd-v1:link\0");
            hash.update(req.identity.hash.as_bytes());
            hash.update(&[0]);
            hash.update(
                format!(
                    "src={}\0line=- related: [[{}]]\n",
                    other.as_str(),
                    note.as_str()
                )
                .as_bytes(),
            );
            let hex = hash.finalize().to_hex();
            let literal = if postgres {
                format!("decode('{hex}', 'hex')")
            } else {
                format!("X'{hex}'")
            };
            assert_eq!(store.execute_diagnostic_write_sql_for_test(&format!(
                "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND idempotency_key='{}'",
                scope.space_id.as_str(),req.identity.key.as_str())).await.unwrap(),1);
        }
        assert!(matches!(
            store.link(ctx.clone(), collision.clone()).await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
        let refused = store
            .link_many(ctx.clone(), once(collision.clone()))
            .await
            .unwrap();
        assert!(matches!(
            refused.items[0],
            Err(DomainError::IdempotencyKeyReused)
        ));
        let accepted = store
            .link_many(ctx.clone(), once(req.clone()))
            .await
            .unwrap();
        assert_eq!(accepted.items[0].as_ref().unwrap().receipt, single.receipt);
        assert_eq!(
            store.link(ctx.clone(), req.clone()).await.unwrap().receipt,
            single.receipt
        );
        assert_eq!(accepted.committed_high_watermark, boundary);
    }

    let chained = LinkBatch {
        items: vec![
            link(&other, LinkTarget::Note(sample_note_id(0xda))),
            link(&other, LinkTarget::AuthoredName("last-target".into())),
        ],
    };
    let result = store.link_many(ctx.clone(), chained).await.unwrap();
    assert!(matches!(
        result.items[0],
        Err(DomainError::ResourceNotFound)
    ));
    assert!(result.items[1].is_ok());
    let doc = store
        .get_note(ctx.clone(), read(&other))
        .await
        .unwrap()
        .document;
    assert!(
        doc.explicit_read(ctx.auth())
            .unwrap()
            .contains("[[last-target]]")
    );

    check_metadata_retries(store, ctx, scope, owner, &other, postgres).await;
}

async fn check_metadata_retries(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    scope: &HistoryScope,
    owner: &PrincipalId,
    note: &NoteId,
    postgres: bool,
) {
    let metadata = |slug: &str| MoveNote {
        note: note.clone(),
        parent: None,
        slug: slug.into(),
    };
    let base = store
        .move_note(
            ctx.clone(),
            next_mutation(scope, owner, metadata("before-qualified-move")),
        )
        .await
        .unwrap();
    let request = next_mutation_rev(
        scope,
        owner,
        base.value.revision.clone(),
        metadata("qualified-move"),
    );
    let moved = store.move_note(ctx.clone(), request.clone()).await.unwrap();
    let batch = |item: &Mutation<MoveNote>| AcceptBatch {
        items: vec![Mutation {
            identity: item.identity.clone(),
            preconditions: item.preconditions.clone(),
            input: BatchItem::Move(item.input.clone()),
        }],
    };

    let mut no_title = next_mutation(
        scope,
        owner,
        RenameNote {
            note: note.clone(),
            slug: "literal-title".into(),
            title: None,
        },
    );
    no_title.preconditions.revision = Some(moved.value.revision.clone());
    let mut literal = no_title.clone();
    literal.input.title = Some("<none>".into());
    let first_rename = store
        .rename_note(ctx.clone(), no_title.clone())
        .await
        .unwrap();
    assert!(matches!(
        store.rename_note(ctx.clone(), literal.clone()).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    let old_rename = format!("note={}\0slug=literal-title\0title=<none>", note.as_str());
    install_legacy_hash(
        store,
        scope,
        "rename_note",
        &no_title.identity,
        &old_rename,
        postgres,
    )
    .await;
    assert_eq!(
        store
            .rename_note(ctx.clone(), no_title.clone())
            .await
            .unwrap()
            .receipt,
        first_rename.receipt
    );
    assert!(matches!(
        store.rename_note(ctx.clone(), literal.clone()).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));

    literal.identity = next_mutation(scope, owner, ()).identity;
    literal.preconditions.revision = Some(first_rename.value.revision);
    let titled = store
        .rename_note(ctx.clone(), literal.clone())
        .await
        .unwrap();
    let mut opposite = literal.clone();
    opposite.input.title = None;
    for old in [false, true] {
        if old {
            install_legacy_hash(
                store,
                scope,
                "rename_note",
                &literal.identity,
                &old_rename,
                postgres,
            )
            .await;
        }
        assert_eq!(
            store
                .rename_note(ctx.clone(), literal.clone())
                .await
                .unwrap()
                .receipt,
            titled.receipt
        );
        assert!(matches!(
            store.rename_note(ctx.clone(), opposite.clone()).await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
    }

    let mut different = request.clone();
    different.preconditions.revision = Some(titled.value.revision);
    for old in [false, true] {
        if old {
            let fp = format!("note={}\0parent=<root>\0slug=qualified-move", note.as_str());
            install_legacy_hash(store, scope, "move_note", &request.identity, &fp, postgres).await;
        }
        assert!(matches!(
            store.move_note(ctx.clone(), different.clone()).await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
        let rejected = store
            .accept_batch(ctx.clone(), batch(&different))
            .await
            .unwrap();
        assert!(matches!(
            rejected.items[0],
            Err(DomainError::IdempotencyKeyReused)
        ));
        let mut epoch = request.clone();
        epoch.preconditions.lineage = Some(notarium_core::ids::LineageEpoch::MAX);
        assert!(matches!(
            store.move_note(ctx.clone(), epoch).await,
            Err(PortError::Domain(DomainError::IdempotencyKeyReused))
        ));
        let confirmed = store
            .accept_batch(ctx.clone(), batch(&request))
            .await
            .unwrap();
        assert_eq!(confirmed.items[0].as_ref().unwrap().receipt, moved.receipt);
        assert_eq!(
            store
                .move_note(ctx.clone(), request.clone())
                .await
                .unwrap()
                .receipt,
            moved.receipt
        );
        assert_eq!(confirmed.committed_high_watermark, titled.receipt.seq());
    }
}

async fn install_legacy_hash(
    store: &CanonicalStore,
    scope: &HistoryScope,
    kind: &str,
    identity: &CommandIdentity,
    payload: &str,
    postgres: bool,
) {
    let mut hash = blake3::Hasher::new();
    hash.update(b"notarium-cmd-v1:");
    hash.update(kind.as_bytes());
    hash.update(&[0]);
    hash.update(identity.hash.as_bytes());
    hash.update(&[0]);
    hash.update(payload.as_bytes());
    let hex = hash.finalize().to_hex();
    let literal = if postgres {
        format!("decode('{hex}','hex')")
    } else {
        format!("X'{hex}'")
    };
    assert_eq!(store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND actor_id='{}' AND idempotency_key='{}'",
        scope.space_id.as_str(), identity.actor.as_str(), identity.key.as_str()
    )).await.unwrap(),1);
}
